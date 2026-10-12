#!/usr/bin/env node
/**
 * 核对远端仓库内容与本地是否**逐字节一致**。
 *
 * ★ 为什么必须逐字节核对 ★
 *   本机 `git push` 不可用，靠 API 逐文件 PUT 推送 ——
 *   而这条路有几个**静默出错**的坑（详见 gh-push-contents.mjs 文件头）。
 *   一旦出错，GitHub 一声不吭，仓库看起来完全正常，内容却是错的。
 *   所以发版前必须逐文件比对，不能只看"推送成功"。
 *
 * ★ 判据说明 ★
 *   git blob 的 SHA-1 与 GitHub 的 blob sha 是同一种算法（都算 "blob <len>\0<内容>"），
 *   所以 **sha 相同即内容逐字节一致**，不需要把内容再拉下来比一遍。
 *
 * 用法：
 *   node tools/gh-verify-remote.mjs
 *   GITHUB_REPO=xxx node tools/gh-verify-remote.mjs
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
  const env = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  if (env && env.trim()) return env.trim()
  const p = resolve(REPO_ROOT, ".gh-token")
  if (existsSync(p)) {
    const v = readFileSync(p, "utf8").trim()
    if (v) return v
  }
  return null
}

function run(args) {
  return new Promise((r) => {
    let c
    try {
      c = spawn("git", args, { stdio: ["ignore", "pipe", "pipe"], cwd: REPO_ROOT })
    } catch (e) {
      r({ code: -1, out: Buffer.alloc(0) })
      return
    }
    const o = []
    c.stdout?.on("data", (d) => o.push(Buffer.from(d)))
    c.on("error", () => r({ code: -1, out: Buffer.concat(o) }))
    c.on("close", (code) => r({ code: code ?? -1, out: Buffer.concat(o) }))
  })
}

async function main() {
  const token = readToken()
  if (!token) { console.log("❌ 没有 token（GITHUB_TOKEN / GH_TOKEN / .gh-token）"); process.exit(1) }

  const headers = {
    Authorization: "Bearer " + token,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "fnos-dwg-viewer-verify",
  }
  const meRes = await fetch(API + "/user", { headers })
  const me = await meRes.json()
  if (!me.login) { console.log("❌ token 无效: " + JSON.stringify(me).slice(0, 120)); process.exit(1) }
  const owner = me.login

  const ls = await run(["ls-tree", "-r", "-z", "HEAD"])
  if (ls.code !== 0) { console.log("❌ ls-tree 失败"); process.exit(1) }
  const entries = ls.out.toString("utf8").split("\0").filter(Boolean).map((line) => {
    const tab = line.indexOf("\t")
    const meta = line.slice(0, tab).split(/\s+/)
    return { path: line.slice(tab + 1), sha: meta[2] }
  })
  const localMap = new Map(entries.map((e) => [e.path, e.sha]))

  const res = await fetch(`${API}/repos/${owner}/${REPO_NAME}/git/trees/${BRANCH}?recursive=1`, { headers })
  const tj = await res.json()
  if (!tj.tree) {
    console.log(`❌ 取远端 tree 失败 ${res.status} ${JSON.stringify(tj).slice(0, 160)}`)
    process.exit(1)
  }
  const remoteMap = new Map(
    tj.tree.filter((x) => x.type === "blob").map((x) => [x.path, x.sha])
  )

  const missing = [...localMap.keys()].filter((p) => !remoteMap.has(p))
  const extra = [...remoteMap.keys()].filter((p) => !localMap.has(p))
  const differ = [...localMap.keys()].filter((p) => remoteMap.has(p) && remoteMap.get(p) !== localMap.get(p))

  const okAll = missing.length === 0 && extra.length === 0 && differ.length === 0
  console.log(
    `${okAll ? "✅" : "❌"} ${owner}/${REPO_NAME}@${BRANCH}：本地 ${localMap.size} 个文件 / 远端 ${remoteMap.size} 个`
  )
  if (missing.length) console.log("   远端缺失: " + missing.slice(0, 10).join(", "))
  if (extra.length) console.log("   远端多余: " + extra.slice(0, 10).join(", "))
  if (differ.length) console.log("   内容不一致: " + differ.slice(0, 10).join(", "))

  if (okAll) console.log("\n✅ 全部逐字节一致")
  else console.log("\n❌ 不一致 —— 不要发版，先重新推送")
  process.exit(okAll ? 0 : 1)
}
main()