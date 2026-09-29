import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test, expect, type Page } from '@playwright/test'

let appUrl = ''
let backendUrl = ''
let tempDir = ''
let backend: ChildProcess | undefined
let frontend: ChildProcess | undefined
let serviceEnv: NodeJS.ProcessEnv

async function unusedPort() {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Unable to reserve a local test port')
  const { port } = address
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}

async function waitForService(url: string, child: ChildProcess) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Service exited before becoming ready: ${url}`)
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch { /* The process is still starting. */ }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`Service did not become ready: ${url}`)
}

test.beforeAll(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'relay-codex-install-ui-'))
  const installPrefix = path.join(tempDir, 'npm-global')
  const runtimeBin = path.join(tempDir, 'runtime-bin')
  const backendPort = await unusedPort()
  const frontendPort = await unusedPort()
  backendUrl = `http://127.0.0.1:${backendPort}`
  appUrl = `http://127.0.0.1:${frontendPort}`
  await mkdir(runtimeBin, { recursive: true })
  await symlink(process.execPath, path.join(runtimeBin, 'node'))
  await symlink(execFileSync('which', ['npm'], { encoding: 'utf8' }).trim(), path.join(runtimeBin, 'npm'))
  serviceEnv = {
    ...process.env,
    PORT: String(backendPort),
    RELAY_HOST: '127.0.0.1',
    RELAY_AGENT_URL: backendUrl,
    RELAY_DATA_DIR: path.join(tempDir, 'relay-data'),
    npm_config_prefix: installPrefix,
    PATH: `${path.join(installPrefix, 'bin')}:${runtimeBin}:/usr/bin:/bin:/usr/sbin:/sbin`,
  }

  backend = spawn(process.execPath, ['dist-server/packages/agent/src/server.js'], {
    cwd: process.cwd(),
    env: serviceEnv,
    stdio: 'ignore',
  })
  await waitForService(`${backendUrl}/api/health`, backend)

  frontend = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--config', 'apps/web/vite.config.ts', '--host', '127.0.0.1', '--port', String(frontendPort), '--strictPort'], {
    cwd: process.cwd(),
    env: serviceEnv,
    stdio: 'ignore',
  })
  await waitForService(appUrl, frontend)
})

test.afterAll(async () => {
  frontend?.kill('SIGTERM')
  backend?.kill('SIGTERM')
  if (tempDir) await rm(tempDir, { recursive: true, force: true })
})

async function mockNonEnvironmentApi(page: Page) {
  await page.route('**/api/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname === '/api/environment' || url.pathname === '/api/environment/codex/install') {
      await route.continue()
      return
    }

    let body: unknown = { items: [] }
    if (url.pathname === '/api/projects') {
      body = { items: [{ id: 'project-ci', name: 'Relay CI', path: tempDir, branch: 'main', clean: true }] }
    } else if (url.pathname === '/api/projects/project-ci/tasks') {
      body = { items: [{ id: 'task-ci', title: 'Install UI smoke test', agent: 'Codex', status: 'completed', lastActivityAt: new Date().toISOString() }] }
    } else if (url.pathname === '/api/machines') {
      body = { items: [{ id: 'machine-ci', name: 'GitHub Actions' }] }
    } else if (url.pathname === '/api/account/rate-limits') {
      body = { primary: { usedPercent: 0, resetsAt: 0 }, secondary: null }
    } else if (url.pathname.endsWith('/history')) {
      body = { items: [] }
    } else if (url.pathname.endsWith('/usage')) {
      body = { tokenUsage: null }
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })
}

test('clicking Install Codex installs the CLI without signing in', async ({ page, request }) => {
  await mockNonEnvironmentApi(page)
  await page.goto(appUrl)
  await page.getByRole('button', { name: 'Overview' }).click()
  await expect(page.getByRole('heading', { name: 'Codex & Claude environment' })).toBeVisible()

  const codexCard = page.locator('.environment-card').filter({ has: page.getByRole('heading', { name: 'Codex CLI' }) })
  const installButton = codexCard.getByRole('button', { name: 'Install Codex CLI' })
  await expect(installButton).toBeVisible()
  await expect(codexCard.locator('.environment-status')).toHaveText('Missing')

  const installResponse = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/environment/codex/install')
  await installButton.click()
  expect((await installResponse).status()).toBe(202)

  await expect.poll(async () => {
    const response = await request.get(`${backendUrl}/api/environment`)
    const environment = await response.json() as { tools: Array<{ id: string; installed: boolean }> }
    return environment.tools.find(tool => tool.id === 'codex')?.installed ?? false
  }, { timeout: 150_000, intervals: [1_000, 2_000, 5_000] }).toBe(true)

  await expect(codexCard.locator('.environment-status')).toHaveText('Ready', { timeout: 15_000 })
  await expect(codexCard.getByRole('button', { name: 'Installed' })).toBeVisible()
})
