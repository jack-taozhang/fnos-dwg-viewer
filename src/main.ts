import { createApp } from 'vue'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'

import { i18n } from '@mlightcad/cad-viewer'
import { AcApDocManager, AcApDocument, AcApSettingManager } from '@mlightcad/cad-simple-viewer'
import { AcDbDatabaseConverterManager, AcDbFileType } from '@mlightcad/data-model'
import { AcDbLibreDwgConverter } from '@mlightcad/libredwg-converter'

import App from './App.vue'
import './styles.css'
import { isBareMode, startBareMode } from './bare'

/* ------------------------------------------------------------------ *
 * 1) 修掉查看器标题栏里的中文乱码
 *
 * 查看器的 AcApDocument.getFileNameFromUri 直接取
 * `new URL(uri).pathname` 的末段，**不做百分号解码**。而 URL 里不可能裸放
 * 中文，我们只能 encodeURIComponent —— 于是标题栏显示成
 * "TS23…_C%E5%A5%97%E7%BA%B8…dwg"，用户根本认不出是哪张图。
 *
 * 它没有"传入显示名"的入口，所以在取值器外面套一层解码：
 * 任何时刻读 fileName / docTitle（标题栏、导出文件名）拿到的都是真名。
 * 比监听 documentActivated 再改更可靠——不用抢事件顺序，也不依赖实例
 * 何时创建（AcApDocManager.instance 在初始化前访问会直接抛错）。
 * ------------------------------------------------------------------ */
function patchDecodedTitle(proto: object | null, prop: string): boolean {
  let target: object | null = proto
  while (target) {
    const desc = Object.getOwnPropertyDescriptor(target, prop)
    if (desc?.get) {
      if ((desc.get as { __fnosDecoded?: boolean }).__fnosDecoded) return true
      const original = desc.get
      const wrapped = function (this: unknown) {
        const raw = original.call(this)
        if (typeof raw !== 'string' || !raw.includes('%')) return raw
        try {
          return decodeURIComponent(raw)
        } catch {
          return raw
        }
      }
      ;(wrapped as { __fnosDecoded?: boolean }).__fnosDecoded = true
      Object.defineProperty(target, prop, { ...desc, get: wrapped })
      return true
    }
    target = Object.getPrototypeOf(target)
  }
  return false
}

for (const prop of ['fileName', 'docTitle']) {
  try {
    patchDecodedTitle(AcApDocument.prototype, prop)
  } catch {
    /* 上游改名/改实现时静默跳过，只影响标题显示 */
  }
}

/* ------------------------------------------------------------------ *
 * 1) 注册 DWG 解析器
 *
 * 查看器本体（MIT）默认只带 DXF 解析，DWG 依赖 GPL 的 LibreDWG，官方
 * 刻意不打包，必须由宿主自己注册。解析跑在 Web Worker 里，WASM 与
 * worker 同级部署在 /assets 下（见 scripts/copy-workers.mjs）。
 * ------------------------------------------------------------------ */
const baseUrl = import.meta.env.BASE_URL.endsWith('/')
  ? import.meta.env.BASE_URL
  : import.meta.env.BASE_URL + '/'

const dwgParserWorkerUrl = `${baseUrl}assets/libredwg-parser-worker.js`

AcDbDatabaseConverterManager.instance.register(
  AcDbFileType.DWG,
  new AcDbLibreDwgConverter({
    useWorker: true,
    convertByEntityType: false,
    parserWorkerUrl: dwgParserWorkerUrl
  })
)

/* ------------------------------------------------------------------ *
 * 3) 界面偏好存储键
 *
 * ★ 为什么裸模式要用独立的 key ★
 *   查看器把界面状态（图层面板是否展开、侧栏宽窄…）存在
 *   AcApSettingManager 指定的 storageKey 下，**跨文档共用**。
 *   于是"在飞牛里双击图纸"用过的状态会被"思源嵌入块"继承 ——
 *   而嵌入块里那些开关按钮已被裸模式藏掉，等于留下一堆
 *   "看不见开关的开关"：面板开着，用户却找不到关它的入口。
 *   两边各存各的，互不污染；裸模式永远是干净的默认界面。
 *
 * ★ 顺序 ★
 *   必须在 app.mount 之前 configure：设置管理器是单例，
 *   组件初始化时就已经按当时的 key 读过一次了。
 * ------------------------------------------------------------------ */
AcApSettingManager.configure({
  storageKey: isBareMode ? 'fnos.dwg.viewer.settings.bare' : 'fnos.dwg.viewer.settings'
})

/* ------------------------------------------------------------------ *
 * 2) 挂载 + 裸模式
 *
 * ★ import { startBareMode } 放在文件末尾、mount 之前 ★
 *   不是为了代码顺序好看：bare.ts 在**模块顶层**就给 <html> 挂
 *   data-fnos-bare 属性，而本文件的 import 全部先于 mount 执行 ——
 *   于是外壳第一次被 Vue 建出来时就带着 bare.css 的样式，不会闪一下
 *   完整界面。ESM 的 import 会被提前提升，所以这行写在文件哪个位置
 *   都不影响"早于 mount"这件事，但放在这里读起来最顺。
 * ------------------------------------------------------------------ */
const app = createApp(App)
app.use(ElementPlus)
app.use(i18n)
app.mount('#app')

/* 裸模式的几何兜底：观察 8 秒，把后到的外壳浮层也藏掉 */
startBareMode()

/* 带 ?debug=1 打开时把管理器挂到 window，方便排查图纸打不开/取景异常 */
if (new URLSearchParams(window.location.search).has('debug')) {
  ;(window as unknown as Record<string, unknown>).__AcApDocManager = AcApDocManager
}
