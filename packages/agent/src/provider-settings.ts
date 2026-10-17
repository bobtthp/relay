import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type ProviderSettings = {
  deepseekApiKey?: string
  /** HTTP(S) proxy for agent traffic. Background services do not inherit a shell's proxy variables. */
  httpProxy?: string
}

export type ProviderSettingsStatus = {
  deepseek: { configured: boolean; source: 'relay' | 'environment' | null; keyHint: string | null }
  proxy: { url: string | null; systemProxy: string | null }
}

const dataDirectory = process.env.RELAY_DATA_DIR ?? path.join(os.homedir(), '.relay-web')
const settingsPath = path.join(dataDirectory, 'provider-settings.json')

export const DEEPSEEK_PROVIDER_ID = 'deepseek'
export const DEEPSEEK_ENV_KEY = 'DEEPSEEK_API_KEY'

// Relay defines the provider itself so DeepSeek works without editing
// ~/.codex/config.toml. DeepSeek serves the Responses API that Codex requires.
export const deepseekProviderOverrides = [
  `model_providers.${DEEPSEEK_PROVIDER_ID}.name="DeepSeek"`,
  `model_providers.${DEEPSEEK_PROVIDER_ID}.base_url="https://api.deepseek.com/"`,
  `model_providers.${DEEPSEEK_PROVIDER_ID}.wire_api="responses"`,
  `model_providers.${DEEPSEEK_PROVIDER_ID}.env_key="${DEEPSEEK_ENV_KEY}"`,
]

const deepseekReasoningEfforts = [
  { reasoningEffort: 'low', description: 'Fast responses with lighter reasoning' },
  { reasoningEffort: 'high', description: 'Extra high reasoning depth for complex problems' },
  { reasoningEffort: 'max', description: 'Maximum reasoning depth for the hardest problems' },
]

export const deepseekModels = [
  { id: 'deepseek-flash', model: 'deepseek-flash', displayName: 'DeepSeek-Flash', description: 'DeepSeek frontier agentic coding model with image input.', provider: DEEPSEEK_PROVIDER_ID, defaultReasoningEffort: 'high', supportedReasoningEfforts: deepseekReasoningEfforts },
  { id: 'deepseek-v4-pro', model: 'deepseek-v4-pro', displayName: 'DeepSeek-V4-Pro', description: 'Most capable DeepSeek agentic coding model.', provider: DEEPSEEK_PROVIDER_ID, defaultReasoningEffort: 'high', supportedReasoningEfforts: deepseekReasoningEfforts },
]

export const isDeepSeekModel = (model?: string) => model?.toLowerCase().startsWith('deepseek-') === true

export function readProviderSettings(): ProviderSettings {
  try {
    const stored = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Partial<ProviderSettings>
    return {
      ...(typeof stored.deepseekApiKey === 'string' && stored.deepseekApiKey ? { deepseekApiKey: stored.deepseekApiKey } : {}),
      ...(typeof stored.httpProxy === 'string' && normalizeProxyUrl(stored.httpProxy) ? { httpProxy: normalizeProxyUrl(stored.httpProxy) } : {}),
    }
  } catch {
    return {}
  }
}

export function writeProviderSettings(settings: ProviderSettings) {
  fs.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 })
  const temporaryPath = `${settingsPath}.tmp`
  fs.writeFileSync(temporaryPath, JSON.stringify(settings, null, 2), { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(temporaryPath, settingsPath)
  fs.chmodSync(settingsPath, 0o600)
}

/** The key Codex will see: one saved in Relay wins over the inherited environment. */
export const effectiveDeepSeekKey = (settings: ProviderSettings) => settings.deepseekApiKey || process.env[DEEPSEEK_ENV_KEY] || undefined

/** Returns a canonical http(s)://host:port URL, or undefined when the value is not one. */
export function normalizeProxyUrl(value: string) {
  try {
    const url = new URL(value.trim())
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname || url.pathname.length > 1 || url.search || url.hash) return undefined
    return `${url.protocol}//${url.username ? `${url.username}${url.password ? `:${url.password}` : ''}@` : ''}${url.host}`
  } catch { return undefined }
}

/** The macOS HTTPS (or HTTP) proxy from System Settings, e.g. one a proxy app enables. */
export function detectSystemProxy() {
  try {
    const output = execFileSync('scutil', ['--proxy'], { encoding: 'utf8', timeout: 2_000 })
    const value = (key: string) => output.match(new RegExp(`\\b${key}\\s*:\\s*(\\S+)`))?.[1]
    for (const scheme of ['HTTPS', 'HTTP']) {
      if (value(`${scheme}Enable`) !== '1') continue
      const host = value(`${scheme}Proxy`)
      const port = value(`${scheme}Port`)
      if (host && port) return `http://${host}:${port}`
    }
  } catch { /* Not macOS, or no proxy configured. */ }
  return null
}

/** Proxy variables for agent subprocesses; local traffic (Relay, the app-server) bypasses it. */
export const proxyEnvironment = (settings: ProviderSettings): Record<string, string> => settings.httpProxy ? {
  HTTPS_PROXY: settings.httpProxy,
  HTTP_PROXY: settings.httpProxy,
  https_proxy: settings.httpProxy,
  http_proxy: settings.httpProxy,
  NO_PROXY: 'localhost,127.0.0.1,::1',
  no_proxy: 'localhost,127.0.0.1,::1',
} : {}

const maskProxy = (url: string) => url.replace(/\/\/([^:@/]+)(?::[^@/]*)?@/, '//$1:***@')

export function providerSettingsStatus(settings: ProviderSettings): ProviderSettingsStatus {
  const key = effectiveDeepSeekKey(settings)
  return {
    deepseek: {
      configured: Boolean(key),
      source: settings.deepseekApiKey ? 'relay' : key ? 'environment' : null,
      keyHint: key ? `…${key.slice(-4)}` : null,
    },
    proxy: { url: settings.httpProxy ? maskProxy(settings.httpProxy) : null, systemProxy: detectSystemProxy() },
  }
}
