import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type ProviderSettings = {
  deepseekApiKey?: string
  localModel?: {
    agent?: 'Codex' | 'Claude'
    name: string
    baseUrl: string
    model: string
    apiKey?: string
    contextWindow?: number
    autoCompactTokenLimit?: number
  }
  /** Gate git commit approvals on deterministic checks reviewed by the configured custom model. */
  localRegressionEnabled?: boolean
  /** HTTP(S) proxy for agent traffic. Background services do not inherit a shell's proxy variables. */
  httpProxy?: string
  /** Ask agents to keep a per-task checkpoint so a switched-in agent knows the progress. Costs tokens. */
  checkpointsEnabled?: boolean
}

export type ProviderSettingsStatus = {
  deepseek: { configured: boolean; source: 'relay' | 'environment' | null; keyHint: string | null }
  localModel: { agent: 'Codex' | 'Claude'; configured: boolean; name: string | null; baseUrl: string | null; model: string | null; keyHint: string | null; contextWindow: number | null; autoCompactTokenLimit: number | null }
  localRegressionEnabled: boolean
  proxy: { url: string | null; systemProxy: string | null }
  checkpointsEnabled: boolean
}

const dataDirectory = process.env.RELAY_DATA_DIR ?? path.join(os.homedir(), '.relay-web')
const settingsPath = path.join(dataDirectory, 'provider-settings.json')

export const DEEPSEEK_PROVIDER_ID = 'deepseek'
export const DEEPSEEK_ENV_KEY = 'DEEPSEEK_API_KEY'
export const LOCAL_MODEL_PROVIDER_ID = 'relay-local'
export const LOCAL_MODEL_ENV_KEY = 'RELAY_LOCAL_MODEL_API_KEY'
export const LOCAL_MODEL_PREFIX = 'relay-local:'

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
export const isLocalModel = (model?: string) => model?.startsWith(LOCAL_MODEL_PREFIX) === true
export const localModelId = (model?: string) => isLocalModel(model) ? model!.slice(LOCAL_MODEL_PREFIX.length) : model
export const modelProviderId = (model?: string) => isDeepSeekModel(model)
  ? DEEPSEEK_PROVIDER_ID
  : isLocalModel(model) ? LOCAL_MODEL_PROVIDER_ID : 'openai'
export const modelProviderChanged = (model: string | undefined, threadProvider?: string) => modelProviderId(model) !== (threadProvider ?? 'openai')

export const validContextTokens = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 10000000

const tomlString = (value: string) => JSON.stringify(value)

export function normalizeLocalModelUrl(value: string) {
  try {
    const url = new URL(value.trim())
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname || url.username || url.password || url.search || url.hash) return undefined
    const pathname = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '')
    return `${url.protocol}//${url.host}${pathname}`
  } catch { return undefined }
}

export function localModelProviderOverrides(settings: ProviderSettings) {
  const local = settings.localModel
  if (!local || local.agent === 'Claude') return []
  return [
    `model_providers.${LOCAL_MODEL_PROVIDER_ID}.name=${tomlString(local.name)}`,
    `model_providers.${LOCAL_MODEL_PROVIDER_ID}.base_url=${tomlString(local.baseUrl)}`,
    `model_providers.${LOCAL_MODEL_PROVIDER_ID}.wire_api="responses"`,
    `model_providers.${LOCAL_MODEL_PROVIDER_ID}.requires_openai_auth=false`,
    `model_providers.${LOCAL_MODEL_PROVIDER_ID}.supports_websockets=false`,
    ...(local.apiKey ? [`model_providers.${LOCAL_MODEL_PROVIDER_ID}.env_key="${LOCAL_MODEL_ENV_KEY}"`] : []),
  ]
}

export function localModelContextOverrides(settings: ProviderSettings) {
  const local = settings.localModel
  return [
    ...(local?.contextWindow ? [`model_context_window=${local.contextWindow}`] : []),
    ...(local?.autoCompactTokenLimit ? [`model_auto_compact_token_limit=${local.autoCompactTokenLimit}`] : []),
  ]
}

