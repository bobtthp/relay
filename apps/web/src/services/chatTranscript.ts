export type TranscriptMessage = {
  id?: string
  taskId?: string
  role: 'user' | 'assistant' | 'progress'
  text: string
  createdAt?: string
  method?: string
  itemId?: string
  eventType?: string
  logType?: 'command' | 'test' | 'warning' | 'error' | 'status' | 'change' | 'tool'
  progressState?: 'running' | 'completed'
}

export function mergeSessionTimeline(history: Array<{ role: 'user' | 'assistant'; text: string }>, events: TranscriptMessage[]): TranscriptMessage[] {
  if (!events.length) return history
  if (!history.length) return events
  // Relay's persisted event stream is the canonical copy of every turn it
  // captured. Keep it intact after completion; only prepend Codex-only turns
  // from before Relay's first matching user message.
  const normalize = (text: string) => text.replace(/\s+/g, ' ').trim()
  const historyUserMessages = new Set(history.filter(message => message.role === 'user').map(message => normalize(message.text)))
  const eventStart = events.findIndex(event => event.role === 'user' && historyUserMessages.has(normalize(event.text)))
  if (eventStart < 0) {
    const merged: TranscriptMessage[] = history.map((message, index) => ({ ...message, id: `history-${index}` }))
    const seen = new Set(merged.map(message => `${message.role}\0${normalize(message.text)}`))
    for (const event of events) {
      if (event.role === 'progress') {
        merged.push(event)
        continue
      }
      const key = `${event.role}\0${normalize(event.text)}`
      if (!seen.has(key)) {
        seen.add(key)
        merged.push(event)
      }
    }
    return merged
  }
  const firstHistoryMatch = history.findIndex(message => message.role === 'user' && normalize(message.text) === normalize(events[eventStart].text))
  return [...history.slice(0, firstHistoryMatch), ...events.slice(eventStart)]
}

export const isExecutionLog = (message: TranscriptMessage) => message.role === 'progress'
export const isFinalAssistantMessage = (method?: string) => method === 'item/agentMessage/delta'
export const isStreamingDelta = (method?: string) => isFinalAssistantMessage(method) || method?.endsWith('/outputDelta') === true

export function mergeEventSnapshots(snapshot: TranscriptMessage[], live: TranscriptMessage[]): TranscriptMessage[] {
  const merged = snapshot.map(message => ({ ...message }))
  for (const message of live) {
    const index = merged.findIndex(item => item.id === message.id || (
      message.method === 'item/agentMessage/delta' && item.method === message.method && item.taskId === message.taskId && item.itemId === message.itemId
    ))
    if (index < 0) {
      merged.push(message)
      continue
    }
    const current = merged[index]
    if (message.text.startsWith(current.text) || !current.text.startsWith(message.text)) merged[index] = message
  }
  return merged
}
