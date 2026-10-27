import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

test('creates, resolves and deletes a project-scoped upload link', async () => {
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-image-share-test-'))
  process.env.RELAY_DATA_DIR = dataDirectory
  const shares = await import(`./project-image-shares.js?test=${Date.now()}`)
  const projectId = 'project-0123456789abcdef'
  const share = shares.createProjectImageShare(projectId)
  assert.match(share.token, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(shares.projectIdForImageShare(share.token), projectId)
  assert.equal(shares.projectImageShare(projectId)?.token, share.token)
  shares.deleteProjectImageShare(projectId)
  assert.equal(shares.projectIdForImageShare(share.token), undefined)
  fs.rmSync(dataDirectory, { recursive: true, force: true })
  delete process.env.RELAY_DATA_DIR
})
