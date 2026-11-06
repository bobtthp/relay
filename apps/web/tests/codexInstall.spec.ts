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
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) })
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
  const imageItems: Array<{ name: string; path: string; size: number; mimeType: string; createdAt: string; previewUrl: string }> = []
  let uploadShare: { active: boolean; url?: string; createdAt?: string } = { active: false }
  let providerSettings: { deepseek: { configured: boolean; source: null; keyHint: null }; localModel: { configured: boolean; name: string | null; baseUrl: string | null; model: string | null; keyHint: string | null }; localRegressionEnabled: boolean; proxy: { url: null; systemProxy: null }; checkpointsEnabled: boolean } = { deepseek: { configured: false, source: null, keyHint: null }, localModel: { configured: false, name: null, baseUrl: null, model: null, keyHint: null }, localRegressionEnabled: false, proxy: { url: null, systemProxy: null }, checkpointsEnabled: false }
  const agentAccounts = [
    { id: 'codex-default', name: 'Codex 默认账号', agent: 'Codex', configDirectory: '/tmp/codex-default', isDefault: true, createdAt: new Date(0).toISOString(), loginCommand: 'codex login' },
    { id: 'claude-default', name: 'Claude 默认账号', agent: 'Claude', configDirectory: '/tmp/claude-default', isDefault: true, createdAt: new Date(0).toISOString(), loginCommand: 'claude' },
  ]
  await page.route('**/api/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname === '/api/environment' || url.pathname === '/api/environment/codex/install') {
      await route.continue()
      return
    }

    if (url.pathname === '/api/projects/project-ci/images') {
      if (request.method() === 'POST') {
        const image = { name: 'uploaded.jpg', path: '/tmp/relay/uploads/project-ci/uploaded.jpg', size: 1234, mimeType: 'image/jpeg', createdAt: new Date().toISOString(), previewUrl: '/api/projects/project-ci/images/uploaded.jpg/content' }
        imageItems.unshift(image)
        await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(image) })
      } else await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: imageItems }) })
      return
    }
    if (url.pathname === '/api/agent-accounts') {
      if (request.method() === 'POST') {
        const input = request.postDataJSON() as { name: string; agent: 'Codex' | 'Claude' }
        const account = { id: 'account-01234567-89ab-cdef-0123-456789abcdef', name: input.name, agent: input.agent, configDirectory: `/tmp/${input.agent.toLowerCase()}-personal-1`, createdAt: new Date().toISOString(), loginCommand: `${input.agent === 'Codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'}=/tmp/profile ${input.agent.toLowerCase()}` }
        agentAccounts.push(account)
        await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(account) })
      } else await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: agentAccounts }) })
      return
    }
    if (url.pathname === '/api/settings/providers') {
      if (request.method() === 'PUT') {
        const input = request.postDataJSON() as { localModel?: { name: string; baseUrl: string; model: string; apiKey?: string | null } | null; localRegressionEnabled?: boolean }
        if ('localModel' in input) providerSettings = {
          ...providerSettings,
          localModel: input.localModel ? { configured: true, name: input.localModel.name, baseUrl: input.localModel.baseUrl, model: input.localModel.model, keyHint: input.localModel.apiKey ? '…test' : null } : { configured: false, name: null, baseUrl: null, model: null, keyHint: null },
        }
        if (typeof input.localRegressionEnabled === 'boolean') providerSettings = { ...providerSettings, localRegressionEnabled: input.localRegressionEnabled }
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(providerSettings) })
      return
    }
    if (url.pathname === '/api/projects/project-ci/images/uploaded.jpg/content') {
      await route.fulfill({ status: 200, contentType: 'image/jpeg', body: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) })
      return
    }
    if (url.pathname === '/api/projects/project-ci/image-upload-share') {
      if (request.method() === 'POST') uploadShare = { active: true, url: `${appUrl}/upload/test-share-token`, createdAt: new Date().toISOString() }
      if (request.method() === 'DELETE') uploadShare = { active: false }
      await route.fulfill(request.method() === 'DELETE' ? { status: 204, body: '' } : { status: 200, contentType: 'application/json', body: JSON.stringify(uploadShare) })
      return
    }

    let body: unknown = { items: [] }
    if (url.pathname === '/api/projects') {
      body = { items: [{ id: 'project-ci', name: 'Relay CI', path: tempDir, branch: 'main', clean: true }] }
    } else if (url.pathname === '/api/projects/project-ci/tasks') {
      body = { items: [{ id: 'task-ci', title: 'Install UI smoke test', agent: 'Codex', accountId: 'codex-default', status: 'completed', lastActivityAt: new Date().toISOString() }] }
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

test('uploads a temporary project image and creates a collaborative link', async ({ page }) => {
  await mockNonEnvironmentApi(page)
  await page.goto(appUrl)
  await page.getByRole('button', { name: 'Images' }).click()
  await expect(page.getByRole('heading', { name: 'Relay CI images' })).toBeVisible()

  await page.locator('.image-drop-zone input').setInputFiles(path.resolve('en.jpg'))
  await expect(page.getByText('/tmp/relay/uploads/project-ci/uploaded.jpg')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Copy path' })).toBeVisible()

  await page.getByRole('button', { name: 'Create upload link' }).click()
  await expect(page.locator('.image-share-link code')).toContainText('/upload/test-share-token')
  await expect(page.getByRole('button', { name: 'Disable' })).toBeVisible()
})

test('adds reusable named agent accounts from local settings', async ({ page }) => {
  await mockNonEnvironmentApi(page)
  await page.goto(appUrl)
  await page.getByRole('button', { name: 'Agent settings' }).click()
  const settings = page.locator('.agent-settings-page')
  await expect(settings.getByRole('heading', { name: 'Agent settings' })).toBeVisible()
  await settings.getByLabel('Account name').fill('Personal 1')
  await settings.getByRole('button', { name: 'Add account' }).click()
  await expect(settings.getByText('Personal 1', { exact: true })).toBeVisible()
  await expect(settings.getByRole('button', { name: 'Copy Personal 1 login command' })).toBeVisible()
})

test('configures a local model provider from Agent settings', async ({ page }) => {
  await mockNonEnvironmentApi(page)
  await page.goto(appUrl)
  await page.getByRole('button', { name: 'Agent settings' }).click()
  await page.getByLabel('Name', { exact: true }).fill('Ollama')
  await page.getByLabel('Base URL').fill('http://127.0.0.1:11434/v1')
  await page.getByLabel('Model ID').fill('qwen2.5-coder:7b')
  await page.getByRole('button', { name: 'Save provider' }).click()
  await expect(page.getByText('Configured Ollama · qwen2.5-coder:7b')).toBeVisible()
  const delegation = page.getByLabel('Delegate pre-commit regression locally')
  await delegation.check()
  await expect(delegation).toBeChecked()
})
