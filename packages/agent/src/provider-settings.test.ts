import assert from 'node:assert/strict'
import test from 'node:test'
import {
  localClaudeEnvironment,
  LOCAL_MODEL_ENV_KEY,
  LOCAL_MODEL_PROVIDER_ID,
  isLocalModel,
  localModelContextOverrides,
  validContextTokens,
  localModelCatalog,
  localModelId,
  localModelSelectionError,
  localModelProviderOverrides,
  modelProviderChanged,
  modelProviderId,
  normalizeLocalModelUrl,
  providerSettingsStatus,
} from './provider-settings.js'

test('rejects custom models for another agent or an obsolete configuration before launching', () => {
  const settings = { localModel: { agent: 'Claude' as const, name: 'Qwen', model: 'qwen-coder', baseUrl: 'http://localhost:1234' } }
  assert.match(localModelSelectionError(settings, 'Codex', 'relay-local:qwen-coder')!, /custom Codex model provider/)
  assert.equal(localModelSelectionError(settings, 'Claude', 'relay-local:qwen-coder'), undefined)
  assert.equal(localModelSelectionError(settings, 'Codex', 'gpt-6.1-sol'), undefined)
  assert.match(localModelSelectionError({}, 'Codex', 'relay-local:qwen-coder')!, /Configure/)
  assert.match(localModelSelectionError(settings, 'Claude', 'relay-local:old-model')!, /no longer configured/)
})

test('normalizes HTTP and HTTPS custom model endpoints', () => {
  assert.equal(normalizeLocalModelUrl(' http://127.0.0.1:11434/v1/ '), 'http://127.0.0.1:11434/v1')
  assert.equal(normalizeLocalModelUrl('http://localhost:1234/v1'), 'http://localhost:1234/v1')
  assert.equal(normalizeLocalModelUrl('http://[::1]:8080/v1'), 'http://[::1]:8080/v1')
  assert.equal(normalizeLocalModelUrl('https://models.example.com/v1/'), 'https://models.example.com/v1')
  assert.equal(normalizeLocalModelUrl('http://192.168.1.5:11434/v1'), 'http://192.168.1.5:11434/v1')
  assert.equal(normalizeLocalModelUrl('http://user:secret@localhost:1234/v1'), undefined)
  assert.equal(normalizeLocalModelUrl('http://localhost:1234/v1?token=secret'), undefined)
  assert.equal(normalizeLocalModelUrl('ftp://models.example.com/v1'), undefined)
})

test('builds a Responses provider without exposing its API key in arguments or status', () => {
  const settings = { localModel: { name: 'Local "Coder"', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5-coder:7b', apiKey: 'local-secret-1234' }, localRegressionEnabled: true }
  const overrides = localModelProviderOverrides(settings)
  assert.ok(overrides.some(value => value === `model_providers.${LOCAL_MODEL_PROVIDER_ID}.wire_api="responses"`))
  assert.ok(overrides.some(value => value.endsWith(`env_key="${LOCAL_MODEL_ENV_KEY}"`)))
  assert.equal(overrides.some(value => value.includes('local-secret-1234')), false)
  assert.equal(providerSettingsStatus(settings).localModel.keyHint, '…1234')
  assert.equal(providerSettingsStatus(settings).localRegressionEnabled, true)
})

test('uses an internal model prefix while preserving the provider model id', () => {
  const settings = { localModel: { name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5-coder:7b' } }
  const [model] = localModelCatalog(settings)
  assert.equal(model.model, 'relay-local:qwen2.5-coder:7b')
  assert.equal(isLocalModel(model.model), true)
  assert.equal(localModelId(model.model), 'qwen2.5-coder:7b')
})

test('detects model provider transitions that require a new thread', () => {
  assert.equal(modelProviderId('gpt-6.1-sol'), 'openai')
  assert.equal(modelProviderId('deepseek-flash'), 'deepseek')
  assert.equal(modelProviderId('relay-local:qwen2.5-coder:7b'), 'relay-local')
  assert.equal(modelProviderChanged('relay-local:qwen2.5-coder:7b', 'openai'), true)
  assert.equal(modelProviderChanged('gpt-6.1-sol', 'relay-local'), true)
  assert.equal(modelProviderChanged('gpt-6.1-sol', undefined), false)
  assert.equal(modelProviderChanged('relay-local:qwen2.5-coder:7b', 'relay-local'), false)
})


test('local context settings produce scoped Codex overrides and reject invalid sizes', () => {
  assert.deepEqual(localModelContextOverrides({ localModel: { name: 'Local', baseUrl: 'http://localhost/v1', model: 'test', contextWindow: 32768, autoCompactTokenLimit: 24576 } }), ['model_context_window=32768', 'model_auto_compact_token_limit=24576'])
  assert.deepEqual(localModelContextOverrides({}), [])
  for (const value of [0, -1, 1.5, 10000001, '32768']) assert.equal(validContextTokens(value), false)
  assert.equal(validContextTokens(32768), true)
})


test('routes custom models only to the configured runtime and preserves legacy Codex settings', () => {
  const local = { name: 'Gateway', baseUrl: 'http://localhost:8080', model: 'custom-model' }
  assert.equal(localModelCatalog({ localModel: local }).length, 1)
  assert.deepEqual(localModelCatalog({ localModel: local }, 'Claude'), [])
  const settings = { localModel: { ...local, agent: 'Claude' as const, apiKey: 'test-secret' } }
  assert.deepEqual(localModelCatalog(settings), [])
  assert.equal(localModelCatalog(settings, 'Claude')[0].model, 'relay-local:custom-model')
  assert.deepEqual(localModelProviderOverrides(settings), [])
  assert.equal(providerSettingsStatus(settings).localModel.agent, 'Claude')
  assert.equal(providerSettingsStatus({}).localModel.agent, 'Claude')
  assert.equal(providerSettingsStatus({ localModel: local }).localModel.agent, 'Codex')
  const env = localClaudeEnvironment(settings)
  assert.equal(env.ANTHROPIC_BASE_URL, local.baseUrl)
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'test-secret')
  assert.equal(env.ANTHROPIC_API_KEY, '')
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, '')
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, local.model)
  assert.deepEqual(localClaudeEnvironment({ localModel: local }), {})
  assert.equal(localClaudeEnvironment({ localModel: { ...local, agent: 'Claude' } }).ANTHROPIC_AUTH_TOKEN, 'relay-local')
})
