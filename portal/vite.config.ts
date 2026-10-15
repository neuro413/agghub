import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 开发期门户跑在 5174，/api 与 /v1 反代到公网端口（需以 AGGHUB_PUBLIC_PORT=3211 启动后端）
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      '/api': 'http://localhost:3211',
      '/v1': 'http://localhost:3211',
    },
  },
  build: {
    outDir: 'dist',
  },
})
