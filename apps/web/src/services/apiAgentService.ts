import type { AgentName, AgentService, Task } from './agentService'
import type { PendingApproval } from '../../../../packages/protocol/src/types.js'
import { isFinalAssistantMessage, isStreamingDelta } from './chatTranscript.js'

type ApiTask = {
  id: string
  title: string
  agent: AgentName
  status: 'running' | 'completed' | 'failed' | 'interrupted' | 'waiting_for_approval'
  lastActivityAt: string
  model?: string
  reasoningEffort?: string
  tokenUsage?: { inputTokens: number; cachedInputTokens: number; outputTokens: number; totalTokens: number }
  executionStartedAt?: string
  executionDurationMs?: number
  pendingApprovals?: PendingApproval[]
}

const projectId = () => sessionStorage.getItem('relay-active-project-id') ?? ''

const toTask = (task: ApiTask): Task => ({
  id: task.id,
  title: task.title,
  agent: task.agent,
  time: task.status === 'running' ? 'Running now' : 'Recently',
  state: task.status,
  color: task.agent === 'Codex' ? 'violet' : 'orange',
  model: task.model,
  reasoningEffort: task.reasoningEffort,
  tokenUsage: task.tokenUsage,
  executionStartedAt: task.executionStartedAt,
  executionDurationMs: task.executionDurationMs,
  pendingApprovals: task.pendingApprovals,
})

export const apiAgentService: AgentService = {
  async listTasks() {
    const response = await fetch(`/api/projects/${encodeURIComponent(projectId())}/tasks`)
    if (!response.ok) throw new Error('Unable to load tasks')
    const body = await response.json() as { items: ApiTask[] }
    return body.items.map(toTask)
  },
  async createTask(agent, title, model, reasoningEffort) {
    const response = await fetch(`/api/projects/${encodeURIComponent(projectId())}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent, title, model, reasoningEffort }),
    })
    if (!response.ok) throw new Error('Unable to create task')
    return toTask(await response.json() as ApiTask)
  },
  async updateTaskModel(task, model, reasoningEffort) {
    if (!task.id) throw new Error('Task id is missing')
    const response = await fetch(`/api/tasks/${encodeURIComponent(task.id)}/model`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, reasoningEffort }),
    })
    if (!response.ok) {
      const body = await response.json() as { error?: string }
      throw new Error(body.error ?? 'Unable to save task model')
    }
    return toTask(await response.json() as ApiTask)
  },
  async sendMessage(task, message, model, reasoningEffort) {
    if (!task.id) throw new Error('Task id is missing')
    const response = await fetch(`/api/tasks/${task.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, model, reasoningEffort }),
    })
    if (!response.ok) throw new Error('Unable to send message')
    return { ok: true, message: `${task.agent} received: ${message}` }
  },
  async interruptTask(task) {
    if (!task.id) throw new Error('Task id is missing')
    const response = await fetch(`/api/tasks/${task.id}/interrupt`, { method: 'POST' })
    if (!response.ok) {
      const body = await response.json() as { error?: string }
      throw new Error(body.error ?? 'Unable to interrupt task')
    }
  },
  async deleteTask(task) {
    if (!task.id) throw new Error('Task id is missing')
    const response = await fetch(`/api/tasks/${encodeURIComponent(task.id)}`, { method: 'DELETE' })
    if (!response.ok) {
      const bodyText = await response.text()
      let detail = ''
      try {
        const body = JSON.parse(bodyText) as { error?: string }
        detail = body.error ?? ''
      } catch { /* Older backends may return an HTML error page. */ }
      if (response.status === 404 && !detail) throw new Error('The running Relay backend does not have the task delete endpoint yet. Restart the backend and try again.')
      throw new Error(detail || `Unable to delete task (HTTP ${response.status})`)
    }
  },
  async respondToApproval(task, approvalId, approvalResponse) {
    if (!task.id) throw new Error('Task id is missing')
    const response = await fetch(`/api/tasks/${task.id}/approvals/${encodeURIComponent(approvalId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(approvalResponse),
    })
    if (!response.ok) {
      const body = await response.json() as { error?: string }
      throw new Error(body.error ?? 'Unable to respond to approval')
    }
  },
}

export type CodexModel = { model: string; displayName: string; description?: string; isDefault?: boolean; hidden?: boolean; defaultReasoningEffort?: string; supportedReasoningEfforts?: Array<{ reasoningEffort: string; description: string }> }

export async function listCodexModels(): Promise<CodexModel[]> {
  const response = await fetch('/api/models')
  if (!response.ok) throw new Error('Unable to load Codex models')
  const body = await response.json() as { items?: CodexModel[] }
  return body.items ?? []
}

export async function listTaskEvents(taskId: string) {
  const response = await fetch(`/api/tasks/${taskId}/events`)
  if (!response.ok) throw new Error('Unable to load task events')
  const body = await response.json() as { items: Array<{ id: string; taskId: string; type?: string; createdAt: string; payload?: { text?: string; raw?: unknown; method?: string; itemId?: string; logType?: 'command' | 'test' | 'warning' | 'error' | 'status' | 'change' | 'tool'; progressState?: 'running' | 'completed'; error?: boolean; stderr?: boolean } }> }
  return body.items.reduce<Array<{ id: string; taskId: string; text: string; method?: string; itemId?: string; createdAt: string; role: 'user' | 'assistant' | 'progress'; eventType?: string; logType?: 'command' | 'test' | 'warning' | 'error' | 'status' | 'change' | 'tool'; progressState?: 'running' | 'completed' }>>((result, event) => {
    const text = event.payload?.text ?? (event.payload?.raw ? JSON.stringify(event.payload.raw) : '')
    const method = event.payload?.method
    if (!text) return result
    const role = event.type === 'user_message' ? 'user' as const : isFinalAssistantMessage(method) ? 'assistant' as const : 'progress' as const
    const logType = event.payload?.error || event.type === 'error' ? 'error' as const : event.type === 'test_result' ? 'test' as const : event.payload?.logType ?? (event.payload?.stderr ? 'warning' as const : undefined)
    const previous = result.at(-1)
    const deltaMessage = isStreamingDelta(method)
      ? event.payload?.itemId
        ? result.find(item => item.taskId === event.taskId && item.method === method && item.itemId === event.payload?.itemId)
        : previous?.taskId === event.taskId && previous.method === method ? previous : undefined
      : undefined
    if (deltaMessage) {
      deltaMessage.text += text
      deltaMessage.createdAt = event.createdAt
    } else result.push({ id: event.id, taskId: event.taskId, text, method, itemId: event.payload?.itemId, createdAt: event.createdAt, role, eventType: event.type, logType, progressState: event.payload?.progressState })
    return result
  }, [])
}

export async function listTaskHistory(taskId: string) {
  const response = await fetch(`/api/tasks/${taskId}/history`)
  if (!response.ok) throw new Error('Unable to load Codex session history')
  const body = await response.json() as { items: Array<{ role: 'user' | 'assistant'; text: string }> }
  return Array.isArray(body.items) ? body.items : []
}

export async function getTaskTokenUsage(taskId: string) {
  const response = await fetch(`/api/tasks/${taskId}/usage`)
  if (!response.ok) return undefined
  const body = await response.json() as { tokenUsage?: Task['tokenUsage'] | null }
  return body.tokenUsage ?? undefined
}
