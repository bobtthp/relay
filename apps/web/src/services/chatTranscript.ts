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
  const eventStart = events.findIndex(event => event.role === 'user' && history.some(message => message.role === 'user' && normalize(message.text) === normalize(event.text)))
  if (eventStart < 0) {
    const merged: TranscriptMessage[] = history.map((message, index) => ({ ...message, id: `history-${index}` }))
    for (const event of events) {
      const duplicate = event.role !== 'progress' && merged.some(message => message.role === event.role && normalize(message.text) === normalize(event.text))
      if (!duplicate) merged.push(event)
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
