/* ------------------------------------------------------------------ *
 * 「裸模式」（?bare=1）运行期逻辑
 *
 * 职责只有两件：
 *   1) 认 URL 上的 ?bare=1，给 <html> 挂 data-fnos-bare 属性
 *      —— bare.css 里的规则靠这个属性才生效（必须**在首帧渲染前**挂上，
 *      否则会先闪一下完整界面）；
 *   2) 几何兜底：把「贴着视口边缘、又不像画布」的浮层藏掉。
 *
 * ★ 为什么需要第 2 层（几何兜底）★
 *   bare.css 靠类名，上游改类名就会静默失效。为了让"上游改名"这件事
 *   不至于退化成"工具栏全回来了而且没人知道"，这里加一层**不认类名**的
 *   判断：凡是覆盖视口**上边或下边**、且不含 <canvas> 的元素，都藏掉。
 *   画布自己也在视口里，但它会过第 2 条豁免（宽高都接近整屏）。
 *
 *   这层的代价是它必须**在渲染完成后再跑**：画布与外壳都是异步渲染出来的，
 *   首帧时外壳可能还没建。所以用 MutationObserver + 观察期，
 *   而不是跑一次就完事（跑一次必然漏）。
 *
 * ★ 为什么不用 requestAnimationFrame 死循环 ★
 *   常驻 rAF 会让嵌入块一直占着 CPU。MutationObserver 只在 DOM 真变了
 *   时回调，图纸打开完就彻底安静了。
 * ------------------------------------------------------------------ */

import './bare.css'

/** 属性名与 bare.css 里的选择器严格对应，改一处必须改两处 */
const ATTR = 'data-fnos-bare'

/**
 * 认 ?bare=1。
 *
 * ★ 为什么不复用 App.vue 里那个 launchPath 解析 ★
 *   App.vue 是 Vue 组件，它的 setup 在 mount 之后才跑；那时外壳可能已经
 *   建好并贴到屏幕上，会闪一下。裸模式要的是**首帧之前**就生效，
 *   所以必须在 main.ts 挂载前、模块顶层执行。
 *
 * ★ 值的判定放宽到 "存在即为真" ★
 *   思源插件拼的是 `bare=1`，但手敲 `?bare` 也该是同一个意思。
 *   而 `bare=0` / `bare=false` 才是明确的否定 —— 留个后门，
 *   万一以后只想在浏览器里看完整界面又不方便改插件。
 */
function isBare(): boolean {
  try {
    const v = new URLSearchParams(window.location.search).get('bare')
    if (v === null) return false
    return !(v === '0' || v === 'false' || v === 'no')
  } catch {
    return false
  }
}

const bare = isBare()

if (bare) {
  document.documentElement.setAttribute(ATTR, '')

  // 裸模式还有个副作用必须处理：查看器在 Write 模式下会自动打开
  // 某些面板（上次打开的图层/属性面板会恢复状态），而那些面板的
  // 入口按钮已经被藏了 —— 面板却还开着，等于"看不见开关的开关"。
  // 这里给窗口塞一个标记，供 main.ts / App.vue 决定是否跳过状态恢复。
  ;(window as unknown as Record<string, unknown>).__fnosBare = true
}

/* ---------------- 几何兜底 ---------------- */

/**
 * 藏掉贴在视口上下边缘的浮层外壳。
 *
 * ★★ 判据（每一条都是"防误杀"加的，宁可漏杀绝不误杀）★★
 *   误杀画布的后果是**整块白屏，且永远出不来** —— 而我们从不移除
 *   data-fnos-bare-hidden 属性，藏错了就是永久的。所以豁免规则写得比
 *   识别规则还多，这是故意的：
 *
 *   豁免① 元素**含 `<canvas>`** → 一律不藏。
 *     外壳（ribbon / 状态栏 / 命令行）永远不可能包含画布；
 *     反过来，canvas 的祖先链一律放过，就从根上杜绝"藏了画布的容器"。
 *     ★ 这条是血的教训 ★
 *       最初写的是"含 canvas **且**宽高接近整屏才豁免"。但首次扫描时
 *       canvas 还没插进去、容器尺寸还是 0，豁免不成立 ⇒ 容器被当外壳藏掉
 *       ⇒ 画布永远出不来，页面全黑。而"canvas 元素存在"这条断言照样通过
 *       —— 典型的假绿。现在改成"含 canvas 就无条件豁免"。
 *   豁免② 高度 ≥ 视口的六成 → 不藏。
 *     外壳是"一条"（实测 123px / 30px / 30px，视口 700px）；
 *     而接近整屏的是**内容区或错误卡片**（App.vue 的 .blocker 是 602px），
 *     藏掉它 = 用户打不开图纸时连提示都看不到。
 *   识别  宽 ≥ 视口八成 **且** 贴住上边或下边 **且** 高度 ≥ 24px
 *     （24px 以下是状态栏余数之类，藏不藏都看不见）
 */
