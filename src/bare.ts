/**
 * 裸模式（?bare=1）：由应用自己藏掉查看器外壳（ribbon / 状态栏 / 命令行 /
 * 竖排工具条），整页只剩图纸。思源「CAD 嵌入块」在桌面客户端下必然跨源，
 * 宿主页注入的样式会被浏览器静默丢弃，所以只能由应用自己动手。
 *
 * 实现分两路：
 *  1. 已知类名由 CSS（html[data-fnos-bare] ...）直接隐藏；
 *  2. 未知的顶部/底部横条，用几何特征兜底：宽度铺满、贴着视口上/下沿、
 *     高度又不足以占满大半屏的元素，标记 data-fnos-bare-hidden 后由 CSS 隐藏。
 *     只在打开后的前 8 秒内反复扫描（界面是渐进渲染出来的），之后交给
 *     MutationObserver，避免长期跑 rAF。
 */

export function isBareMode(search: string = window.location.search): boolean {
  try {
    const value = new URLSearchParams(search).get('bare')
    if (value === null) return false
    return !(value === '0' || value === 'false' || value === 'no')
  } catch {
    return false
  }
}

function hideShellChrome(): void {
  const width = window.innerWidth
  const height = window.innerHeight
  if (!width || !height) return

  // 之前被误标记的、里面装着画布的元素先放出来（画布可能后来才挂载）
  for (const el of Array.from(document.querySelectorAll('[data-fnos-bare-hidden]'))) {
    if (el.tagName.toLowerCase() === 'canvas' || el.querySelector('canvas')) {
      el.removeAttribute('data-fnos-bare-hidden')
    }
  }

  for (const el of Array.from(document.body.querySelectorAll('*'))) {
    if (el.hasAttribute('data-fnos-bare-hidden')) continue
    const style = getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden') continue
    if (el.tagName.toLowerCase() === 'canvas' || el.querySelector('canvas')) continue

    const rect = el.getBoundingClientRect()
    if (rect.width < width * 0.8 || rect.height < 24 || rect.height >= height * 0.6) continue

    const atTop = rect.top <= 2
    const atBottom = height - rect.bottom <= 2
    if (atTop || atBottom) el.setAttribute('data-fnos-bare-hidden', '')
  }
}

function startObserver(): void {
  let deadline = 0
  const tick = () => {
    hideShellChrome()
    if (performance.now() < deadline) requestAnimationFrame(tick)
  }

  deadline = performance.now() + 8000
  requestAnimationFrame(tick)

  new MutationObserver(() => hideShellChrome()).observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true
  })

  window.addEventListener('resize', () => {
    if (performance.now() < deadline) hideShellChrome()
  })
}

export function installBareMode(): void {
  document.documentElement.setAttribute('data-fnos-bare', '')
  // 给宿主页/调试留一个判断入口
  ;(window as any).__fnosBare = true

  if (document.body) startObserver()
  else document.addEventListener('DOMContentLoaded', startObserver, { once: true })
}
