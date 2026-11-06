import assert from 'node:assert/strict'
import test from 'node:test'
import {
  LOCAL_MODEL_ENV_KEY,
  LOCAL_MODEL_PROVIDER_ID,
  isLocalModel,
  localModelCatalog,
  localModelId,
  localModelProviderOverrides,
  normalizeLocalModelUrl,
  providerSettingsStatus,
} from './provider-settings.js'

test('normalizes only loopback HTTP model endpoints', () => {
  assert.equal(normalizeLocalModelUrl(' http://127.0.0.1:11434/v1/ '), 'http://127.0.0.1:11434/v1')
  assert.equal(normalizeLocalModelUrl('http://localhost:1234/v1'), 'http://localhost:1234/v1')
  assert.equal(normalizeLocalModelUrl('http://[::1]:8080/v1'), 'http://[::1]:8080/v1')
  assert.equal(normalizeLocalModelUrl('https://localhost:1234/v1'), undefined)
  assert.equal(normalizeLocalModelUrl('http://192.168.1.5:11434/v1'), undefined)
  assert.equal(normalizeLocalModelUrl('http://user:secret@localhost:1234/v1'), undefined)
  assert.equal(normalizeLocalModelUrl('http://localhost:1234/v1?token=secret'), undefined)
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
