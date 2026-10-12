# 升级指南

本项目**包装**了第三方开源的 CAD 渲染内核 `@mlightcad/*`，同时它是飞牛原生应用（FPK）。
升级要分两条线看：**内核版本** 与 **FPK 版本**。

---

## 1. 上游内核：@mlightcad

图纸解析与渲染全部来自 mlightcad 的开源组件：

| 包 | 当前版本 | 作用 |
|---|---|---|
| `@mlightcad/cad-viewer` | 1.7.4 | 查看器外壳（ribbon / 图层 / 命令行 / 状态栏） |
| `@mlightcad/cad-simple-viewer` | 1.7.4 | `MlCadViewer` 组件与打开模式枚举 |
| `@mlightcad/cad-agent-plugin` | 1.7.4 | AI agent 插件 |
| `@mlightcad/cad-html-plugin` | 1.7.4 | 导出 HTML |
| `@mlightcad/cad-svg-plugin` | 1.7.4 | 导出 SVG |
| `@mlightcad/cad-pdf-plugin` | 1.7.4 | 导出 PDF |
| `@mlightcad/three-renderer` | 1.7.4 | WebGL 渲染 |
| `@mlightcad/pdf-renderer` | 1.7.4 | PDF 渲染 |
| `@mlightcad/data-model` | ^1.15.1 | 数据模型 |
| `@mlightcad/libredwg-converter` | ^3.15.2 | DWG → 中间格式转换（WASM） |

> ★ 注意：`dependencies` 是空的，全部走 `devDependencies` ——
> **运行期零依赖**，上游产物在打包时静态编译进 `dist/`。

### 升级步骤

```bash
# 1) 统一改版本（六个包必须同版本，它们互为 peer）
#    编辑 package.json 里 @mlightcad/* 的版本号

npm install

# 2) 重新拷贝 WASM worker（libredwg / mtext 两个，版本必须与包匹配）
npm run workers

# 3) 构建
npm run build

# 4) 本地冒烟
npm run e2e          # 覆盖全模式
npm run smoke        # 浏览器端真实打开一张图纸
npm run test:dxf     # DXF 解析回归

# 5) 打包
npm run fpk
```

### 升级必查清单

- [ ] **六个 `@mlightcad/*` 保持同一版本号**。m 的这些包共享内部数据结构，
      混版本会在运行时报难以定位的错误。
- [ ] **`npm run workers` 必须重跑**。`libredwg-parser-worker.js` 与
      `mtext-renderer-worker.js` 是 WASM 产物，旧 worker 配新包会直接白屏。
- [ ] **`open-view-mode` 仍是 `AcApOpenViewMode.Extents`**。
      不显式声明的话，Write 模式下查看器会用图纸里存的 Saved 视图，
      没有 VPORT 表的图纸会被缩成一个点。
- [ ] **`open-mode` 仍是 `AcEdOpenMode.Write`**。
      查看器的 ribbon 标签按打开模式做白名单过滤，用 Read 打开就只剩「测量」一个标签。
- [ ] **DOM 类名没变**。`ml-cad-header` / `ml-cad-main` / `ml-status-bar` /
      `ml-cli-container` / `ml-vertical-toolbar-host` 等被下游依赖，
      见下一节。

---

## 1.5 ★ 升级后必跑：`npm run check:bare`

裸模式（`?bare=1`）靠**类名**隐藏外壳。上游一旦改类名，净化会**静默失效** ——
构建照过、FPK 照装、不报任何错，只有用户在思源嵌入块里才看到"工具栏全回来了"。

所以升级流程里必须加一步：

```bash
npm run build
npm start &                                   # 或起一个临时端口
node scripts/check-bare.mjs "http://127.0.0.1:8020/open?bare=1&path=<某张真图纸的绝对路径>"
```

它做两件事：

1. **断言**：裸模式下视口四边不该有任何可见外壳元素；
2. **诊断**：枚举真实 DOM 里所有 `ml-*` 类名，跟 `src/bare.css` 的选择器清单
   逐条比对，打印「哪些规则打空了」和「哪些类名是新出现的、清单没覆盖」。

