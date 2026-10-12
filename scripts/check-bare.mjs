/**
 * 裸模式自检（?bare=1）—— 打开一张真图纸，断言工具栏真的不见了。
 *
 * ★ 为什么需要这个脚本 ★
 *   隐藏外壳靠的是**类名**（src/bare.css）。上游 @mlightcad 哪天改了类名，
 *   净化就会**静默失效**：不报错、构建照过、FPK 照装，
 *   只有用户在思源嵌入块里才看到"工具栏全回来了"。
 *   这个脚本把那次肉眼比对变成一条命令，让升级流程里能自动发现回归。
 *
 * 它同时做两件事：
 *   1) **断言**：裸模式打开时，视口四边不该有任何可见的外壳元素；
 *   2) **报告**：枚举真实 DOM 里所有 ml-* 类名，跟 bare.css 的选择器清单
 *      逐个比对，打印"哪些规则打空了""哪些类名是新出现的没被覆盖"。
 *      —— 第 2 条才是给升级者看的诊断信息。
 *
 * 用法（需要先 npm run build，再起服务）：
 *   node scripts/check-bare.mjs "http://127.0.0.1:8124/?bare=1&path=<编码路径>"
 * 环境变量：
 *   CHROME_PATH   指定 chrome.exe
 *   SHOT_NAME     截图文件名（默认 screenshot-bare.png）
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const URL_TO_OPEN = process.argv[2]
const PORT = Number(process.env.CDP_PORT || 9335)
const CALL_TIMEOUT = 60_000

if (!URL_TO_OPEN) {
  console.error('用法：node scripts/check-bare.mjs "<url>"')
  process.exit(1)
}

const CHROME =
  process.env.CHROME_PATH ||
  [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome'
  ].find((p) => fs.existsSync(p))

if (!CHROME) {
  console.error('找不到 Chrome，请用 CHROME_PATH 指定')
  process.exit(1)
}

const profile = path.join(os.tmpdir(), `fnos-dwg-bare-${Date.now()}`)
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--hide-scrollbars',
    '--window-size=1000,700',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    'about:blank'
  ],
  { stdio: 'ignore' }
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function findPageTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {
      /* Chrome 还没起来 */
    }
    await sleep(500)
  }
  throw new Error('连不上 Chrome 调试端口')
}

/** 极简 CDP 客户端（与 smoke-browser.mjs 同款，保持零依赖） */
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const pending = new Map()
    let id = 0
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      const p = pending.get(msg.id)
      if (!p) return
      pending.delete(msg.id)
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result)
    })
    ws.addEventListener('error', (e) => reject(new Error(`WebSocket 错误：${e.message || e.type}`)))
    ws.addEventListener('open', () =>
      resolve({
        send(method, params = {}) {
          const mid = ++id
          return new Promise((res, rej) => {
            pending.set(mid, { resolve: res, reject: rej })
            ws.send(JSON.stringify({ id: mid, method, params }))
            setTimeout(() => {
              if (pending.delete(mid)) rej(new Error(`${method} 超时`))
            }, CALL_TIMEOUT)
          })
        },
        close: () => ws.close()
      })
    )
  })
}

/**
 * 从 src/bare.css 里解析出"按类名隐藏"那份清单。
 *
 * 刻意**解析源文件**而不是在这里复写一份：复写就等于有了两个真相来源，
 * 改了一处忘了另一处，诊断信息就成了假绿。
 */
function readHiddenClassList() {
  const css = fs.readFileSync(path.join(ROOT, 'src', 'bare.css'), 'utf8')
  const set = new Set()
  // 取所有 html[data-fnos-bare] 前缀、且声明了 display:none 的块
  const hideBlocks = css.match(/html\[data-fnos-bare\][^{}]*\{[^}]*\}/g) || []
  for (const b of hideBlocks) {
    if (!/display:\s*none/.test(b)) continue
    for (const m of b.matchAll(/\.([A-Za-z0-9_-]+)/g)) set.add(m[1])
  }
  return [...set]
}

