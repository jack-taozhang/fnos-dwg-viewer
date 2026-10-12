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
> 注入本来就进不去。若需要桌面端也净掉工具栏，得由本应用自己认一个 URL 参数
> （例如 `?bare=1`）来自藏外壳，而不是靠宿主页注入。

---

## 3. FPK 版本号

版本号在三处，必须同步：

| 文件 | 字段 |
|---|---|
| `package.json` | `version`（当前 1.0.9） |
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