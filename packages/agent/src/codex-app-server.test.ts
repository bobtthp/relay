import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

test('restarts app-server once for concurrent quota requests when auth is stale', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-codex-auth-retry-'))
  const executable = path.join(directory, 'fake-codex.mjs')
  const launches = path.join(directory, 'launches')
  fs.writeFileSync(executable, `#!/usr/bin/env node
import fs from 'node:fs'
import readline from 'node:readline'
const launches = process.env.FAKE_CODEX_LAUNCHES
const launch = Number(fs.existsSync(launches) ? fs.readFileSync(launches, 'utf8') : '0') + 1
fs.writeFileSync(launches, String(launch))
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + '\\n')
  if (message.method === 'account/rateLimits/read') process.stdout.write(JSON.stringify(launch === 1
    ? { id: message.id, error: { code: 401, message: 'Unauthorized' } }
    : { id: message.id, result: { rateLimitsByLimitId: { codex: { primary: { usedPercent: 10 } } } } }) + '\\n')
})
`)
  fs.chmodSync(executable, 0o700)
  process.env.CODEX_BIN = executable
  process.env.FAKE_CODEX_LAUNCHES = launches
  const { CodexAppServer } = await import(`./codex-app-server.js?auth-retry=${Date.now()}`)
  const client = new CodexAppServer(() => ({ env: process.env, configOverrides: [] }))
  try {
    const results = await Promise.all([client.readRateLimits(), client.readRateLimits()])
    assert.equal(fs.readFileSync(launches, 'utf8'), '2')
    assert.deepEqual(results, Array(2).fill({ rateLimitsByLimitId: { codex: { primary: { usedPercent: 10 } } } }))
  } finally {
    client.stop()
    delete process.env.CODEX_BIN
    delete process.env.FAKE_CODEX_LAUNCHES
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('binds a custom model and provider when starting a thread', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-codex-provider-'))
  const executable = path.join(directory, 'fake-codex.mjs')
  const requests = path.join(directory, 'requests.jsonl')
  fs.writeFileSync(executable, `#!/usr/bin/env node
import fs from 'node:fs'
import readline from 'node:readline'
const requests = process.env.FAKE_CODEX_REQUESTS
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  fs.appendFileSync(requests, JSON.stringify(message) + '\\n')
  if (message.method === 'initialize') process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + '\\n')
  if (message.method === 'thread/start') process.stdout.write(JSON.stringify({ id: message.id, result: { thread: { id: 'thread-1' } } }) + '\\n')
  if (message.method === 'turn/start') process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + '\\n')
})
`)
  fs.chmodSync(executable, 0o700)
  process.env.CODEX_BIN = executable
  process.env.FAKE_CODEX_REQUESTS = requests
  const { CodexAppServer } = await import(`./codex-app-server.js?provider=${Date.now()}`)
  const client = new CodexAppServer(() => ({ env: process.env, configOverrides: [] }))
  try {
    const threadId = await client.startThread('/tmp/project', { model: 'qwen3.8:27b-mlx', modelProvider: 'relay-local' })
    await client.startTurn(threadId, 'hello', '/tmp/project', 'qwen3.8:27b-mlx')
    const messages = fs.readFileSync(requests, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { method: string; params: Record<string, unknown> })
    const start = messages.find(message => message.method === 'thread/start')
    assert.equal(start?.params.model, 'qwen3.8:27b-mlx')
    assert.equal(start?.params.modelProvider, 'relay-local')
    assert.equal(messages.find(message => message.method === 'turn/start')?.params.model, 'qwen3.8:27b-mlx')
  } finally {
    client.stop()
    delete process.env.CODEX_BIN
    delete process.env.FAKE_CODEX_REQUESTS
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
