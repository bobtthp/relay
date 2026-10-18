import assert from 'node:assert/strict'
import test from 'node:test'
import { claudeRateLimitCacheIsFresh, type ClaudeRateLimits } from './claude-runner.js'

const limits = (primaryReset: number, secondaryReset: number): ClaudeRateLimits => ({
  primary: { usedPercent: 75, windowDurationMins: 300, resetsAt: primaryReset },
  secondary: { usedPercent: 25, windowDurationMins: 10_080, resetsAt: secondaryReset },
})

test('Claude rate-limit cache expires as soon as either quota window resets', () => {
  const now = 2_000_000
  assert.equal(claudeRateLimitCacheIsFresh(now - 1_000, limits((now + 60_000) / 1_000, (now + 120_000) / 1_000), now), true)
  assert.equal(claudeRateLimitCacheIsFresh(now - 1_000, limits(now / 1_000, (now + 120_000) / 1_000), now), false)
  assert.equal(claudeRateLimitCacheIsFresh(now - 1_000, limits((now + 60_000) / 1_000, now / 1_000), now), false)
})

test('Claude rate-limit cache still expires by age before a quota reset', () => {
  const now = 2_000_000
  assert.equal(claudeRateLimitCacheIsFresh(now - 120_000, limits((now + 60_000) / 1_000, (now + 120_000) / 1_000), now), false)
})
