export type AgentName = 'Codex' | 'Claude'

export type TaskStatus = 'running' | 'completed' | 'failed' | 'interrupted' | 'waiting_for_approval'

export type TokenUsage = {
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  totalTokens: number
}

export type PendingApproval = {
  id: string
  kind: 'command' | 'file_change' | 'permissions' | 'mcp_form' | 'mcp_url' | 'user_input'
  reason?: string
  command?: string
  cwd?: string
  networkContext?: Record<string, unknown>
  permissions?: Record<string, unknown>
  changes?: Array<{ path: string; kind: string; diff: string }>
  serverName?: string
  message?: string
  requestedSchema?: Record<string, unknown>
  url?: string
  elicitationId?: string
  questions?: Array<{ id: string; header: string; question: string; isOther?: boolean; isSecret?: boolean; options?: Array<{ label: string; description: string }> }>
  canApprove: boolean
}

export type Machine = {
  id: string
  name: string
  status: 'connected' | 'offline'
  platform: string
  architecture: string
}

export type Project = {
  id: string
  machineId: string
  name: string
  path: string
  branch: string
  clean: boolean
}

export type Task = {
  id: string
  projectId: string
  title: string
  agent: AgentName
  status: TaskStatus
  createdAt: string
  lastActivityAt: string
  remoteSessionId?: string
  remoteSessionAliases?: string[]
  model?: string
  reasoningEffort?: string
  tokenUsage?: TokenUsage
  activeTurnId?: string
  executionStartedAt?: string
  executionDurationMs?: number
  pendingApprovals?: PendingApproval[]
}

export type SessionEvent = {
  id: string
  taskId: string
  type: 'assistant_message' | 'file_change' | 'test_result' | 'user_message' | 'approval_request' | 'error'
  payload: Record<string, unknown>
  sequence: number
  createdAt: string
}
