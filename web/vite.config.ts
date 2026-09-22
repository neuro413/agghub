import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 开发期前端跑在 5173，/api 与 /v1 反代到后端网关(3210)
export default defineConfig({
  plugins: [react()],
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
