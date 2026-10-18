import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'

const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }
const agentUrl = process.env.RELAY_AGENT_URL ?? 'http://127.0.0.1:3000'

export default defineConfig({
  root: new URL('.', import.meta.url).pathname,
  plugins: [react()],
  define: { __RELAY_VERSION__: JSON.stringify(version) },
  build: { outDir: '../../dist/web', emptyOutDir: true },
  server: {
    proxy: {
      '/api': agentUrl,
      '/ws': agentUrl.replace(/^http/, 'ws'),
    },
  },
})