export function localModelCatalog(settings: ProviderSettings, agent: 'Codex' | 'Claude' = 'Codex') {
  const local = settings.localModel
  if (!local || (local.agent ?? 'Codex') !== agent) return []
  return [{
    id: `${LOCAL_MODEL_PREFIX}${local.model}`,
    model: `${LOCAL_MODEL_PREFIX}${local.model}`,
    displayName: `${local.name} · ${local.model}`,
    description: `Custom ${agent === 'Claude' ? 'Messages' : 'Responses'} API at ${local.baseUrl}`,
    agent,
    provider: LOCAL_MODEL_PROVIDER_ID,
  }]
}

export function readProviderSettings(): ProviderSettings {
  try {
    const stored = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Partial<ProviderSettings>
    return {
      ...(typeof stored.deepseekApiKey === 'string' && stored.deepseekApiKey ? { deepseekApiKey: stored.deepseekApiKey } : {}),
      ...(stored.localModel
        && typeof stored.localModel.name === 'string'
        && typeof stored.localModel.model === 'string'
        && typeof stored.localModel.baseUrl === 'string'
        && normalizeLocalModelUrl(stored.localModel.baseUrl)
        ? { localModel: { agent: stored.localModel.agent === 'Claude' ? 'Claude' : 'Codex', name: stored.localModel.name, model: stored.localModel.model, baseUrl: normalizeLocalModelUrl(stored.localModel.baseUrl)!, ...(validContextTokens(stored.localModel.contextWindow) ? { contextWindow: stored.localModel.contextWindow } : {}), ...(validContextTokens(stored.localModel.autoCompactTokenLimit) && (!stored.localModel.contextWindow || stored.localModel.autoCompactTokenLimit < stored.localModel.contextWindow) ? { autoCompactTokenLimit: stored.localModel.autoCompactTokenLimit } : {}), ...(typeof stored.localModel.apiKey === 'string' && stored.localModel.apiKey ? { apiKey: stored.localModel.apiKey } : {}) } }
        : {}),
      ...(stored.localRegressionEnabled === true ? { localRegressionEnabled: true } : {}),
      ...(typeof stored.httpProxy === 'string' && normalizeProxyUrl(stored.httpProxy) ? { httpProxy: normalizeProxyUrl(stored.httpProxy) } : {}),
      ...(stored.checkpointsEnabled === true ? { checkpointsEnabled: true } : {}),
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
    localModel: settings.localModel ? {
      configured: true,
      agent: settings.localModel.agent ?? 'Codex',
      name: settings.localModel.name,
      baseUrl: settings.localModel.baseUrl,
      model: settings.localModel.model,
      contextWindow: settings.localModel.contextWindow ?? null,
      autoCompactTokenLimit: settings.localModel.autoCompactTokenLimit ?? null,
      keyHint: settings.localModel.apiKey ? `…${settings.localModel.apiKey.slice(-4)}` : null,
    } : { agent: 'Claude', configured: false, name: null, baseUrl: null, model: null, keyHint: null, contextWindow: null, autoCompactTokenLimit: null },
    localRegressionEnabled: settings.localRegressionEnabled === true && Boolean(settings.localModel),
    proxy: { url: settings.httpProxy ? maskProxy(settings.httpProxy) : null, systemProxy: detectSystemProxy() },
    checkpointsEnabled: settings.checkpointsEnabled === true,
  }
}

/** Credentials are scoped to the custom Claude runner, never the official account runner. */
export function localClaudeEnvironment(settings: ProviderSettings): NodeJS.ProcessEnv {
  const local = settings.localModel
  if (!local || local.agent !== 'Claude') return {}
  return {
    ANTHROPIC_BASE_URL: local.baseUrl,
    ANTHROPIC_AUTH_TOKEN: local.apiKey ?? 'relay-local',
    ANTHROPIC_API_KEY: '',
    CLAUDE_CODE_OAUTH_TOKEN: '',
    ANTHROPIC_MODEL: local.model,
    ANTHROPIC_SMALL_FAST_MODEL: local.model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: local.model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: local.model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: local.model,
  }
}
