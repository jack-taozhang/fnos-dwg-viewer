import { defineConfig } from 'vite'
import type { Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.resolve(root, 'dist')
const modules = path.join(root, 'node_modules')

/**
 * worker / wasm / HTML 导出运行时必须保持**固定文件名**：
 *  - 服务端静态资源白名单与 worker 内部 `new URL('libredwg-web.wasm', import.meta.url)`
 *    都按文件名找；
 *  - 查看器里 mtext worker 的默认地址是 `./assets/mtext-renderer-worker.js`；
 *  - MlCadViewer 的 HTML 导出默认找 `./assets/viewer-runtime.iife.js`。
 * 这些文件不经过 Rollup 打包，构建结束后原样拷进 dist/assets。
 *
 * 与 `scripts/copy-workers.mjs` 的分工：那个负责 dev 模式（拷到 public/assets，
 * 由 vite 直接伺服）；这里负责 build（拷进 dist/assets，并补上 dev 用不到的
 * viewer-runtime.iife.js —— 它只在导出离线 HTML 时才被引用）。
 */
function copyCadAssets(): Plugin {
  return {
    name: 'fnos-copy-cad-assets',
    apply: 'build',
    closeBundle() {
      const assetsDir = path.join(outDir, 'assets')
      fs.mkdirSync(assetsDir, { recursive: true })
      const files: Array<[string, string]> = [
        ['@mlightcad/libredwg-converter/dist/libredwg-parser-worker.js', 'libredwg-parser-worker.js'],
        ['@mlightcad/libredwg-converter/dist/libredwg-web.wasm', 'libredwg-web.wasm'],
        ['@mlightcad/mtext-renderer/dist/mtext-renderer-worker.js', 'mtext-renderer-worker.js'],
        ['@mlightcad/cad-html-plugin/dist/viewer-runtime.iife.js', 'viewer-runtime.iife.js']
      ]
      for (const [from, to] of files) {
        const source = path.join(modules, from)
        if (!fs.existsSync(source)) {
          this.warn(`缺少资源：${from}（跳过 ${to}）`)
          continue
        }
        fs.copyFileSync(source, path.join(assetsDir, to))
      }
    }
  }
}

export default defineConfig({
  plugins: [vue(), copyCadAssets()],
  base: '/',
  server: {
    port: 5173,
    proxy: {
      // 开发模式下把 /api 转发给本地 Express 服务，避免跨域
      '/api': {
        target: 'http://127.0.0.1:8020',
        changeOrigin: true
      }
    }
  },
  build: {
    target: 'es2020',
    outDir,
    emptyOutDir: true,
    assetsDir: 'assets',
    chunkSizeWarningLimit: 10000,
    rollupOptions: {
      // 这两个云盘插件是 cad-viewer 的可选 peer；本应用不提供 OneDrive /
      // Google Drive 入口，保持 external，避免构建期因未安装而失败。
      external: [/^@mlightcad\/cad-(?:google-drive|onedrive)-plugin(?:\/.*)?$/]
    }
  },
  resolve: {
    dedupe: [
      'vue',
      'vue-i18n',
      'three',
      'element-plus',
      'lodash-es',
      '@vueuse/core',
      '@mlightcad/data-model',
      '@mlightcad/cad-simple-viewer'
    ]
  }
})
