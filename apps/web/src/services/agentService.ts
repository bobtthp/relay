export type AgentName = 'Codex' | 'Claude'

export type Task = {
  id?: string
  remoteSessionId?: string
  title: string
  agent: AgentName
  time: string
  state: 'running' | 'completed' | 'failed' | 'interrupted' | 'waiting_for_approval'
  color: 'violet' | 'orange'
  model?: string
  reasoningEffort?: string
  tokenUsage?: { inputTokens: number; cachedInputTokens: number; outputTokens: number; totalTokens: number }
  executionStartedAt?: string
  executionDurationMs?: number
  pendingApprovals?: Array<{ id: string; kind: 'command' | 'file_change' | 'permissions' | 'mcp_form' | 'mcp_url' | 'user_input'; reason?: string; command?: string; cwd?: string; networkContext?: Record<string, unknown>; permissions?: Record<string, unknown>; changes?: Array<{ path: string; kind: string; diff: string }>; serverName?: string; message?: string; requestedSchema?: Record<string, unknown>; url?: string; elicitationId?: string; questions?: Array<{ id: string; header: string; question: string; isOther?: boolean; isSecret?: boolean; options?: Array<{ label: string; description: string }> }>; canApprove: boolean }>
}

export type AgentService = {
  listTasks(): Promise<Task[]>
  listDeletedTasks(projectId: string): Promise<Array<{ id: string; title: string; lastActivityAt: string; deletedAt: string }>>
  restoreDeletedTask(projectId: string, sessionId: string): Promise<Task>
  createTask(agent: AgentName, title: string, model?: string, reasoningEffort?: string): Promise<Task>
  updateTaskModel(task: Task, model: string, reasoningEffort: string): Promise<Task>
  sendMessage(task: Task, message: string, model?: string, reasoningEffort?: string): Promise<{ ok: true; message: string }>
  interruptTask(task: Task): Promise<void>
  deleteTask(task: Task): Promise<void>
  respondToApproval(task: Task, approvalId: string, response: Record<string, unknown>): Promise<void>
}
