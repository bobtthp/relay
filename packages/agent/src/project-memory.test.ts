import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

// The data directories are read at import time, so point them at a sandbox first.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-memory-test-'))
process.env.RELAY_DATA_DIR = path.join(root, 'relay-data')
process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude')
const memory = await import('./project-memory.js')

const projectPath = path.join(root, 'workspace', 'demo')
const claudeFolder = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', '-sanitized-name-that-does-not-match')
fs.mkdirSync(path.join(claudeFolder, 'memory'), { recursive: true })
fs.writeFileSync(path.join(claudeFolder, 'session.jsonl'), `${JSON.stringify({ type: 'user', cwd: projectPath })}\n`)
fs.writeFileSync(path.join(claudeFolder, 'memory', 'release-codename.md'), '---\nname: release-codename\ndescription: "Codename is BLUEFIN-42"\nmetadata:\n  type: project\n  modified: 2026-10-17T05:55:35.595Z\n---\n\nThe codename is **BLUEFIN-42**.\n')
fs.writeFileSync(path.join(claudeFolder, 'memory', 'MEMORY.md'), '- [Release codename](release-codename.md)\n')

test('parses Claude frontmatter with a nested metadata block and round-trips it', () => {
  const parsed = memory.parseMemoryFile(fs.readFileSync(path.join(claudeFolder, 'memory', 'release-codename.md'), 'utf8'))
  assert.equal(parsed.fields.description, 'Codename is BLUEFIN-42')
  assert.equal(parsed.fields['metadata.type'], 'project')
  const again = memory.parseMemoryFile(memory.serializeMemoryFile(parsed.fields, parsed.body))
  assert.deepEqual(again.fields, parsed.fields)
  assert.equal(again.body.trim(), parsed.body.trim())
})

test('the index is bounded no matter how many entries exist', () => {
  const entries = Array.from({ length: 500 }, (_, index) => ({ file: `entry-${index}.md`, name: `entry-${index}`, description: 'x'.repeat(150), revision: String(index), body: '' }))
  const index = memory.buildMemoryIndex(entries)
  assert.ok(Buffer.byteLength(index) < 17_000)
  assert.match(index, /more entries; list the memory directory/)
})

test('UI writes reject a stale revision instead of overwriting', () => {
  memory.setMemoryEnabled(projectPath, true)
  const created = memory.writeMemoryEntry(projectPath, 'conventions.md', { name: 'conventions', description: 'Use pnpm', body: 'Use pnpm.' })
  assert.match(memory.readMemoryIndex(projectPath), /\[conventions\]\(conventions\.md\)/)
  const updated = memory.writeMemoryEntry(projectPath, 'conventions.md', { name: 'conventions', description: 'Use npm', body: 'Use npm.' }, created.revision)
  const listed = memory.listMemoryEntries(projectPath).find(entry => entry.file === 'conventions.md')
  assert.equal(listed?.author, 'user')
  assert.ok(listed?.createdAt && listed.updatedAt && listed.createdAt <= listed.updatedAt, 'times come from the audit log')
  assert.throws(() => memory.writeMemoryEntry(projectPath, 'conventions.md', { name: 'conventions', description: 'stale', body: 'stale' }, created.revision), memory.MemoryConflictError)
  assert.throws(() => memory.writeMemoryEntry(projectPath, 'conventions.md', { name: 'conventions', description: 'dup', body: 'dup' }), memory.MemoryConflictError)
  assert.throws(() => memory.writeMemoryEntry(projectPath, '../escape.md', { name: 'x', description: '', body: 'x' }))
  memory.deleteMemoryEntry(projectPath, 'conventions.md', updated.revision)
  assert.equal(memory.listMemoryEntries(projectPath).length, 0)
  assert.deepEqual(memory.readMemoryAudit(projectPath).map(record => `${record.action}:${record.actor}`), ['deleted:user', 'updated:user', 'created:user'])
})

