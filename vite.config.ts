import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
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
    target: 'es2022',
    chunkSizeWarningLimit: 10000
  }
})
