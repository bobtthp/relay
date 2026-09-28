import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: new URL('.', import.meta.url).pathname,
  plugins: [react()],
  build: { outDir: '../../dist/web', emptyOutDir: true },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:3000',
      '/ws': 'ws://127.0.0.1:3000',
    },
  },
})
