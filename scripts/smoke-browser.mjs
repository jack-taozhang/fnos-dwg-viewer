/**
 * 浏览器冒烟测试（CDP，零依赖）。
 *
 * 打开一个真实的 Chrome 页面访问本服务，检查：
 *   1) 没有出现"打不开"的指引卡片；
 *   2) 查看器标题栏显示的是**中文真实文件名**，不是 %E5%9B%BE… 这种编码；
 *   3) ★ 1.0.9 起整页**没有任何应用自带的界面**（没有图纸库抽屉、没有悬浮按钮、
 *      没有顶栏/侧栏），查看器铺满整个视口 —— 这是"浏览器打开"模式该有的样子；
 *   4) 不带 ?path= 时给的是说明卡片，而不是空白页；
 * 并把截图存到 docs/ 便于人工复核。
 *
 * 用法：
 *   node scripts/smoke-browser.mjs "http://127.0.0.1:8124/?path=<编码后的文件路径>&debug=1"
 *   node scripts/smoke-browser.mjs "http://127.0.0.1:8124/"        # 顺带验说明卡片
 * 环境变量：
 *   CHROME_PATH   指定 chrome.exe
 *   SHOT_NAME     截图文件名（默认 screenshot-1.0.9.png）
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const URL_TO_OPEN = process.argv[2]
const PORT = Number(process.env.CDP_PORT || 9333)
const CALL_TIMEOUT = 60_000

if (!URL_TO_OPEN) {
  console.error('用法：node scripts/smoke-browser.mjs "<url>"')
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

const profile = path.join(os.tmpdir(), `fnos-dwg-smoke-${Date.now()}`)
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
    '--window-size=1440,900',
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

/** 极简 CDP 客户端 */
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

let bad = 0
const ok = (cond, name, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${extra ? '   ' + extra : ''}`)
  if (!cond) bad++
}

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

  // 等渲染遮罩消失，再多给一点时间让 ribbon 完成布局。
  //
  // ⚠️ 这里必须把所有"还没好"的遮罩文案都列上。查看器在解析阶段显示的是
  //    「正在解析文件 …」，而这里原来只写 `正在渲染|渲染中` —— 于是
  //    解析阶段就被判成"就绪"，截图时标题栏还是「未命名」，
  //    "查看器显示真实文件名"那条断言假报失败（其实是等得不够）。
  const busyText = /正在渲染|渲染中|正在解析|解析中|正在加载|加载中|正在打开/
  for (let i = 0; i < 60; i++) {
    const ready = await evaluate(
      cdp,
      `!!document.querySelector('canvas') && !${busyText}.test(document.body.innerText)`
    )
    if (ready) break
    await sleep(1000)
  }
  // 遮罩消失≠文档就绪（标题栏比图元晚一步，DWG 还要等 LibreDWG 转完）
  await sleep(4000)

  const text = await evaluate(cdp, 'document.body.innerText')
  ok(!/打不开/.test(text), '没有出现「打不开」指引卡片')

  /*
   * 标题栏的文件名断言不能写死。
   * 这个脚本被复用到很多场景（中文名、纯 ASCII 名、打不开的卡片……），
   * 写死成某个中文名后，换个文件就会假报失败 —— 直接从 URL 的
   * ?path= 里取真实文件名来比对。
   */
  const wantedName = (() => {
    try {
      const p = new URL(URL_TO_OPEN).searchParams.get('path') || ''
      return p ? decodeURIComponent(p).split('/').pop() : ''
    } catch {
      return ''
    }
  })()
  ok(
    !wantedName || text.includes(wantedName),
    `查看器显示真实文件名${wantedName ? `（${wantedName}）` : '（URL 里没带 path，跳过）'}`
  )
  ok(!/%E5%9B%BE|%E5%A5%97/.test(text), '界面上没有残留的百分号编码文件名')

  /*
   * ★ 1.0.9：整页不该有任何应用自带的界面。
   *
   * 这里刻意断言"**不存在**"，而不是"存在且位置对" —— 上一个版本断言的是
   * 「图纸库」按钮不压住 ribbon，那套断言在按钮被删掉之后会**假绿**
   * （`document.querySelector('.handle')` 返回 null，所有 rect 判空都"通过"）。
   * 删功能时最容易留下的就是这种空转断言。
   */
  const chrome = await evaluate(
    cdp,
    `(() => {
      const rect = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) } }
      const host = document.querySelector('.ml-cad-viewer-container')
      return {
        drawer: !!document.querySelector('.drawer'),
        handle: !!document.querySelector('.handle'),
        // 说明卡片只在没带 ?path= 时出现，不算"应用界面"
        host: rect(host),
        vw: window.innerWidth,
        vh: window.innerHeight,
        intro: /没有指定要打开的图纸/.test(document.body.innerText)
      }
    })()`
  )
  console.log('    界面：' + JSON.stringify(chrome))
  ok(!chrome.drawer, '没有图纸库抽屉（1.0.9 已删除文件浏览）')
  ok(!chrome.handle, '没有「图纸库」悬浮按钮')
  if (chrome.host) {
    ok(
      chrome.host.w >= chrome.vw - 2 && chrome.host.h >= chrome.vh - 2,
      `查看器铺满视口（${chrome.host.w}×${chrome.host.h} vs 视口 ${chrome.vw}×${chrome.vh}）`
    )
  }

  // 不带 ?path= 进入时必须给说明卡片，不能是空白页
  const hasPath = (() => {
    try {
      return Boolean(new URL(URL_TO_OPEN).searchParams.get('path'))
    } catch {
      return false
    }
  })()
  if (!hasPath) {
    ok(chrome.intro, '不带 ?path= 时给出说明卡片（不是空白页）')
  }

  // 想在截图前做点额外动作（点开某个面板之类）时用 SMOKE_EVAL 传一段脚本进来。
  // 返回值会打印出来（可以返回对象/字符串，用来确认面板真的出现了）。
  if (process.env.SMOKE_EVAL) {
    const evaled = await evaluate(cdp, process.env.SMOKE_EVAL)
    console.log('    SMOKE_EVAL 返回：' + JSON.stringify(evaled))
    await sleep(1200)
  }

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  fs.mkdirSync(path.join(ROOT, 'docs'), { recursive: true })
  const out = path.join(ROOT, 'docs', process.env.SHOT_NAME || 'screenshot-1.0.9.png')
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'))
  console.log(`\n  截图：${path.relative(ROOT, out)}`)

  cdp.close()
  console.log(bad === 0 ? '\n全部通过' : `\n${bad} 项失败`)
  if (bad > 0) exitCode = 1
} catch (err) {
  console.error('冒烟测试失败：' + (err?.message || err))
  exitCode = 1
} finally {
  chrome.kill()
  await sleep(500)
  fs.rmSync(profile, { recursive: true, force: true })
  process.exit(exitCode)
}
