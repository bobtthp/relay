import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AgentName } from '../../protocol/src/types.js'

export type AgentAccount = {
  id: string
  name: string
  agent: AgentName
  configDirectory: string
  isDefault?: boolean
  createdAt: string
}

const dataDirectory = process.env.RELAY_DATA_DIR ?? path.join(os.homedir(), '.relay-web')
const accountsPath = path.join(dataDirectory, 'agent-accounts.json')
const managedAccountsRoot = path.join(dataDirectory, 'agent-accounts')

const defaultAccounts = (): AgentAccount[] => [
  { id: 'codex-default', name: 'Codex 默认账号', agent: 'Codex', configDirectory: process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), isDefault: true, createdAt: new Date(0).toISOString() },
  { id: 'claude-default', name: 'Claude 默认账号', agent: 'Claude', configDirectory: process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), isDefault: true, createdAt: new Date(0).toISOString() },
]

const readStoredAccounts = (): AgentAccount[] => {
  try {
    const value = JSON.parse(fs.readFileSync(accountsPath, 'utf8')) as unknown
    if (!Array.isArray(value)) return []
    return value.filter((item): item is AgentAccount => {
      if (!item || typeof item !== 'object') return false
      const account = item as Partial<AgentAccount>
      return typeof account.id === 'string' && /^account-[a-f0-9-]{36}$/.test(account.id)
        && typeof account.name === 'string' && (account.agent === 'Codex' || account.agent === 'Claude')
        && typeof account.configDirectory === 'string' && path.isAbsolute(account.configDirectory)
        && typeof account.createdAt === 'string'
    })
  } catch { return [] }
}

const writeStoredAccounts = (accounts: AgentAccount[]) => {
  fs.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 })
  const temporaryPath = `${accountsPath}.tmp`
  fs.writeFileSync(temporaryPath, JSON.stringify(accounts, null, 2), { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(temporaryPath, accountsPath)
  fs.chmodSync(accountsPath, 0o600)
}

export const listAgentAccounts = () => [...defaultAccounts(), ...readStoredAccounts()]

export const agentAccount = (id: string | undefined, agent?: AgentName) => {
  const fallbackId = agent === 'Claude' ? 'claude-default' : 'codex-default'
  return listAgentAccounts().find(account => account.id === (id || fallbackId) && (!agent || account.agent === agent))
}

export const createAgentAccount = (name: string, agent: AgentName) => {
  const normalizedName = name.trim().replace(/\s+/g, ' ')
  if (!normalizedName || normalizedName.length > 80) throw new Error('Account name must be 1–80 characters')
  const accounts = readStoredAccounts()
  if (accounts.some(account => account.agent === agent && account.name.toLocaleLowerCase() === normalizedName.toLocaleLowerCase())) throw new Error('An account with this name already exists')
  const id = `account-${randomUUID()}`
  const configDirectory = path.join(managedAccountsRoot, id)
  fs.mkdirSync(configDirectory, { recursive: true, mode: 0o700 })
  fs.chmodSync(configDirectory, 0o700)
  const account: AgentAccount = { id, name: normalizedName, agent, configDirectory, createdAt: new Date().toISOString() }
  accounts.push(account)
  writeStoredAccounts(accounts)
  return account
}

export const deleteAgentAccount = (id: string) => {
  if (id === 'codex-default' || id === 'claude-default') throw new Error('The default account cannot be removed')
  const accounts = readStoredAccounts()
  if (!accounts.some(account => account.id === id)) throw new Error('Account not found')
  writeStoredAccounts(accounts.filter(account => account.id !== id))
}

export const agentAccountEnvironment = (account: AgentAccount): NodeJS.ProcessEnv => ({
  ...process.env,
  ...(account.agent === 'Codex' ? { CODEX_HOME: account.configDirectory } : { CLAUDE_CONFIG_DIR: account.configDirectory }),
})

export const agentAccountLoginCommand = (account: AgentAccount) => account.agent === 'Codex'
  ? `CODEX_HOME=${JSON.stringify(account.configDirectory)} codex login`
  : `CLAUDE_CONFIG_DIR=${JSON.stringify(account.configDirectory)} claude`
