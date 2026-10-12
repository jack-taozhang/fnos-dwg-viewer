/**
 * 把 CAD 解析所需的 Web Worker / WASM 资源从 node_modules 复制到 public/assets。
 *
 * 说明：
 *  - 查看器默认会在 `./assets/` 下查找 `mtext-renderer-worker.js`；
 *  - DWG 解析依赖 GPL 的 LibreDWG，官方刻意不打进包里，必须由宿主自己部署
 *    `libredwg-parser-worker.js` 与它的同级 WASM `libredwg-web.wasm`。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const OUT_DIR = path.join(ROOT, 'public', 'assets')

const ASSETS = [
  ['@mlightcad/libredwg-converter/dist/libredwg-parser-worker.js', 'libredwg-parser-worker.js', true],
  ['@mlightcad/libredwg-converter/dist/libredwg-web.wasm', 'libredwg-web.wasm', true],
  ['@mlightcad/cad-simple-viewer/dist/mtext-renderer-worker.js', 'mtext-renderer-worker.js', true]
]

fs.mkdirSync(OUT_DIR, { recursive: true })

let missing = 0
for (const [src, name, required] of ASSETS) {
  const from = path.join(ROOT, 'node_modules', src)
  const to = path.join(OUT_DIR, name)
  if (!fs.existsSync(from)) {
    console.warn(`[workers] 缺少依赖文件：${src}`)
    if (required) missing++
    continue
  }
  if (fs.existsSync(to) && fs.statSync(to).size === fs.statSync(from).size) {
    console.log(`[workers] 已是最新：assets/${name}`)
    continue
  }
  fs.copyFileSync(from, to)
  console.log(`[workers] 已复制：assets/${name}`)
}

if (missing > 0) {
  console.error('\n[workers] 关键资源缺失，请先执行：npm install\n')
  process.exit(1)
}