/* ------------------------------------------------------------------ *
 * 画布墨迹检测（零依赖）
 *
 * ★★ 为什么必须有这一条 ★★
 *   本脚本原来的断言只有两条：canvas 存在且可见、视口边缘没有外壳。
 *   这两条在**画布全黑、图纸根本没渲染**的情况下**照样通过** ——
 *   因为画布确实是可见的、外壳确实被藏了。
 *   于是"截出来的图什么都没有"这件事，脚本发现不了，只能靠人眼看，
 *   而人眼很容易把"黑底上一点坐标轴"当成"图纸渲染好了"。
 *   （2026-10-12 就是这么误判的：一张 3.4KB 的全黑截图被当成了"渲染成功"。）
 *
 *   所以这里直接**量像素**：把截图里画布区域解出来，算"非黑像素占比"。
 *   黑底上有线条 ⇒ 占比不会接近 0；全黑 ⇒ ≈0。
 *
 * ★ 为什么自己解 PNG 而不引 pngjs ★
 *   本脚本刻意零依赖（与 smoke-browser.mjs 一致）。Node 自带 zlib，
 *   剩下的只是 PNG 的 5 种行过滤器 —— 四十行的事，不值得换一个依赖。
 * ------------------------------------------------------------------ */
function decodePng(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG')
  let pos = 8
  let width = 0
  let height = 0
  let bitDepth = 8
  let colorType = 6
  const idat = []
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    pos += 12 + len
  }
  if (bitDepth !== 8) throw new Error('只支持 8 位 PNG，实际 ' + bitDepth)
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0
  if (!channels) throw new Error('只支持 RGB/RGBA PNG，实际 colorType=' + colorType)
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = Buffer.alloc(height * stride)
  let rp = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++]
    const row = out.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null
    for (let x = 0; x < stride; x++) {
      const v = raw[rp + x]
      const a = x >= channels ? row[x - channels] : 0
      const b = prev ? prev[x] : 0
      const c = prev && x >= channels ? prev[x - channels] : 0
      let val
      switch (filter) {
        case 0: val = v; break
        case 1: val = v + a; break
        case 2: val = v + b; break
        case 3: val = v + ((a + b) >> 1); break
        case 4: {
          const p = a + b - c
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
          val = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)
          break
        }
        default: throw new Error('未知行过滤器 ' + filter)
      }
      row[x] = val & 0xff
    }
    rp += stride
  }
  return { width, height, channels, data: out }
}

/**
 * 画布区域里"非黑像素"的占比（%）。
 * rect 用 CSS 像素；PNG 可能是设备像素，按宽度比例换算。
 */
function inkPercent(png, rect, cssWidth) {
  const scale = png.width / cssWidth
  const x0 = Math.max(0, Math.round(rect[0] * scale))
  const y0 = Math.max(0, Math.round(rect[1] * scale))
  const x1 = Math.min(png.width, Math.round((rect[0] + rect[2]) * scale))
  const y1 = Math.min(png.height, Math.round((rect[1] + rect[3]) * scale))
  let ink = 0
  let total = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * png.width + x) * png.channels
      const lum = 0.299 * png.data[i] + 0.587 * png.data[i + 1] + 0.114 * png.data[i + 2]
      total++
      if (lum > 12) ink++
    }
  }
  return total ? +((ink / total) * 100).toFixed(3) : -1
}

