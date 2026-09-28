import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { SessionEvent, Task, TokenUsage } from '../../protocol/src/types.js'

const codexBinary = process.env.CODEX_BIN ?? '/opt/homebrew/bin/codex'
const running = new Map<string, ChildProcessWithoutNullStreams>()

type RunnerCallbacks = {
  onEvent: (event: SessionEvent) => void
  onSessionId: (sessionId: string) => void
  onStatus: (status: Task['status']) => void
  onUsage: (usage: TokenUsage) => void
}

const textFromItem = (item: Record<string, unknown>) => {
  if (typeof item.text === 'string') return item.text
  if (typeof item.message === 'string') return item.message
  return JSON.stringify(item)
}

const readUsage = (value: unknown): TokenUsage | undefined => {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const source = (record.total_token_usage ?? record.usage ?? record) as Record<string, unknown>
  if (typeof source.total_tokens !== 'number') return undefined
  return { inputTokens: Number(source.input_tokens ?? 0), cachedInputTokens: Number(source.cached_input_tokens ?? 0), outputTokens: Number(source.output_tokens ?? 0), totalTokens: Number(source.total_tokens) }
}

export function runCodex(task: Task, prompt: string, projectPath: string, callbacks: RunnerCallbacks) {
  const args = ['exec', '--json', '-C', projectPath, '--skip-git-repo-check', '-s', 'workspace-write', prompt]
  return runCodexProcess(task, args, projectPath, callbacks)
}

export function resumeCodex(task: Task, prompt: string, projectPath: string, callbacks: RunnerCallbacks) {
  if (!task.remoteSessionId) return runCodex(task, prompt, projectPath, callbacks)
  const args = ['exec', 'resume', task.remoteSessionId, '--skip-git-repo-check', '--json', prompt]
  return runCodexProcess(task, args, projectPath, callbacks)
}

function runCodexProcess(task: Task, args: string[], projectPath: string, callbacks: RunnerCallbacks) {
  const child = spawn(codexBinary, args, { cwd: projectPath, env: process.env, stdio: 'pipe' })
  running.set(task.id, child)

  let buffer = ''
  const handleLine = (line: string) => {
    if (!line.trim()) return
    let raw: Record<string, unknown>
    try { raw = JSON.parse(line) as Record<string, unknown> } catch {
      callbacks.onEvent({ id: `event-${randomUUID()}`, taskId: task.id, type: 'assistant_message', payload: { text: line, raw: true }, sequence: 0, createdAt: new Date().toISOString() })
      return
    }
    const eventType = typeof raw.type === 'string' ? raw.type : 'codex_event'
    const usage = readUsage((raw.info as Record<string, unknown> | undefined)?.total_token_usage ?? raw.usage ?? raw)
    if (usage) callbacks.onUsage(usage)
    if (eventType === 'thread.started' && typeof raw.thread_id === 'string') callbacks.onSessionId(raw.thread_id)
    const item = raw.item && typeof raw.item === 'object' ? raw.item as Record<string, unknown> : undefined
    let normalizedType: SessionEvent['type'] = 'assistant_message'
    if (item?.type === 'file_change' || item?.type === 'file_changes') normalizedType = 'file_change'
    if (item?.type === 'test_result' || eventType.includes('test')) normalizedType = 'test_result'
    callbacks.onEvent({ id: `event-${randomUUID()}`, taskId: task.id, type: normalizedType, payload: item ? { ...item, text: textFromItem(item) } : { text: textFromItem(raw), raw }, sequence: 0, createdAt: new Date().toISOString() })
    if (eventType === 'turn.completed') callbacks.onStatus('completed')
    if (eventType === 'error' || eventType.includes('failed')) callbacks.onStatus('failed')
  }

  child.stdout.on('data', chunk => {
    buffer += chunk.toString()
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    lines.forEach(handleLine)
  })
  child.stderr.on('data', chunk => {
    const text = chunk.toString().trim()
    if (text) callbacks.onEvent({ id: `event-${randomUUID()}`, taskId: task.id, type: 'assistant_message', payload: { text, stderr: true }, sequence: 0, createdAt: new Date().toISOString() })
  })
  child.on('error', error => { callbacks.onEvent({ id: `event-${randomUUID()}`, taskId: task.id, type: 'assistant_message', payload: { text: error.message, error: true }, sequence: 0, createdAt: new Date().toISOString() }); callbacks.onStatus('failed'); running.delete(task.id) })
  child.on('close', code => { if (buffer.trim()) handleLine(buffer); if (code !== 0 && task.status === 'running') callbacks.onStatus('failed'); running.delete(task.id) })
  return child
}
