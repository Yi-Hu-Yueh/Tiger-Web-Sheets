import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const apiTarget = process.env.TIGER_WEB_SHEETS_API_TARGET ?? 'http://127.0.0.1:18085'
const productVersion = readFileSync(resolve(import.meta.dirname, '../VERSION'), 'utf8').trim()

export default defineConfig({
  define: { __TIGER_VERSION__: JSON.stringify(productVersion) },
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

