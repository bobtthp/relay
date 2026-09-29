import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const agentUrl = process.env.RELAY_AGENT_URL ?? 'http://127.0.0.1:3000'

export default defineConfig({
  root: new URL('.', import.meta.url).pathname,
  plugins: [react()],
  build: { outDir: '../../dist/web', emptyOutDir: true },
  server: {
    proxy: {
      '/api': agentUrl,
      '/ws': agentUrl.replace(/^http/, 'ws'),
    },
  },
})
