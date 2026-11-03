import { createApp } from 'vue'
import ElementPlus from 'element-plus'
import { i18n } from '@mlightcad/cad-viewer'
import { AcApDocManager, AcApDocument, AcApSettingManager } from '@mlightcad/cad-simple-viewer'
import { AcDbDatabaseConverterManager, AcDbFileType } from '@mlightcad/data-model'
import { AcDbLibreDwgConverter } from '@mlightcad/libredwg-converter'
import App from './App.vue'
import { installBareMode, isBareMode } from './bare'
import './style.css'

const bare = isBareMode()

/*
 * 裸模式要在挂载前就把 html 上的标记打好，首屏才不会先闪一下完整外壳。
 * 观察器等挂载后再装（见文件末尾），此时查看器节点才存在。
 */
if (bare) document.documentElement.setAttribute('data-fnos-bare', '')

/**
 * 飞牛传进来的路径是 URL 编码过的，而查看器内部把文件名/标题直接显示出来，
 * 中文名会变成 %E5%9B%BE...。这里包一层 getter 解码，只在值里确实有 %
 * 且能被 decodeURIComponent 成功解析时才动，避免把正常名字改坏。
 */
function patchDecodedGetter(proto: object, name: string): boolean {
  let target: any = proto
  while (target) {
    const desc = Object.getOwnPropertyDescriptor(target, name)
    if (desc?.get) {
      if ((desc.get as any).__fnosDecoded) return true
      const original = desc.get
      const wrapped = function (this: unknown) {
        const value = original.call(this)
        if (typeof value !== 'string' || !value.includes('%')) return value
        try {
          return decodeURIComponent(value)
        } catch {
          return value
        }
      }
      ;(wrapped as any).__fnosDecoded = true
      Object.defineProperty(target, name, { ...desc, get: wrapped })
      return true
    }
    target = Object.getPrototypeOf(target)
  }
  return false
}

for (const name of ['fileName', 'docTitle']) {
  try {
    patchDecodedGetter(AcApDocument.prototype, name)
  } catch {
    /* 上游改结构时不影响打开图纸 */
  }
}

// DWG 解析走 LibreDWG worker。查看器本身不注册 DWG 转换器（GPL 组件由宿主选择），
// 所以这里显式注册，并指向随包分发的 worker。
const parserWorkerUrl = '/assets/libredwg-parser-worker.js'
AcDbDatabaseConverterManager.instance.register(
  AcDbFileType.DWG,
  new AcDbLibreDwgConverter({
    useWorker: true,
    convertByEntityType: false,
    parserWorkerUrl
  })
)

// 界面状态按裸模式隔离：看不见开关的模式不该和完整界面共用一份偏好
AcApSettingManager.configure({
  storageKey: bare ? 'fnos.dwg.viewer.settings.bare' : 'fnos.dwg.viewer.settings'
})

const app = createApp(App)
app.use(ElementPlus)
app.use(i18n)
app.mount('#app')

if (bare) installBareMode()

// 排障入口：?debug=1 时把文档管理器暴露到控制台
if (new URLSearchParams(window.location.search).has('debug')) {
  ;(window as any).__AcApDocManager = AcApDocManager
}