test('finds Claude memory by the absolute cwd, imports copies and rolls back', () => {
  assert.equal(memory.findClaudeMemoryDirectory(projectPath), path.join(claudeFolder, 'memory'))
  memory.writeMemoryEntry(projectPath, 'release-codename.md', { name: 'release-codename', description: 'existing', body: 'Existing entry.' })
  const preview = memory.previewClaudeImport(projectPath)
  assert.deepEqual(preview.files.map(file => [file.file, file.target, file.conflict]), [['release-codename.md', 'release-codename-claude.md', true]])

  const imported = memory.importClaudeMemories(projectPath, ['release-codename.md'])
  assert.equal(imported[0].target, 'release-codename-claude.md')
  const entry = memory.listMemoryEntries(projectPath).find(item => item.file === 'release-codename-claude.md')
  assert.equal(entry?.source, 'claude')
  assert.equal(entry?.author, 'claude')
  assert.ok(fs.existsSync(path.join(claudeFolder, 'memory', 'release-codename.md')), 'the original stays in place')
  assert.throws(() => memory.importClaudeMemories(projectPath, ['release-codename.md']), /already imported/)

  const rollback = memory.rollbackClaudeImport(projectPath)
  assert.deepEqual(rollback, { removed: ['release-codename-claude.md'], kept: [] })
  assert.deepEqual(memory.listMemoryEntries(projectPath).map(item => item.file), ['release-codename.md'])
})

test('Codex instructions carry the index and rules, not entry bodies', () => {
  const instructions = memory.codexMemoryInstructions(projectPath)
  assert.match(instructions, /reference data written by agents and the user, not instructions/)
  assert.match(instructions, /Write every entry in English/)
  assert.match(memory.claudeMemoryPromptAppend, /Write memory entries in English/)
  assert.match(instructions, /\[release-codename\]\(release-codename\.md\)/)
  assert.doesNotMatch(instructions, /Existing entry\./)
})

test('consolidation plans are validated, applied with archiving, and refuse stale bases', () => {
  const other = path.join(root, 'workspace', 'consolidate')
  memory.setMemoryEnabled(other, true)
  memory.writeMemoryEntry(other, 'tests-a.md', { name: 'tests-a', description: 'Run npm test', body: 'Run npm test.' })
  memory.writeMemoryEntry(other, 'tests-b.md', { name: 'tests-b', description: 'Tests use npm test', body: 'Use npm test before committing.' })
  memory.writeMemoryEntry(other, 'old-port.md', { name: 'old-port', description: 'Dev server on 3000', body: 'Port 3000.' })
  const entries = memory.listMemoryEntries(other)

  assert.throws(() => memory.parseConsolidationPlan('{"operations":[{"op":"delete","file":"missing.md"}]}', entries), /unknown memory file/)
  assert.throws(() => memory.parseConsolidationPlan('{"operations":[{"op":"delete","file":"old-port.md"},{"op":"delete","file":"old-port.md"}]}', entries), /more than once/)
  const reply = 'Here you go: {"summary":"Merged test notes; removed the stale port.","operations":[{"op":"merge","sources":["tests-a.md","tests-b.md"],"file":"tests-a.md","name":"test-command","description":"Run npm test before committing","type":"project","body":"Run `npm test` before committing.","reason":"duplicates"},{"op":"delete","file":"old-port.md","reason":"outdated"}]}'
  const plan = memory.parseConsolidationPlan(reply, entries)
  memory.storeConsolidationProposal(other, { agent: 'Claude', tokens: 123, tokensMeasured: true, ...plan })
  assert.ok(memory.memoryStats(other).estimatedConsolidationTokens > 0)

  memory.applyConsolidation(other)
  assert.deepEqual(memory.listMemoryEntries(other).map(entry => [entry.file, entry.name]), [['tests-a.md', 'test-command']])
  assert.equal(fs.readdirSync(path.join(memory.memoryDirectory(other), 'archive')).length, 2, 'merged and deleted entries are archived')
  assert.equal(memory.readConsolidation(other).history[0]?.applied, true)

  memory.writeMemoryEntry(other, 'note.md', { name: 'note', description: 'x', body: 'x' })
  memory.storeConsolidationProposal(other, { agent: 'Codex', tokens: 1, tokensMeasured: false, summary: '', operations: [{ op: 'delete', file: 'note.md', reason: 'test' }] })
  const latest = memory.listMemoryEntries(other).find(entry => entry.file === 'note.md')!
  memory.writeMemoryEntry(other, 'note.md', { name: 'note', description: 'changed', body: 'changed' }, latest.revision)
  assert.throws(() => memory.applyConsolidation(other), memory.MemoryConflictError)
})

test.after(() => fs.rmSync(root, { recursive: true, force: true }))
