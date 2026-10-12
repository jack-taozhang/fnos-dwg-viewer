import { createApp } from 'vue'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'

import { i18n } from '@mlightcad/cad-viewer'
import { AcApDocManager, AcApDocument, AcApSettingManager } from '@mlightcad/cad-simple-viewer'
import { AcDbDatabaseConverterManager, AcDbFileType } from '@mlightcad/data-model'
import { AcDbLibreDwgConverter } from '@mlightcad/libredwg-converter'

import App from './App.vue'
import './styles.css'

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

/* 与同源下的其他产品隔离界面偏好 */
AcApSettingManager.configure({ storageKey: 'fnos.dwg.viewer.settings' })

const app = createApp(App)
app.use(ElementPlus)
app.use(i18n)
app.mount('#app')

/* 带 ?debug=1 打开时把管理器挂到 window，方便排查图纸打不开/取景异常 */
if (new URLSearchParams(window.location.search).has('debug')) {
  ;(window as unknown as Record<string, unknown>).__AcApDocManager = AcApDocManager
}
