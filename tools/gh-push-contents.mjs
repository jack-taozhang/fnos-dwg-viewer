#!/usr/bin/env node
/**
 * 用 **Contents API 逐文件写入**把本地 HEAD 推到远端 —— 不碰 Git Data API 的 tree。
 *
 * ★★ 为什么放弃整树推送 ★★
 *   Git Data API 那条路（POST /git/blobs → /git/trees → /git/commits）在本机实测
 *   连续踩了四个坑，且**每一个都静默失败**（API 全程 2xx、日志一路绿灯）：
 *     ① 空仓库 POST /git/trees 直接回 409 "Git Repository is empty."
 *     ② `git hash-object -w` 只写本地 .git/objects，服务端不存在该 blob
 *        ⇒ 422 "tree.sha … is not a valid blob"（而本地 cat-file 明明是 blob）
 *     ③ `git cat-file blob <不存在的 sha>` 把 fatal 写 stderr 却**返回退出码 0**
 *        ⇒ 拿到空 Buffer；GitHub 对空内容返回**同一个固定 sha**
 *        ⇒ 各仓同名空文件全指向同一对象，远端整片错乱
 *     ④ 最隐蔽的一个：helper 返回值里漏带 dir ⇒ spawn 的 cwd 变 undefined
 *        ⇒ 退回进程 cwd ⇒ 在**别的仓**上跑 ls-tree ⇒ 推出去全是那个仓的内容
 *   修完 ①②③④ 之后，GitHub 算出的 tree sha 仍与本地 git 算的不一致
 *   （条目数、mode、blob sha 全对），最后这层已无法从客户端解释。
 *   ⇒ 换路。
 *
 *   ★ 本脚本是**单仓**脚本（只管本仓），刻意不做成"一个脚本推五个仓" ★
 *     坑 ④ 的根因就是多仓共用一个 helper。让每仓各自持有一份、
 *     路径写死在各自的 tools/ 下，就从结构上排除了"cwd 跑错仓"这类问题。
 *
 * ★ 这条路的取舍 ★
 *   · 慢（每文件一次 PUT，本仓 282 个文件约 3～5 分钟）
 *   · 但**结果可预期**：每个文件一次 PUT，回执里带该文件最终的 blob sha，
 *     推完逐个 sha 比对即可，不依赖任何"服务端内部怎么算 sha"的假设。
 *   · 历史压成 N 个提交（每个文件一个）。可接受，但要清楚代价。
 *
 * 用法：
 *   node tools/gh-push-contents.mjs              # 推到 GITHUB_REPO（默认 fnos-dwg-viewer）
 *   GITHUB_REPO=xxx node tools/gh-push-contents.mjs
 * 环境变量：GITHUB_TOKEN / GH_TOKEN，或仓库根下的 .gh-token（已 gitignore）
 */
import { spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..")
const REPO_NAME = (process.env.GITHUB_REPO || "fnos-dwg-viewer").trim()
const BRANCH = "main"
const API = "https://api.github.com"

function readToken() {
  const e = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  if (e?.trim()) return e.trim()
  const p = resolve(REPO_ROOT, ".gh-token")
  if (existsSync(p)) {
    const v = readFileSync(p, "utf8").trim()
    if (v) return v
  }
  return null
}

/**
 * 异步跑 git。
 * ★ 必须同时回传 stderr 与内容长度 ★
 *   `git cat-file blob <不存在的 sha>` 会把 fatal 写 stderr 却返回退出码 0
 *   （坑 ③）。只看 code 会把空 Buffer 当成有效内容推上去。
 */
function run(args) {
  return new Promise((r) => {
    let ch
    try {
      ch = spawn("git", args, { stdio: ["ignore", "pipe", "pipe"], cwd: REPO_ROOT })
    } catch (e) {
      r({ code: -1, out: Buffer.alloc(0), err: String(e) })
      return
    }
    const o = []
    let err = ""
    ch.stdout?.on("data", (d) => o.push(Buffer.from(d)))
    ch.stderr?.on("data", (d) => { err += d })
    ch.on("error", (e) => r({ code: -1, out: Buffer.concat(o), err: String(e) }))
    ch.on("close", (code) => r({ code: code ?? -1, out: Buffer.concat(o), err }))
  })
}

async function api(token, method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: "Bearer " + token,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "fnos-dwg-viewer-publish",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* 非 JSON */ }
  return { status: res.status, json, text }
}

