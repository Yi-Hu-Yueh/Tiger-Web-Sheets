import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const apiTarget = process.env.TIGER_WEB_SHEETS_API_TARGET ?? 'http://127.0.0.1:18085'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: false,
      },
    },
  },
})

