import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Task, TokenUsage } from '../../protocol/src/types.js'

type SessionIndexEntry = { id: string; thread_name?: string; updated_at?: string }

const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex')
const indexPath = path.join(codexHome, 'session_index.jsonl')
const MAX_HISTORY_BYTES = 8 * 1024 * 1024
const MAX_HISTORY_MESSAGES = 100
const MAX_HISTORY_MESSAGE_CHARS = 32_000
const MAX_HISTORY_TOTAL_CHARS = 240_000
let sessionCache: { loadedAt: number; data: ReturnType<typeof readSessionData> } | undefined

function readFileSlice(file: string, fromEnd: boolean, maxBytes: number): string {
  let descriptor: number | undefined
  try {
    descriptor = fs.openSync(file, 'r')
    const size = fs.fstatSync(descriptor).size
    const length = Math.min(size, maxBytes)
    const buffer = Buffer.allocUnsafe(length)
    fs.readSync(descriptor, buffer, 0, length, fromEnd ? size - length : 0)
    return buffer.toString('utf8')
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
  }
}

// The desktop client can append runtime metadata to a submitted prompt. It is
// useful to the client, but is not task content and should not appear in Relay
// transcripts or be replayed as part of a resumed task.
export function stripInjectedPromptContext(text: string): string {
  return text
    .replace(/<recommended_plugins\b[^>]*>[\s\S]*?<\/recommended_plugins\s*>/gi, '')
    .replace(/<environment_context\b[^>]*>[\s\S]*?<\/environment_context\s*>/gi, '')
    .trim()
}

function rolloutFiles(directory: string): string[] {
  if (!fs.existsSync(directory)) return []
  const files: string[] = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...rolloutFiles(target))
    else if (entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) files.push(target)
  }
  return files
}

function readSessionData() {
  const result = new Map<string, { cwd: string; file: string }>()
  for (const file of rolloutFiles(path.join(codexHome, 'sessions'))) {
    try {
      // Session metadata is the first JSONL row. Read only the prefix instead
      // of loading potentially very large transcripts just to find that row.
      const firstLine = readFileSlice(file, false, 4 * 1024).split('\n', 1)[0]
      const record = JSON.parse(firstLine) as { type?: string; payload?: { id?: string; session_id?: string; cwd?: string } }
      const sessionId = record.payload?.id ?? record.payload?.session_id
      if (record.type !== 'session_meta' || !record.payload?.cwd || !sessionId) continue
      result.set(sessionId, { cwd: record.payload.cwd, file })
    } catch { /* Ignore partially written or old rollout files. */ }
  }
  return result
}

export function discoverCodexTasks(projectId: string, projectPath: string): Task[] {
  if (!fs.existsSync(indexPath)) return []
  const now = Date.now()
  if (!sessionCache || now - sessionCache.loadedAt > 60_000) sessionCache = { loadedAt: now, data: readSessionData() }
  const sessionData = sessionCache.data
  const matches: Task[] = []
  for (const line of fs.readFileSync(indexPath, 'utf8').split('\n')) {
    try {
      const entry = JSON.parse(line) as SessionIndexEntry
      if (!entry.id || sessionData.get(entry.id)?.cwd !== projectPath) continue
      const updatedAt = entry.updated_at ?? new Date().toISOString()
      matches.push({ id: `codex-${entry.id}`, remoteSessionId: entry.id, projectId, title: entry.thread_name || 'Codex session', agent: 'Codex', status: 'completed', createdAt: updatedAt, lastActivityAt: updatedAt })
    } catch { /* Ignore malformed index rows. */ }
  }
  return matches.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
}

export function readCodexSessionHistory(sessionId: string): Array<{ role: 'user' | 'assistant'; text: string }> {
  const messages: Array<{ role: 'user' | 'assistant'; text: string }> = []
  const now = Date.now()
  if (!sessionCache || now - sessionCache.loadedAt > 60_000) sessionCache = { loadedAt: now, data: readSessionData() }
  const session = sessionCache.data.get(sessionId)
  if (!session) return messages
  try {
    const fileSize = fs.statSync(session.file).size
    const contents = readFileSlice(session.file, true, MAX_HISTORY_BYTES)
    const lines = contents.split('\n')
    // The first line may start partway through a JSON record when reading a tail.
    if (fileSize > MAX_HISTORY_BYTES) lines.shift()
    for (const line of lines) {
        try {
          const row = JSON.parse(line) as {
            type?: string
            payload?: {
              type?: string
              role?: string
              message?: string
              content?: Array<{ type?: string; text?: string }>
            }
          }
          const payload = row.payload
          let role: 'user' | 'assistant' | undefined
          let text = ''
          if (row.type === 'response_item' && payload?.type === 'message') {
            role = payload.role === 'user' ? 'user' : payload.role === 'assistant' ? 'assistant' : undefined
            text = payload.content?.map(part => part.text ?? '').filter(Boolean).join('\n') ?? ''
          } else if (row.type === 'event_msg') {
            role = payload?.type === 'user_message' ? 'user' : payload?.type === 'agent_message' ? 'assistant' : undefined
            text = payload?.message ?? ''
          }
          const cleanText = role === 'user' ? stripInjectedPromptContext(text) : text
          if (role && cleanText) {
            const visibleText = cleanText.length > MAX_HISTORY_MESSAGE_CHARS
              ? `${cleanText.slice(0, MAX_HISTORY_MESSAGE_CHARS)}\n\n[Earlier content omitted for display.]`
              : cleanText
            messages.push({ role, text: visibleText })
            if (messages.length > MAX_HISTORY_MESSAGES) messages.shift()
          }
        } catch { /* Ignore malformed or partial rollout rows. */ }
    }
  } catch { /* Ignore unreadable rollout files. */ }
  let totalCharacters = messages.reduce((total, message) => total + message.text.length, 0)
  while (messages.length && totalCharacters > MAX_HISTORY_TOTAL_CHARS) {
    totalCharacters -= messages.shift()!.text.length
  }
  return messages
}

export function readCodexSessionTokenUsage(sessionId: string): TokenUsage | undefined {
  const now = Date.now()
  if (!sessionCache || now - sessionCache.loadedAt > 60_000) sessionCache = { loadedAt: now, data: readSessionData() }
  const session = sessionCache.data.get(sessionId)
  if (!session) return undefined
  const tail = readFileSlice(session.file, true, 64 * 1024).split('\n').slice(1).reverse()
  for (const line of tail) {
    try {
      const row = JSON.parse(line) as { type?: string; payload?: { info?: { total_token_usage?: Record<string, number> } } }
      const source = row.payload?.info?.total_token_usage
      if (row.type === 'event_msg' && source?.total_tokens) return {
        inputTokens: source.input_tokens ?? 0,
        cachedInputTokens: source.cached_input_tokens ?? 0,
        outputTokens: source.output_tokens ?? 0,
        totalTokens: source.total_tokens,
      }
    } catch { /* Ignore malformed or partial rollout rows. */ }
  }
  return undefined
}