function sweep(): void {
  const vw = window.innerWidth
  const vh = window.innerHeight
  if (!vw || !vh) return

  /* 自愈：万一某个带标记的元素其实是画布的祖先（老版本逻辑、或未来
   * 判据调整后回退），立刻摘掉标记。藏错一次就是永久白屏，
   * 这里花几行代码买一道保险，非常划算。 */
  for (const tagged of Array.from(document.querySelectorAll<HTMLElement>('[data-fnos-bare-hidden]'))) {
    const tag = tagged.tagName.toLowerCase()
    if (tag === 'canvas' || tagged.querySelector('canvas')) tagged.removeAttribute('data-fnos-bare-hidden')
  }

  for (const el of Array.from(document.body.querySelectorAll<HTMLElement>('*'))) {
    if (el.hasAttribute('data-fnos-bare-hidden')) continue
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden') continue

    // ★ 豁免①：含 <canvas> 的元素一律不藏。
    //   注意 `tagName === 'CANVAS'` 那一半不是冗余 ——
    //   querySelector 只查**后代**，不匹配元素自己，光写 querySelector
    //   会让 canvas 元素自己通不过豁免（scripts/check-bare.mjs 里也踩过
    //   同一个坑，两处判据必须一致）。
    const tag = el.tagName.toLowerCase()
    if (tag === 'canvas' || el.querySelector('canvas')) continue

    const r = el.getBoundingClientRect()
    if (r.width < vw * 0.8) continue                  // 宽度不够 = 不是整条外壳
    if (r.height < 24) continue                        // 太矮的藏不藏都看不见
    if (r.height >= vh * 0.6) continue                // ★ 豁免②：内容区 / 错误卡片

    const stuckTop = r.top <= 2
    const stuckBottom = vh - r.bottom <= 2
    if (!stuckTop && !stuckBottom) continue

    el.setAttribute('data-fnos-bare-hidden', '')
  }
}

/**
 * 观察期内的重复扫描。
 *
 * ★ 为什么要观察一段时间而不是只扫一次 ★
 *   外壳与画布都是异步的：先 await 配置、再决定布局，甚至中途把侧栏
 *   又展开一次。只扫一次必然漏掉后到的那些。
 *   观察期取 8 秒 —— 覆盖解析慢的大图纸；图纸打开完成后自动停。
 */
let stopAt = 0
function startSweeping(): void {
  if (!bare) return

  const tick = () => {
    sweep()
    if (performance.now() < stopAt) requestAnimationFrame(tick)
  }

  stopAt = performance.now() + 8000
  requestAnimationFrame(tick)

  // DOM 变动时立刻补扫一次 —— rAF 是 60Hz，MutationObserver 是事件驱动，
  // 后者在"外壳突然插进来"这一刻更快。
  const mo = new MutationObserver(() => sweep())
  mo.observe(document.body, { childList: true, subtree: true, attributes: true })

  // 视口尺寸变了（嵌入块被拖拽改变大小）时重新判定 —— 贴边关系会变
  window.addEventListener('resize', () => {
    if (performance.now() < stopAt) sweep()
  })
}

export function startBareMode(): void {
  if (!bare) return
  // 等 body 出来再开始观察
  if (document.body) startSweeping()
  else document.addEventListener('DOMContentLoaded', startSweeping, { once: true })
}

export const isBareMode = bare