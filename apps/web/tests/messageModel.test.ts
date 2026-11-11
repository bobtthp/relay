import assert from 'node:assert/strict'
import test from 'node:test'
import { messageModelSelection } from '../src/services/messageModel.js'

const local = { configured: true, agent: 'Codex' as const, model: 'qwen-coder' }

test('ordinary follow-up messages preserve the selected model with push override enabled', () => {
  for (const agent of ['Codex', 'Claude'] as const) {
    for (const enabled of [true, false]) {
      assert.deepEqual(messageModelSelection('message', agent, 'selected-model', 'high', enabled, local), { model: 'selected-model', effort: 'high' })
    }
  }
  assert.equal(messageModelSelection('message', 'Codex', 'relay-local:qwen-coder', '', true, local).model, 'relay-local:qwen-coder')
})

test('only explicit push requests use the configured local model', () => {
  assert.deepEqual(messageModelSelection('push', 'Codex', 'sol', 'high', true, local), { model: 'relay-local:qwen-coder', effort: '' })
  assert.deepEqual(messageModelSelection('push', 'Codex', 'sol', 'high', false, local), { model: 'sol', effort: 'high' })
  assert.throws(() => messageModelSelection('push', 'Claude', 'sonnet', '', true, local), /switch agents/)
  assert.throws(() => messageModelSelection('push', 'Codex', 'sol', '', true, { ...local, configured: false }), /configure a local model/)
})