let bad = 0
const ok = (cond, name, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${extra ? '   ' + extra : ''}`)
  if (!cond) bad++
}
const info = (name, extra = '') => console.log(`    · ${name}${extra ? '   ' + extra : ''}`)

const evaluate = async (cdp, expression) => {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || '页面内脚本报错')
  return r.result.value
}

let exitCode = 0
try {
  const target = await findPageTarget()
  const cdp = await connect(target.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Page.navigate', { url: URL_TO_OPEN })
  await sleep(1500)

  const busyText = /正在渲染|渲染中|正在解析|解析中|正在加载|加载中|正在打开/
  for (let i = 0; i < 60; i++) {
    // ★ 判据要看画布**可见且有尺寸**，不只是存在 ★
    //   见下面 report.canvas 的注释：只查存在会被"藏了但还在"骗过去。
    const ready = await evaluate(
      cdp,
      `(() => {
        const c = document.querySelector('canvas')
        if (!c) return false
        const r = c.getBoundingClientRect()
        if (getComputedStyle(c).display === 'none') return false
        if (r.width < 50 || r.height < 50) return false
        return !${busyText}.test(document.body.innerText)
      })()`
    )
    if (ready) break
    await sleep(1000)
  }
  // 裸模式的几何兜底观察期是 8 秒，等它跑完再判定，
  // 否则会把"兜底还没跑到"误判成"兜底没生效"。
  await sleep(9000)

  const report = await evaluate(
    cdp,
    `(() => {
      const vw = window.innerWidth, vh = window.innerHeight
      const vis = (el) => {
        const cs = getComputedStyle(el)
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false
        const r = el.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const edge = []
      for (const el of document.querySelectorAll('body *')) {
        if (!vis(el)) continue
        const r = el.getBoundingClientRect()
        // 盖住视口八成宽、且贴住上边或下边 —— 外壳的特征
        if (r.width < vw * 0.8) continue
        /*
         * ★ 高度下限 24px（与 bare.ts 的 sweep() 同一条）★
         *   Vue 在 v-if 为 false 时留下的是**注释占位节点** <div><!----></div>，
         *   它们宽 978、高 0，而且 top 恰好是 0 —— 贴边条件成立。
         *   不设高度下限就会把它们当成"外壳"报出来，误报一片。
         *   真实的壳是 123px / 30px / 30px，24px 以下藏不藏都看不见。
         */
        if (r.height < 24) continue
        /*
         * ★ 豁免②（与 bare.ts 的 sweep() 同一条，阈值 0.6）★
         *   外壳是"一条"（实测 123 / 30 / 30 px，视口 602px）；
         *   高度达到视口六成的是**内容区或错误卡片**，不是外壳。
         *   没有这条，查看器那个满屏的无名 div（978×602）会被误报成外壳。
         */
        if (r.height >= vh * 0.6) continue
        const top = r.top <= 2, bottom = vh - r.bottom <= 2
        if (!top && !bottom) continue
        /*
         * ★ 豁免规则必须与 src/bare.ts 的 sweep() 一致 ★
         *   否则会出现"应用是对的、检测器却报失败"或反过来 ——
         *   两处判据各写一份，迟早会漂移。
         *
         * ★ 这里踩过一个坑：判据写成 el.querySelector('canvas') ★
         *   querySelector 只查**后代**，不匹配元素自己 ⇒ 满屏的
         *   <canvas> 元素自己通不过豁免，被当成"贴边的外壳"报出来。
         *   所以必须显式加上 tagName === 'canvas'。
         *
         * 含 canvas 的一律豁免（与 bare.ts 豁免①同源）：画布与它的
         * 祖先链都不是外壳。外壳是"一条"，画布是"满屏"。
         */
        const tag = el.tagName.toLowerCase()
        if (tag === 'canvas' || el.querySelector('canvas')) continue
        edge.push({
          cls: el.className && String(el.className).slice(0, 120),
          tag,
          rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]
        })
      }
      const classes = new Set()
      for (const el of document.querySelectorAll('[class*="ml-"]')) {
        for (const c of String(el.className).split(/\\s+/)) {
          if (c.startsWith('ml-')) classes.add(c)
        }
      }
      return {
        url: location.href,
        // ★ 页面是不是真的加载了 ★
        //   浏览器自己的错误页（ERR_CONNECTION_REFUSED 等）当然也是
        //   "视口边缘没有外壳" —— 不判这一条，脚本会在服务没起来时
        //   **假绿**，那比红着更坏。
        loaded: location.protocol.startsWith('http'),
        bare: document.documentElement.hasAttribute('data-fnos-bare'),
        // ★ 必须查可见性与尺寸，不能只查存在 ★
        //   踩过的坑：几何兜底把画布的祖先容器藏了 ⇒ canvas 元素**仍在**
        //   document 里，但 display:none、宽高都是 0 —— 页面全黑，
        //   而"!!document.querySelector('canvas')"照样返回 true。
        //   这就是最典型的假绿：断言越弱，越容易在坏的时候报好。
        canvas: (() => {
          const c = document.querySelector('canvas')
          if (!c) return { ok: false, why: '没有 canvas 元素' }
          const r = c.getBoundingClientRect()
          const cs = getComputedStyle(c)
          if (cs.display === 'none') return { ok: false, why: 'canvas 被 display:none（可能被兜底误伤）' }
          if (cs.visibility === 'hidden') return { ok: false, why: 'canvas visibility:hidden' }
          if (r.width < 50 || r.height < 50) return { ok: false, why: 'canvas 尺寸异常 ' + Math.round(r.width) + '×' + Math.round(r.height) }
          if (c.closest('[data-fnos-bare-hidden]')) return { ok: false, why: 'canvas 的祖先被兜底藏了' }
          // rect 一起带出来，供截图后的"墨迹检测"裁剪用
          return { ok: true, w: Math.round(r.width), h: Math.round(r.height), rect: [r.x, r.y, r.width, r.height] }
        })(),
        vw,
        hidden: [...document.querySelectorAll('[data-fnos-bare-hidden]')].map((e) => String(e.className).slice(0, 60)),
        edge,
        classes: [...classes].sort()
      }
    })()`
  )

  console.log('\n【裸模式自检】')
  // 先判页面本身 —— 失败就直接退出，后面所有断言都没有意义
  if (!report.loaded) {
    console.log(`  ✗ 页面没加载出来：${report.url}`)
    console.log('    （服务没起？端口对不对？先确认 http 返回 200 再跑本脚本）')
    cdp.close()
    console.log('\n裸模式：1 项失败')
    chrome.kill()
    await sleep(300)
    fs.rmSync(profile, { recursive: true, force: true })
    process.exit(1)
  }
  ok(report.bare, '<html> 上有 data-fnos-bare 属性')
  ok(
    report.canvas.ok,
    '图纸画布已渲染且可见',
    report.canvas.ok ? `${report.canvas.w}×${report.canvas.h}` : report.canvas.why
  )
  if (report.hidden.length) info(`几何兜底藏了 ${report.hidden.length} 个元素：` + report.hidden.join(' | '))
  ok(
    report.edge.length === 0,
    '视口边缘没有可见的外壳元素',
    report.edge.length ? JSON.stringify(report.edge.slice(0, 6)) : ''
  )

  // ── 诊断：类名清单 vs 真实 DOM ──
  const declared = readHiddenClassList()
  const present = new Set(report.classes)
  const used = declared.filter((c) => present.has(c))
  const idle = declared.filter((c) => !present.has(c))
  console.log('\n【诊断：bare.css 选择器 vs 真实 DOM】')
  info(`清单 ${declared.length} 条，本次命中 ${used.length} 条`)
  if (idle.length) {
    info('未命中（多为留作无损的候选，也可能是上游已改名）：')
    console.log('      ' + idle.join(', '))
  }

  /*
   * 关键诊断：新出现的 ml-* 类名如果既不在清单里、又贴在视口边缘，
   * 那就是"上游新增/改名了外壳"，净化会漏掉它。
   * 这里把所有不在清单里的 ml-* 列出来 —— 不下结论，只呈现事实，
   * 由人判断哪个是外壳。
   */
  const uncovered = report.classes.filter((c) => !declared.includes(c))
  if (uncovered.length) {
    info('清单未覆盖的 ml-* 类名（人工判断哪些属于外壳）：')
    console.log('      ' + uncovered.join(', '))
  }

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  fs.mkdirSync(path.join(ROOT, 'docs'), { recursive: true })
  const out = path.join(ROOT, 'docs', process.env.SHOT_NAME || 'screenshot-bare.png')
  const shotBuf = Buffer.from(shot.data, 'base64')
  fs.writeFileSync(out, shotBuf)

  /*
   * ★ 墨迹检测 ★
   * 量的是"画布区域里非黑像素占比"。黑底 + 线条 ⇒ 明显 > 0；
   * 全黑 ⇒ ≈ 0（只剩角落那点坐标轴，通常不到 0.1%）。
   *
   * 这里默认只**警告**不判失败，因为"渲染不出来"可能是环境问题
   * （无 GPU 的 CI、SwiftShader 下的某些上游版本），
   * 把它当硬失败会让脚本在那些环境下永远红着、失去意义。
   * 需要严格把关时设 BARE_REQUIRE_INK=1，它就会升级成一条断言。
   */
  let ink = -1
  try {
    const png = decodePng(shotBuf)
    ink = inkPercent(png, report.canvas.ok ? report.canvas.rect : [0, 0, report.vw, png.height], report.vw)
  } catch (e) {
    info('墨迹检测跳过：' + e.message)
  }
  console.log(`\n  截图：${path.relative(ROOT, out)}`)
  if (ink >= 0) {
    if (ink < 0.1) {
      console.log(
        `  ⚠ 画布墨迹仅 ${ink}% —— 截图里**几乎什么都没有**（大概率图纸没渲染出来，\n` +
          `    而不是"渲染得很干净"）。此时不要拿这张图当"裸模式生效"的证据：\n` +
          `    它只证明了外壳被藏、画布存在，证明不了内容。请在有 GPU 的浏览器里复核。`
      )
      if (process.env.BARE_REQUIRE_INK) ok(false, `画布有可见内容（墨迹 ${ink}%）`)
    } else {
      ok(true, `画布有可见内容（墨迹 ${ink}%）`)
    }
  }

  cdp.close()
  console.log(bad === 0 ? '\n裸模式：通过' : `\n裸模式：${bad} 项失败`)
  if (bad > 0) exitCode = 1
} catch (err) {
  console.error('裸模式自检失败：' + (err?.message || err))
  exitCode = 1
} finally {
  chrome.kill()
  await sleep(500)
  fs.rmSync(profile, { recursive: true, force: true })
  process.exit(exitCode)
}