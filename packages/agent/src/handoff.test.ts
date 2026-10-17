import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { SessionEvent } from '../../protocol/src/types.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-handoff-test-'))
process.env.RELAY_DATA_DIR = path.join(root, 'relay-data')
const handoff = await import('./handoff.js')

const projectPath = path.join(root, 'repo')
fs.mkdirSync(projectPath)
execFileSync('git', ['init', '-q'], { cwd: projectPath })
fs.writeFileSync(path.join(projectPath, 'notes.txt'), 'step1\n')

let sequence = 0
const event = (type: SessionEvent['type'], payload: Record<string, unknown>): SessionEvent => ({ id: `e${++sequence}`, taskId: 'task-1', type, payload, sequence, createdAt: new Date().toISOString() })
const events = [
  event('user_message', { text: 'Create notes.txt with step1' }),
  event('assistant_message', { method: 'item/agentMessage/delta', itemId: 'm1', text: 'Creating ', agent: 'Codex' }),
  event('assistant_message', { method: 'item/agentMessage/delta', itemId: 'm1', text: 'the file now.', agent: 'Codex' }),
  event('file_change', { method: 'relay/progress', progressState: 'completed', logType: 'change', text: 'update: notes.txt\n\n```diff\n+step1\n```' }),
  event('assistant_message', { method: 'relay/progress', progressState: 'completed', logType: 'error', text: 'Finished command: npm test (exit 1)\n\nmissing script' }),
  event('error', { text: 'You have hit your usage limit.' }),
]

test('builds a handoff from recorded facts without the previous agent', () => {
  const text = handoff.buildHandoff({ from: 'Codex', to: 'Claude', projectPath, taskId: 'task-1', events })
  assert.match(text, /^<relay_handoff to="Claude">/)
  assert.match(text, /after it hit a usage limit/)
  assert.match(text, /- User: Create notes\.txt with step1/)
  assert.match(text, /- Codex: Creating the file now\./, 'streamed deltas are joined into one reply')
  assert.match(text, /## Files the previous agent changed\n- notes\.txt/)
  assert.match(text, /FAILED Finished command: npm test \(exit 1\)/)
  assert.match(text, /\?\? notes\.txt/, 'includes the working tree status')
})

test('includes the checkpoint and stays bounded', () => {
  fs.mkdirSync(handoff.checkpointDirectory(projectPath), { recursive: true })
  fs.writeFileSync(handoff.checkpointPath(projectPath, 'task-1'), 'Goal: notes file\nNext: run tests')
  const many = Array.from({ length: 200 }, () => event('user_message', { text: 'x'.repeat(2_000) }))
  const text = handoff.buildHandoff({ from: 'Claude', to: 'Codex', projectPath, taskId: 'task-1', events: many })
  assert.match(text, /## Checkpoint written by the previous agent\nGoal: notes file/)
  assert.ok(text.length < 9_500, `handoff was ${text.length} characters`)
})

test('the checkpoint rule names the task file', () => {
  assert.match(handoff.checkpointRule(projectPath, 'task/1'), /checkpoints\/task_1\.md/)
})

test.after(() => fs.rmSync(root, { recursive: true, force: true }))