> ★ 脚本刻意**先判页面有没有真的加载出来** ★
>   浏览器自己的错误页（服务没起、端口写错）当然也是"视口边缘没有外壳"——
>   不判这一条，脚本会在服务没起来时**假绿**。假绿比红着更坏。
>
> ★ 它会打印一长串未覆盖的 `ml-*` 类名 ★
>   那不是失败，是**事实呈现**（很多是弹窗/下拉的内部类，本来就不该藏）。
>   要做的是人工扫一眼：里面有没有**新的外壳类**（ribbon / toolbar / status-bar
>   这类贴在视口边缘的名字）。有就补进 `src/bare.css` 的清单。

**升级后的标准动作**：跑一次 `check:bare`，若「清单 N 条，本次命中 M 条」里
M 明显变小、或边缘检出残留外壳，就去 `docs/` 里翻 `screenshot-bare.png` 对照实图。

> ★★ 截图必须配"墨迹读数"一起看，别只信肉眼 ★★
>   `check:bare` 会同时打印画布区域的**非黑像素占比**：
>   ```
>   ⚠ 画布墨迹仅 0.03% —— 截图里几乎什么都没有
>   ```
>   出现这条警告说明**图纸根本没渲染出来**（常见于无 GPU 的 headless 环境），
>   此时那张截图**不能**当作"裸模式生效"的证据 —— 它只证明了"外壳被藏、画布存在",
>   证明不了"内容还在"。
>   2026-10-12 就踩过：一张 3.4KB 的全黑截图被当成了渲染成功的证据。
>   所以本脚本新增了这条读数；需要严格把关时设 `BARE_REQUIRE_INK=1`，
>   它会把"画布必须有可见内容"升级成一条硬断言。
>   **真正确认内容还在，要在有 GPU 的真实浏览器里看一次。**

---

## 1.6 裸模式的三层兜底（为什么上游改名不会立刻炸）

藏外壳这件事有三层实现，**刻意做成"从稳到脆"**，任何一层生效即可：

| 层 | 位置 | 认什么 | 抗上游改名？ |
|---|---|---|---|
| ① 精确层 | `src/bare.css` | 上游类名（`ml-cad-header` 等） | ❌ 最脆，改名即失效 |
| ② 几何层 | `src/bare.ts` 的 `sweep()` | **只看几何**：盖住视口八成宽、贴住上/下边、且不含整屏 `<canvas>` | ✅ 不认任何类名 |
| ③ 宿主层 | siyuan-localfs 的 `src/purify.js` | 同源时往 iframe 注入 CSS | ✅ 但跨源无效 |

- ② 是抗改名的关键：它**不知道**元素叫什么，只知道"谁占了边"。
  实测有效 —— 它正是让「视口边缘无外壳」这条断言通过的层。
- ② 的判据刻意保守（宽度八成 + 贴边 + 不含整屏 canvas + 尺寸 ≥40px），
  **宁可漏杀不误杀**：误杀画布的后果是整块白屏，比留着一条状态栏严重得多。
- 三层都不是为了"多层保险"而堆的：① 精确但脆、② 稳但粗、③ 只在同源时有效。
  删掉任何一层都会让某些场景退化。

> ★ 为什么不给 `MlCadViewer` 传 prop 来隐藏 ★
>   上游 1.7.4 **没有**任何隐藏外壳的官方 prop（`MlCadViewer.vue.d.ts` 的 Props 里
>   只有 `disableExport` 这类"功能裁剪"）。所以只能藏 DOM。
>   将来若上游补了官方开关，优先改用官方 prop，并把 ① ② 降级为兼容旧版本。

---

## 2. 与思源侧的联动（改类名/结构前必读）

