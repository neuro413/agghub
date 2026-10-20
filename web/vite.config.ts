import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { precompress } from '../scripts/vite-precompress.mjs'

// 开发期前端跑在 5173，/api 与 /v1 反代到后端网关(3210)
export default defineConfig({
  plugins: [react(), precompress()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3210',
      '/v1': 'http://localhost:3210',
    },
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 1200,
  },
})