async function main() {
  const token = readToken()
  if (!token) { console.log("❌ 没有 token（GITHUB_TOKEN / GH_TOKEN / .gh-token）"); process.exit(1) }
  const me = await api(token, "GET", "/user")
  if (me.status !== 200) { console.log("❌ token 无效: " + me.status); process.exit(1) }
  const owner = me.json.login
  console.log(`✅ 以 ${owner} 身份推送到 ${REPO_NAME}（Contents API 逐文件写入）`)

  const ls = await run(["ls-tree", "-r", "-z", "HEAD"])
  if (ls.code !== 0 || ls.err.length) {
    console.log("❌ ls-tree 失败: " + (ls.err.trim() || ls.code)); process.exit(1)
  }
  const files = ls.out.toString("utf8").split("\0").filter(Boolean).map((line) => {
    const tab = line.indexOf("\t")
    const meta = line.slice(0, tab).split(/\s+/)
    return { path: line.slice(tab + 1), sha: meta[2] }
  })
  console.log(`本地 ${files.length} 个文件\n`)

  let done = 0
  for (const f of files) {
    const cat = await run(["cat-file", "blob", f.sha])
    // ★ 坑 ③：退出码 0 不代表读到了内容，stderr 与空内容都要判
    if (cat.code !== 0 || cat.err.length || !cat.out.length) {
      console.log(`❌ 中断：本地读取失败 ${f.path}\n   ${cat.err.trim() || "(空内容)"}`)
      process.exit(1)
    }

    const cur = await api(token, "GET", `/repos/${owner}/${REPO_NAME}/contents/${encodeURI(f.path)}?ref=${BRANCH}`)
    const body = {
      message: `chore: ${f.path}`,
      content: cat.out.toString("base64"),
      branch: BRANCH,
    }
    if (cur.status === 200 && cur.json?.sha) body.sha = cur.json.sha

    const put = await api(token, "PUT", `/repos/${owner}/${REPO_NAME}/contents/${encodeURI(f.path)}`, body)
    if (put.status !== 200 && put.status !== 201) {
      console.log(`❌ 中断：${f.path} → ${put.status} ${put.text.slice(0, 160)}`)
      process.exit(1)
    }
    // 回执 sha 必须等于本地 blob sha（两者都是内容的 SHA-1）
    const got = put.json?.content?.sha
    if (got && got !== f.sha) {
      console.log(`❌ 中断：${f.path} sha 不符 本地${f.sha.slice(0, 8)} 远端${got.slice(0, 8)}`)
      process.exit(1)
    }
    done++
    if (done % 25 === 0) console.log(`  … ${done}/${files.length}`)
  }

  // 删除远端多出来的文件
  const tree = await api(token, "GET", `/repos/${owner}/${REPO_NAME}/git/trees/${BRANCH}?recursive=1`)
  if (tree.status === 200 && tree.json?.tree) {
    const want = new Set(files.map((f) => f.path))
    for (const x of tree.json.tree) {
      if (x.type !== "blob" || want.has(x.path)) continue
      const cur = await api(token, "GET", `/repos/${owner}/${REPO_NAME}/contents/${encodeURI(x.path)}?ref=${BRANCH}`)
      if (cur.status === 200 && cur.json?.sha) {
        const del = await api(token, "DELETE", `/repos/${owner}/${REPO_NAME}/contents/${encodeURI(x.path)}`,
          { message: "chore: 删除本地已不存在的文件", sha: cur.json.sha, branch: BRANCH })
        if (del.status !== 200) { console.log("❌ 多余文件删不掉 " + x.path); process.exit(1) }
        console.log("  🧹 删除多余 " + x.path)
      }
    }
  }

  console.log(`\n✅ 已写入 ${done} 个文件`)
  console.log("⚠️  还没完 —— 必须再跑 tools/gh-verify-remote.mjs 逐字节核对")
  process.exit(0)
}
main()