本应用被 [siyuan-localfs](https://github.com/jack-taozhang/siyuan-localfs) 插件
通过思源反代的 `/localfs/cad/*` 同源通道借用。插件会在**同源**场景下
往 iframe 里注入样式，把本应用自带的整套外壳藏掉：

- 隐藏：顶部 ribbon、底部状态栏、命令行、右侧竖排工具条、右侧顶部浮动工具条
- 归零 CSS 变量：`--ml-header-height`、`--ml-status-bar-height`
- 钉死 `.ml-cad-main` / `.ml-cad-container` / `.ml-cad-viewer-container` 的四边

这些类名与变量名来自**真机实测枚举**，脚本见 siyuan-localfs 侧的 `_diag-cad-dom.mjs`。

> ⚠️ 若上游改了 DOM 结构或类名，净化会**静默失效** —— 嵌入块里工具栏全部冒回来，
> 而且不报任何错。**升级内核后请务必在思源里实测一次嵌入块。**

> ⚠️ 跨源场景（思源**桌面客户端**，页面在本机 `127.0.0.1:6806`、iframe 在 NAS）
> 注入本来就进不去。~~若需要桌面端也净掉工具栏，得由本应用自己认一个 URL 参数~~

### 2.1 裸模式 `?bare=1`（1.0.10 起）

**跨源的问题已经解决了**，办法就是让本应用自己藏外壳 —— 不依赖宿主页注入：

```
内嵌块地址 = /localfs/cad/open?path=<绝对路径>&bare=1
                              ^^^^^^^^^^^^^^^ 同源与跨源都生效
```

- **本应用侧**：`src/bare.ts` + `src/bare.css`（见 §1.5 / §1.6 的三层兜底）
- **插件侧**：`siyuan-localfs` 的 `api.js` 里 `cadViewerUrl(path, bare)`，
  内嵌传 `true` 拼 `bare=1`；「在浏览器中打开」传 `false` 保持完整界面
  （新标签页里用户可能想用图层/测量/导出）。
- 同源时两条路都生效（注入 + 自藏），互为双保险；**跨源时只有自藏那条**。

> ★ 为什么桌面端跨源是常态而不是边缘情况 ★
>   桌面客户端的内核跑在**本机**，本机没有反代 ⇒ 插件只能退到
>   `_base` 探到的 NAS 主机 + 6806，与宿主页 `http://127.0.0.1:6806` 必然跨源。
>   也就是说：**桌面端永远走跨源那条路**，同源注入在桌面端是无效的。
>   这就是为什么裸模式不是"锦上添花"，而是桌面端唯一可行的解法。

### 2.2 storageKey 必须按裸模式隔离

查看器的界面状态（图层面板是否展开等）存在 `AcApSettingManager` 的
storageKey 下，**跨文档共用**。若不隔离，"在飞牛双击图纸"用过的状态会被
思源嵌入块继承 —— 而嵌入块里那些开关按钮已被藏掉，用户就得到一堆
**"看不见开关的开关"**。

所以 `src/main.ts` 里按模式给不同的 key：

```ts
storageKey: isBareMode ? 'fnos.dwg.viewer.settings.bare' : 'fnos.dwg.viewer.settings'
```

> ★ 这条也是升级必查项 ★
>   若上游把设置管理器的 API 改名（比如 `configure` → `setup`），
>   裸模式的隔离会**静默失效**（两边又共用一个 key），
>   症状是"嵌入块里面板莫名其妙开着，且找不到关它的按钮"——
>   跟类名失效一样不报错。所以 `check:bare` 顺带看一眼界面状态是否符合预期。

---

## 3. FPK 版本号

版本号在三处，必须同步：

| 文件 | 字段 |
|---|---|
| `package.json` | `version`（当前 1.0.10） |
| `fnos-package/manifest` | `version` |
| （若已发版）GitHub Release tag | `v1.0.x` |

`scripts/build-fpk.mjs` 在打包时会校验这一致性。

---

## 4. 端口与通道

- 本应用默认监听 `8020`（CAD 看图）。
- 思源侧的同源通道前缀 `/localfs/cad` 定义在 `siyuannote-fnos-app` 的
  `reverse-proxy.py`（`PROXY_CAD_PREFIX`）与 `cmd/main`。**改端口要两边一起改。**
- 反代会把这批**根绝对**资源分两类处理：能与内核区分的（`/assets` 下的哈希产物名）
  逐个精确收编；与内核重名的（`/api/**`）只对文本资源做正文补前缀，
  二进制（图纸本身、解析 WASM）一律原样转发。**新增根绝对资源时要复核这一条。**

---

## 5. 本地开发

```bash
npm run dev       # vite 开发服务器
npm start         # 只起后端（server/index.mjs）
```

打开 `/open?path=/绝对路径.dwg` 是不带 path 时的说明页（正常入口是 `/open`）。

**后端以 root 运行**才能直读全部存储空间（`/vol1`、`/vol00`…）；
不授权时会被 `OUT_OF_SCOPE` / `EACCES` 拦下，此时应用会显示一张带修复命令的指引卡
（见 `src/App.vue` 的 `describe()`）。应急模式下可设 `FNOS_ACCESS_MODE=scoped`
限定目录白名单。