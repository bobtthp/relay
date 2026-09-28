import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

test('project state is stored outside the project directory', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-cache-test-'))
  process.env.RELAY_DATA_DIR = temporary
  const { loadProjectCache, saveProjectCache } = await import('./project-cache.js')
  const projectPath = path.join(temporary, 'project')
  fs.mkdirSync(projectPath)
  const state = { tasks: [], events: [] }
  saveProjectCache(projectPath, state)
  assert.deepEqual(loadProjectCache(projectPath), state)
  assert.equal(fs.existsSync(path.join(projectPath, '.relay')), false)
  fs.rmSync(temporary, { recursive: true, force: true })
})
