import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

test('stores any number of named agent accounts without storing credentials', async () => {
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-agent-accounts-'))
  process.env.RELAY_DATA_DIR = dataDirectory
  const accounts = await import(`./agent-accounts.js?test=${Date.now()}`)
  const first = accounts.createAgentAccount('个人 1', 'Codex')
  const second = accounts.createAgentAccount('个人 2', 'Codex')
  const claude = accounts.createAgentAccount('个人 1', 'Claude')
  assert.equal(accounts.listAgentAccounts().length, 5)
  assert.equal(accounts.agentAccount(first.id, 'Codex')?.name, '个人 1')
  assert.equal(accounts.agentAccount(second.id, 'Codex')?.configDirectory.startsWith(dataDirectory), true)
  assert.equal(accounts.agentAccountEnvironment(first).CODEX_HOME, first.configDirectory)
  assert.equal(accounts.agentAccountEnvironment(claude).CLAUDE_CONFIG_DIR, claude.configDirectory)
  assert.match(accounts.agentAccountLoginCommand(claude), /^CLAUDE_CONFIG_DIR=/)
  const stored = fs.readFileSync(path.join(dataDirectory, 'agent-accounts.json'), 'utf8')
  assert.equal(/token|password|secret/i.test(stored), false)
  accounts.deleteAgentAccount(first.id)
  assert.equal(accounts.agentAccount(first.id, 'Codex'), undefined)
  assert.equal(fs.existsSync(first.configDirectory), true)
  fs.rmSync(dataDirectory, { recursive: true, force: true })
  delete process.env.RELAY_DATA_DIR
})
