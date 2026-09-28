import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { listTaskEvents } from '../src/services/apiAgentService.js'
import { mergeEventSnapshots, mergeSessionTimeline } from '../src/services/chatTranscript.js'

const markdown = `## Summary

- One item with **bold** text
- Another item

| Project | Status |
| --- | --- |
| Relay | \`ready\` |

See [the docs](https://example.com/docs).`

test('persisted event deltas reconstruct the exact Markdown source', async () => {
  const boundary = 41
  const items = [
    { id: 'user', taskId: 'task-1', type: 'user_message', createdAt: '2026-01-01T00:00:00Z', payload: { text: 'Create a summary' } },
    { id: 'delta-1', taskId: 'task-1', type: 'assistant_message', createdAt: '2026-01-01T00:00:01Z', payload: { text: markdown.slice(0, boundary), method: 'item/agentMessage/delta', itemId: 'item-1' } },
    { id: 'delta-2', taskId: 'task-1', type: 'assistant_message', createdAt: '2026-01-01T00:00:02Z', payload: { text: markdown.slice(boundary), method: 'item/agentMessage/delta', itemId: 'item-1' } },
  ]
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ items }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  try {
    const streamedEvents = await listTaskEvents('task-1')
    assert.equal(streamedEvents[1]?.text, markdown)

    const staleHistory = [
      { role: 'user' as const, text: 'Create a summary' },
      { role: 'assistant' as const, text: '## Summary - One item with bold text - Another item Relay ready See the docs.' },
    ]
    const displayedAfterCompletion = mergeSessionTimeline(staleHistory, streamedEvents)
    assert.equal(displayedAfterCompletion.at(-1)?.text, markdown)

    const html = renderToStaticMarkup(React.createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, displayedAfterCompletion.at(-1)!.text))
    assert.match(html, /<h2>Summary<\/h2>/)
    assert.match(html, /<strong>bold<\/strong>/)
    assert.match(html, /<table>/)
    assert.match(html, /<a href="https:\/\/example\.com\/docs">the docs<\/a>/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('Codex-only history remains available when Relay has no persisted events', () => {
  const history = [{ role: 'assistant' as const, text: markdown }]
  assert.deepEqual(mergeSessionTimeline(history, []), history)
})

test('a history response cannot overwrite deltas received while the request was in flight', () => {
  const snapshot = [{ id: 'first-delta', taskId: 'task-1', role: 'assistant' as const, method: 'item/agentMessage/delta', itemId: 'item-1', text: markdown.slice(0, 35) }]
  const live = [{ id: 'newest-delta', taskId: 'task-1', role: 'assistant' as const, method: 'item/agentMessage/delta', itemId: 'item-1', text: markdown }]
  assert.equal(mergeEventSnapshots(snapshot, live)[0]?.text, markdown)
})
