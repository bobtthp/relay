import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { discoverRegressionSteps, isGitCommitCommand, parseRegressionVerdict, redactRegressionOutput, regressionReviewPrompt, runRegressionStep } from './local-regression.js'

test('detects git commit without treating ordinary git commands as a gate', () => {
  assert.equal(isGitCommitCommand('git commit -m "Add feature"'), true)
  assert.equal(isGitCommitCommand('npm test && git -C /tmp/project commit -am fix'), true)
  assert.equal(isGitCommitCommand('/usr/bin/git -c user.name=Relay commit -m fix'), true)
  assert.equal(isGitCommitCommand('git status --short'), false)
  assert.equal(isGitCommitCommand('echo git commit'), false)
})

test('discovers the shared CI entry before package scripts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-regression-'))
  fs.mkdirSync(path.join(root, 'scripts'))
  fs.writeFileSync(path.join(root, 'scripts/ci-local.mjs'), '')
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { check: 'tsc' } }))
  assert.deepEqual(discoverRegressionSteps(root), [{ label: 'ci-local', command: 'node scripts/ci-local.mjs' }])
  fs.rmSync(root, { recursive: true, force: true })
})

test('captures a bounded regression result and parses a strict verdict', async () => {
  const result = await runRegressionStep({ label: 'check', command: 'printf ok' }, process.cwd(), 5_000)
  assert.equal(result.passed, true)
  assert.equal(result.outputTail, 'ok')
  assert.deepEqual(parseRegressionVerdict('{"verdict":"PASS","summary":"All checks passed."}'), { verdict: 'PASS', summary: 'All checks passed.' })
  assert.equal(parseRegressionVerdict('{"verdict":"PASS"}'), undefined)
})

test('redacts secrets and sends only noteworthy output from passing checks', () => {
  assert.equal(redactRegressionOutput('Authorization: Bearer abc123\nAPI_KEY=secret-value\nsk-abcdefghijklmnop'), 'Authorization: Bearer ***\nAPI_KEY=***\n***')
  const prompt = regressionReviewPrompt([{ label: 'test', command: 'npm test', passed: true, exitCode: 0, durationMs: 12, timedOut: false, outputTail: 'ordinary noisy line\nwarning: one test was skipped' }])
  assert.doesNotMatch(prompt, /ordinary noisy line/)
  assert.match(prompt, /warning: one test was skipped/)
})
