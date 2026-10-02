import express from 'express'
import { createServer } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { execFile, spawn } from 'node:child_process'
import os from 'node:os'
import path, { resolve } from 'node:path'
import { promisify } from 'node:util'
import { WebSocket, WebSocketServer } from 'ws'
import { events, machines, projects, refreshProjects, tasks } from './local-state.js'
import type { AgentName, PendingApproval, SessionEvent } from '../../protocol/src/types.js'
import { CodexAppServer, type RpcId } from './codex-app-server.js'
import { loadProjectCache, saveProjectCache } from './project-cache.js'
import { discoverCodexTasks, readCodexSessionHistory, readCodexSessionTokenUsage, stripInjectedPromptContext } from './codex-history.js'
import { listDirectories, removeSavedProject, saveSelectedProject, validateProjectPath } from './local-project.js'
import { readApprovalSettings, writeApprovalSettings } from './approval-settings.js'

const app = express()
const server = createServer(app)
const port = Number(process.env.PORT ?? 3000)
const host = process.env.RELAY_HOST ?? '0.0.0.0'
const isLoopbackHost = host === '127.0.0.1' || host === 'localhost' || host === '::1'
const authTokenPath = process.env.RELAY_AUTH_TOKEN_FILE ?? path.join(process.env.RELAY_DATA_DIR ?? path.join(os.homedir(), '.relay-web'), 'auth-token')
const loadOrCreateAuthToken = () => {
  if (process.env.RELAY_AUTH_TOKEN) return process.env.RELAY_AUTH_TOKEN
  if (isLoopbackHost) return undefined
  fs.mkdirSync(path.dirname(authTokenPath), { recursive: true, mode: 0o700 })
  try {
    const token = fs.readFileSync(authTokenPath, 'utf8').trim()
    if (token) {
      fs.chmodSync(authTokenPath, 0o600)
      return token
    }
  } catch { /* Create a token on first start. */ }
  const token = randomBytes(32).toString('hex')
  try {
    fs.writeFileSync(authTokenPath, token, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  fs.chmodSync(authTokenPath, 0o600)
  return fs.readFileSync(authTokenPath, 'utf8').trim()
}
const authToken = loadOrCreateAuthToken()
const requestToken = (headers: { authorization?: string; 'x-relay-token'?: string }) => headers['x-relay-token'] ?? headers.authorization?.replace(/^Bearer\s+/i, '')
const authorized = (headers: { authorization?: string; 'x-relay-token'?: string }) => !authToken || requestToken(headers) === authToken
const activeCodexTasks = new Set<string>()
// Event deltas arrive frequently. Keep the per-task sequence in memory so
// appending an event stays O(1) instead of rescanning the full event log.
const eventSequences = new Map<string, number>()
const hiddenCodexSessionIds = new Set<string>()
const codex = new CodexAppServer()
let approvalSettings = readApprovalSettings()
const automaticApprovalKinds = new Set<PendingApproval['kind']>(['command', 'file_change', 'permissions'])
const pendingApprovalRequests = new Map<string, { taskId: string; itemId: string; rpcId: RpcId; kind: PendingApproval['kind']; requestedPermissions?: Record<string, unknown>; requestedSchema?: Record<string, unknown>; questions?: NonNullable<PendingApproval['questions']> }>()
const fileChangePreviews = new Map<string, PendingApproval['changes']>()
const execFileAsync = promisify(execFile)
type EnvironmentTool = 'codex' | 'claude'
const environmentInstalls = new Map<EnvironmentTool, { status: 'installing' | 'failed'; detail?: string }>()
const environmentTools: Record<EnvironmentTool, { command: string; packageName: string; label: string }> = {
  codex: { command: 'codex', packageName: '@openai/codex', label: 'Codex CLI' },
  claude: { command: 'claude', packageName: '@anthropic-ai/claude-code', label: 'Claude Code' },
}
const commandVersion = async (command: string) => {
  try {
    const { stdout } = await execFileAsync(command, ['--version'], { timeout: 5_000 })
    return { installed: true, version: stdout.trim().split('\n')[0] || 'Installed' }
  } catch { return { installed: false } }
}
const loadedProjectIds = new Set<string>()
const loadedTaskIds = new Set(tasks.map(task => task.id))
const loadedEventIds = new Set(events.map(event => event.id))
const hydrateProjectCache = (project: typeof projects[number]) => {
  if (loadedProjectIds.has(project.id)) return
  loadedProjectIds.add(project.id)
  const cached = loadProjectCache(project.path)
  if (!cached) return
  for (const task of cached.tasks) {
    task.projectId = project.id
    if (task.status === 'waiting_for_approval') { task.status = 'interrupted'; task.pendingApprovals = [] }
    if (!loadedTaskIds.has(task.id)) {
      tasks.push(task)
      loadedTaskIds.add(task.id)
    }
  }
  for (const event of cached.events) {
    if (!loadedEventIds.has(event.id)) {
      events.push(event)
      loadedEventIds.add(event.id)
    }
    eventSequences.set(event.taskId, Math.max(eventSequences.get(event.taskId) ?? 0, event.sequence))
  }
  for (const sessionId of cached.hiddenCodexSessionIds ?? []) hiddenCodexSessionIds.add(sessionId)
  const projectTasks = tasks.filter(task => task.projectId === project.id)
  const projectTaskIds = new Set(projectTasks.map(task => task.id))
  saveProjectCache(project.path, { tasks: projectTasks, events: events.filter(event => projectTaskIds.has(event.taskId)), hiddenCodexSessionIds: [...hiddenCodexSessionIds] })
}
for (const project of projects) hydrateProjectCache(project)
const websocket = new WebSocketServer({ server, path: '/ws' })
const authenticatedSockets = new WeakSet<WebSocket>()

const broadcast = (message: unknown) => {
  const encoded = JSON.stringify(message)
  websocket.clients.forEach(client => { if (client.readyState === WebSocket.OPEN && authenticatedSockets.has(client)) client.send(encoded) })
}

const broadcastTaskStatus = (task: typeof tasks[number]) => broadcast({
  type: 'task_status',
  taskId: task.id,
  status: task.status,
  executionStartedAt: task.executionStartedAt ?? null,
  executionDurationMs: task.executionDurationMs,
})

const persist = (projectId?: string) => {
  for (const project of projects.filter(item => !projectId || item.id === projectId)) saveProjectCache(project.path, {
    tasks: tasks.filter(task => task.projectId === project.id),
    events: events.filter(event => tasks.some(task => task.id === event.taskId && task.projectId === project.id)),
    hiddenCodexSessionIds: [...hiddenCodexSessionIds],
  })
}

const assignRemoteSession = (task: typeof tasks[number], sessionId: string) => {
  task.remoteSessionId = sessionId
  // A history scan can discover a newly created session before startThread has
  // attached its ID to the task Relay created for it. Drop that synthetic row.
  for (let index = tasks.length - 1; index >= 0; index--) {
    const duplicate = tasks[index]
    if (duplicate !== task && (
      duplicate.remoteSessionId === sessionId || duplicate.id === `codex-${sessionId}` ||
      (task.remoteSessionAliases ?? []).some(alias => duplicate.remoteSessionId === alias || duplicate.id === `codex-${alias}`)
    )) tasks.splice(index, 1)
  }
}

const addDiscoveredTasks = (discovered: typeof tasks) => {
  for (let index = tasks.length - 1; index >= 0; index--) {
    const candidate = tasks[index]
    const sessionId = candidate.remoteSessionId
    if (sessionId && candidate.id === `codex-${sessionId}` && tasks.some(owner => owner !== candidate && (owner.remoteSessionAliases ?? []).includes(sessionId))) tasks.splice(index, 1)
  }
  const seen = new Set<string>()
  for (let index = 0; index < tasks.length; index++) {
    const sessionId = tasks[index].remoteSessionId
    if (!sessionId) continue
    if (seen.has(sessionId)) { tasks.splice(index, 1); index-- }
    else seen.add(sessionId)
  }
  for (const task of discovered) {
    if (!task.remoteSessionId || hiddenCodexSessionIds.has(task.remoteSessionId) || seen.has(task.remoteSessionId) || tasks.some(existing => (existing.remoteSessionAliases ?? []).includes(task.remoteSessionId!))) continue
    tasks.push(task)
    seen.add(task.remoteSessionId)
  }
}

const appendEvent = (event: SessionEvent) => {
  event.sequence = (eventSequences.get(event.taskId) ?? 0) + 1
  eventSequences.set(event.taskId, event.sequence)
  events.push(event)
  persist(tasks.find(task => task.id === event.taskId)?.projectId)
  broadcast({ type: 'session_event', event })
}

const resumeTaskTimer = (task: typeof tasks[number], at = new Date()) => {
  if (task.executionStartedAt) return
  task.executionDurationMs ??= 0
  task.executionStartedAt = at.toISOString()
}

const pauseTaskTimer = (task: typeof tasks[number], at = new Date()) => {
  if (!task.executionStartedAt) return
  const startedAt = Date.parse(task.executionStartedAt)
  if (Number.isFinite(startedAt)) task.executionDurationMs = (task.executionDurationMs ?? 0) + Math.max(0, at.getTime() - startedAt)
  task.executionStartedAt = undefined
}

const upsertProgressEvent = (taskId: string, progressKey: string, text: string, progressState: 'running' | 'completed', logType: 'change' | 'status' = 'change') => {
  const existing = events.find(event => event.taskId === taskId && event.payload.method === 'relay/progress' && event.payload.progressKey === progressKey)
  const nextText = text || (typeof existing?.payload.text === 'string' ? existing.payload.text : '')
  if (!nextText) return
  if (existing) {
    existing.payload = { ...existing.payload, text: nextText, progressState, logType }
    existing.createdAt = new Date().toISOString()
    persist(tasks.find(task => task.id === taskId)?.projectId)
    broadcast({ type: 'session_event', event: existing })
    return
  }
  appendEvent({
    id: `event-${randomUUID()}`,
    taskId,
    type: 'assistant_message',
    payload: { text, method: 'relay/progress', progressState, progressKey, logType },
    sequence: 0,
    createdAt: new Date().toISOString(),
  })
}

const failTask = (task: typeof tasks[number], error: unknown) => {
  const now = new Date()
  pauseTaskTimer(task, now)
  task.status = 'failed'
  task.lastActivityAt = now.toISOString()
  activeCodexTasks.delete(task.id)
  persist(task.projectId)
  appendEvent({ id: `event-${randomUUID()}`, taskId: task.id, type: 'error', payload: { text: error instanceof Error ? error.message : String(error), error: true, logType: 'error' }, sequence: 0, createdAt: new Date().toISOString() })
  broadcastTaskStatus(task)
}

const asRecord = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const normalizeFileChanges = (value: unknown): PendingApproval['changes'] => Array.isArray(value)
  ? value.flatMap(change => {
      const record = asRecord(change)
      if (!record || typeof record.path !== 'string') return []
      return [{ path: record.path, kind: typeof record.kind === 'string' ? record.kind : 'update', diff: typeof record.diff === 'string' ? record.diff : '' }]
  })
  : undefined
const formatFileChangeProgress = (changes: PendingApproval['changes']) => {
  if (!changes?.length) return ''
  return changes.map(change => {
    if (!change.diff) return `${change.kind}: ${change.path}`
    const limit = 24_000
    const diff = change.diff.length > limit ? `${change.diff.slice(0, limit)}\n… diff truncated …` : change.diff
    return `${change.kind}: ${change.path}\n\n\`\`\`diff\n${diff}\n\`\`\``
  }).join('\n\n')
}
const formatCodexProgress = (item: Record<string, unknown>, completed: boolean) => {
  const type = typeof item.type === 'string' ? item.type : ''
  const command = typeof item.command === 'string' ? item.command : ''
  const changes = normalizeFileChanges(item.changes)
  const paths = changes?.map(change => change.path).filter(Boolean).slice(0, 6) ?? []
  const action = type === 'commandExecution' ? (completed ? 'Finished command' : 'Running command')
    : type === 'fileChange' ? (completed ? 'Updated files' : 'Editing files')
      : type === 'webSearch' ? (completed ? 'Finished web search' : 'Searching the web')
        : type === 'mcpToolCall' ? (completed ? 'Finished tool call' : 'Calling tool')
          : type === 'imageView' ? (completed ? 'Finished image inspection' : 'Inspecting image')
            : ''
  if (!action) return ''
  const detail = type === 'commandExecution' ? command
    : type === 'fileChange' ? paths.join(', ')
      : type === 'webSearch' && typeof item.query === 'string' ? item.query
        : type === 'mcpToolCall' ? [item.server, item.tool].filter(value => typeof value === 'string').join(' · ')
          : typeof item.path === 'string' ? item.path : ''
  const exitCode = completed && typeof item.exitCode === 'number' ? ` (exit ${item.exitCode})` : ''
  return `${action}${detail ? `: ${detail}` : ''}${exitCode}`
}
const makeApprovalResponse = (kind: PendingApproval['kind'], decision: 'accept' | 'decline', requestedPermissions?: Record<string, unknown>) => {
  if (kind === 'mcp_form' || kind === 'mcp_url') return { action: decision === 'accept' ? 'accept' : 'decline', content: null, _meta: null }
  if (kind === 'user_input') return { answers: {} }
  if (kind === 'permissions') {
    const permissions = decision === 'accept' && requestedPermissions
      ? Object.fromEntries(Object.entries(requestedPermissions).filter(([, value]) => value != null))
      : {}
    return { permissions, scope: 'turn' }
  }
  return { decision }
}

const isThreadNotFound = (error: unknown) => error instanceof Error && /thread\s+not\s+found|unknown\s+thread/i.test(error.message)

const restoreThreadFromLocalTranscript = async (task: typeof tasks[number], projectPath: string) => {
  const previousThreadId = task.remoteSessionId
  if (!previousThreadId) throw new Error('This task has no Codex session to restore')
  const history = readCodexSessionHistory(previousThreadId)
  if (!history.length) throw new Error(`Codex could not find thread ${previousThreadId}, and no local transcript is available to restore`)
  let remainingCharacters = 120_000
  const selectedHistory: typeof history = []
  for (const message of history.slice(-40).reverse()) {
    if (remainingCharacters <= 0) break
    const text = message.text.slice(-Math.min(8_000, remainingCharacters))
    remainingCharacters -= text.length
    if (text) selectedHistory.unshift({ role: message.role, text })
  }
  const items = selectedHistory.map(message => ({ type: 'message', role: message.role, content: [{ type: message.role === 'user' ? 'input_text' : 'output_text', text: message.text }] }))
  const restoredThreadId = await codex.startThread(projectPath)
  await codex.injectItems(restoredThreadId, items)
  task.remoteSessionAliases = [...new Set([...(task.remoteSessionAliases ?? []), previousThreadId])]
  assignRemoteSession(task, restoredThreadId)
  task.activeTurnId = undefined
  task.status = 'running'
  task.lastActivityAt = new Date().toISOString()
  persist(task.projectId)
  broadcast({ type: 'task_session_started', taskId: task.id, sessionId: restoredThreadId, restoredFrom: previousThreadId })
  appendEvent({
    id: `event-${randomUUID()}`,
    taskId: task.id,
    type: 'assistant_message',
    payload: { text: `Relay could not reopen the original Codex thread (${previousThreadId}). I restored the recent user/assistant text into a new thread so you can continue. Tool-call state and non-text context were not migrated.`, logType: 'warning' },
    sequence: 0,
    createdAt: new Date().toISOString(),
  })
  return restoredThreadId
}

const resumeOrRestoreThread = async (task: typeof tasks[number], projectPath: string, prompt: string) => {
  const threadId = task.remoteSessionId
  if (!threadId) throw new Error('This task has no Codex session to resume')
  try {
    await codex.resumeThread(threadId, projectPath)
    await codex.startTurn(threadId, prompt, projectPath, task.model, task.reasoningEffort)
  } catch (error) {
    if (!isThreadNotFound(error)) throw error
    const restoredThreadId = await restoreThreadFromLocalTranscript(task, projectPath)
    await codex.startTurn(restoredThreadId, prompt, projectPath, task.model, task.reasoningEffort)
  }
}

codex.onServerRequest(message => {
  const params = message.params ?? {}
  const kind: PendingApproval['kind'] | undefined = message.method === 'item/commandExecution/requestApproval'
    ? 'command'
    : message.method === 'item/fileChange/requestApproval'
      ? 'file_change'
      : message.method === 'item/permissions/requestApproval'
        ? 'permissions'
        : message.method === 'mcpServer/elicitation/request'
          ? params.mode === 'url' ? 'mcp_url' : 'mcp_form'
          : message.method === 'item/tool/requestUserInput' ? 'user_input' : undefined
  if (!kind) {
    codex.respondToServerRequestError(message.id, -32601, `Relay does not support Codex request ${message.method}`)
    return
  }
  if (message.method === 'mcpServer/elicitation/request' && !['form', 'openai/form', 'openaiForm', 'url'].includes(String(params.mode))) {
    codex.respondToServerRequest(message.id, { action: 'decline', content: null, _meta: null })
    return
  }

  const threadId = typeof params.threadId === 'string' ? params.threadId : typeof params.conversationId === 'string' ? params.conversationId : undefined
  const task = tasks.find(item => item.remoteSessionId === threadId)
  const requestedPermissions = asRecord(params.permissions)
  const requestedSchema = asRecord(params.requestedSchema)
  const questions = Array.isArray(params.questions) ? params.questions.flatMap(question => {
    const q = asRecord(question)
    if (!q || typeof q.id !== 'string' || typeof q.question !== 'string') return []
    const options = Array.isArray(q.options) ? q.options.flatMap(option => { const o = asRecord(option); return o && typeof o.label === 'string' ? [{ label: o.label, description: typeof o.description === 'string' ? o.description : '' }] : [] }) : undefined
    return [{ id: q.id, header: typeof q.header === 'string' ? q.header : q.id, question: q.question, ...(typeof q.isOther === 'boolean' ? { isOther: q.isOther } : {}), ...(typeof q.isSecret === 'boolean' ? { isSecret: q.isSecret } : {}), ...(options?.length ? { options } : {}) }]
  }) : undefined
  if (!task) {
    codex.respondToServerRequest(message.id, makeApprovalResponse(kind, 'decline', requestedPermissions))
    return
  }

  const available = Array.isArray(params.availableDecisions) ? params.availableDecisions : undefined
  const requestItemId = typeof params.itemId === 'string' ? params.itemId : ''
  const changeKey = threadId && requestItemId ? `${threadId}:${requestItemId}` : ''
  const changes = kind === 'file_change' && changeKey ? fileChangePreviews.get(changeKey) : undefined
  const schemaProperties = requestedSchema && asRecord(requestedSchema.properties)
  const formSchemaSupported = Boolean(requestedSchema?.type === 'object' && schemaProperties && Object.values(schemaProperties).every(value => {
    const property = asRecord(value)
    return property && ['string', 'number', 'integer', 'boolean'].includes(String(property.type)) && (property.enum === undefined || Array.isArray(property.enum))
  }))
  const canApprove = kind === 'permissions'
    ? Boolean(requestedPermissions)
    : kind === 'mcp_form' ? formSchemaSupported
      : kind === 'mcp_url' ? typeof params.url === 'string' && /^https?:\/\//i.test(params.url)
        : kind === 'user_input' ? Boolean(questions?.length)
    : kind === 'file_change'
      ? Boolean(changes?.some(change => change.diff.trim()))
      : !available || available.some(decision => decision === 'accept')
  const requestId = randomUUID()
  const itemId = requestItemId
  const command = typeof params.command === 'string'
    ? params.command
    : Array.isArray(params.command) ? params.command.map(String).join(' ') : undefined
  const approval: PendingApproval = {
    id: requestId,
    kind,
    canApprove,
    ...(typeof params.reason === 'string' && params.reason ? { reason: params.reason } : {}),
    ...(command ? { command } : {}),
    ...(typeof params.cwd === 'string' && params.cwd ? { cwd: params.cwd } : {}),
    ...(asRecord(params.networkApprovalContext) ? { networkContext: asRecord(params.networkApprovalContext) } : {}),
    ...(requestedPermissions ? { permissions: requestedPermissions } : {}),
    ...(changes ? { changes } : {}),
    ...(typeof params.serverName === 'string' ? { serverName: params.serverName } : {}),
    ...(typeof params.message === 'string' ? { message: params.message } : {}),
    ...(requestedSchema ? { requestedSchema } : {}),
    ...(typeof params.url === 'string' ? { url: params.url } : {}),
    ...(typeof params.elicitationId === 'string' ? { elicitationId: params.elicitationId } : typeof params.elicitId === 'string' ? { elicitationId: params.elicitId } : {}),
    ...(questions ? { questions } : {}),
  }
  pendingApprovalRequests.set(requestId, { taskId: task.id, itemId, rpcId: message.id, kind, ...(requestedPermissions ? { requestedPermissions } : {}), ...(requestedSchema ? { requestedSchema } : {}), ...(questions ? { questions } : {}) })
  if (approvalSettings.autoApproveConfirmations && approval.canApprove && automaticApprovalKinds.has(kind)) {
    try {
      answerApproval(task, requestId, { decision: 'accept' })
      appendEvent({
        id: `event-${randomUUID()}`,
        taskId: task.id,
        type: 'assistant_message',
        payload: { text: `Relay automatically approved this ${kind.replace('_', ' ')} request.`, method: 'relay/auto-approval', approvalKind: kind, logType: 'status' },
        sequence: 0,
        createdAt: new Date().toISOString(),
      })
      return
    } catch { /* Keep the request pending for the normal manual approval flow. */ }
  }
  task.pendingApprovals = [...(task.pendingApprovals ?? []), approval]
  pauseTaskTimer(task)
  task.status = 'waiting_for_approval'
  task.lastActivityAt = new Date().toISOString()
  persist(task.projectId)
  broadcastTaskStatus(task)
  broadcast({ type: 'approval_request', taskId: task.id, approval })
})

const answerApproval = (task: typeof tasks[number], approvalId: string, responseBody: Record<string, unknown>) => {
  const pending = pendingApprovalRequests.get(approvalId)
  if (!pending || pending.taskId !== task.id) throw new Error('Approval request is no longer pending')
  let response: Record<string, unknown>
  let decision: 'accept' | 'decline' = responseBody.decision === 'accept' || responseBody.action === 'accept' ? 'accept' : 'decline'
  if (pending.kind === 'mcp_form') {
    const action = responseBody.action
    if (action !== 'accept' && action !== 'decline' && action !== 'cancel') throw new Error('Invalid elicitation action')
    decision = action === 'accept' ? 'accept' : 'decline'
    const content = asRecord(responseBody.content)
    if (action === 'accept') {
      if (!content || !pending.requestedSchema) throw new Error('Form response is incomplete')
      const properties = asRecord(pending.requestedSchema.properties) ?? {}
      const required = Array.isArray(pending.requestedSchema.required) ? pending.requestedSchema.required.filter((key): key is string => typeof key === 'string') : []
      for (const key of required) if (content[key] === undefined || content[key] === '') throw new Error(`Required field is missing: ${key}`)
      for (const [key, value] of Object.entries(content)) {
        const property = asRecord(properties[key]); if (!property) throw new Error(`Unknown form field: ${key}`)
        const type = property.type
        const valid = type === 'boolean' ? typeof value === 'boolean' : type === 'number' || type === 'integer' ? typeof value === 'number' && Number.isFinite(value) && (type !== 'integer' || Number.isInteger(value)) : typeof value === 'string'
        if (!valid || (Array.isArray(property.enum) && !property.enum.includes(value))) throw new Error(`Invalid value for form field: ${key}`)
      }
    }
    response = { action, content: action === 'accept' ? content : null, _meta: null }
  } else if (pending.kind === 'mcp_url') {
    const action = responseBody.action
    if (action !== 'accept' && action !== 'decline' && action !== 'cancel') throw new Error('Invalid elicitation action')
    decision = action === 'accept' ? 'accept' : 'decline'
    response = { action, content: null, _meta: null }
  } else if (pending.kind === 'user_input') {
    const rawAnswers = asRecord(responseBody.answers)
    if (!rawAnswers || !pending.questions) throw new Error('Answers are required')
    const answers: Record<string, { answers: string[] }> = {}
    for (const question of pending.questions) {
      const item = asRecord(rawAnswers[question.id])
      if (!item || !Array.isArray(item.answers) || !item.answers.every(answer => typeof answer === 'string')) throw new Error(`Answer missing for question: ${question.id}`)
      answers[question.id] = { answers: item.answers }
    }
    response = { answers }
    decision = 'accept'
  } else {
    if (responseBody.decision !== 'accept' && responseBody.decision !== 'decline') throw new Error('Decision must be accept or decline')
    decision = responseBody.decision
    response = makeApprovalResponse(pending.kind, decision, pending.requestedPermissions)
  }
  codex.respondToServerRequest(pending.rpcId, response)
  pendingApprovalRequests.delete(approvalId)
  const remaining = (task.pendingApprovals ?? []).filter(approval => approval.id !== approvalId)
  task.pendingApprovals = remaining
  task.status = remaining.length ? 'waiting_for_approval' : 'running'
  task.lastActivityAt = new Date().toISOString()
  if (task.status === 'running') resumeTaskTimer(task)
  persist(task.projectId)
  broadcast({ type: 'approval_resolved', taskId: task.id, approvalId, decision })
  broadcastTaskStatus(task)
}

const startCodexTask = (task: typeof tasks[number], prompt: string, projectPath: string) => {
  activeCodexTasks.add(task.id)
  void codex.startThread(projectPath)
    .then(threadId => { assignRemoteSession(task, threadId); persist(task.projectId); broadcast({ type: 'task_session_started', taskId: task.id, sessionId: threadId }); return codex.startTurn(threadId, prompt, projectPath, task.model, task.reasoningEffort) })
    .catch(error => failTask(task, error))
}

const forgetTaskApprovals = (task: typeof tasks[number]) => {
  for (const approval of task.pendingApprovals ?? []) {
    pendingApprovalRequests.delete(approval.id)
    broadcast({ type: 'approval_resolved', taskId: task.id, approvalId: approval.id })
  }
  task.pendingApprovals = []
}

codex.onNotification(message => {
  const params = message.params ?? {}
  const threadId = typeof params.threadId === 'string' ? params.threadId : undefined
  const task = tasks.find(item => item.remoteSessionId === threadId)
  if (!task) return
  if (message.method === 'serverRequest/resolved' && (typeof params.requestId === 'string' || typeof params.requestId === 'number')) {
    const resolvedId = params.requestId
    const pendingApproval = [...pendingApprovalRequests.entries()].find(([, pending]) => pending.taskId === task.id && pending.rpcId === resolvedId)
    if (pendingApproval) {
      pendingApprovalRequests.delete(pendingApproval[0])
      const remaining = (task.pendingApprovals ?? []).filter(approval => approval.id !== pendingApproval[0])
      task.pendingApprovals = remaining
      if (remaining.length === 0 && task.status === 'waiting_for_approval') { task.status = 'running'; resumeTaskTimer(task) }
      persist(task.projectId)
      broadcast({ type: 'approval_resolved', taskId: task.id, approvalId: pendingApproval[0] })
      broadcastTaskStatus(task)
    }
  }
  const item = asRecord(params.item)
  if ((message.method === 'item/started' || message.method === 'item/completed') && item) {
    const completed = message.method === 'item/completed'
    const progress = formatCodexProgress(item, completed)
    if (item.type === 'fileChange' && typeof item.id === 'string') {
      const changes = normalizeFileChanges(item.changes)
      const text = formatFileChangeProgress(changes)
      if (text || !completed) upsertProgressEvent(task.id, item.id, text || progress, completed ? 'completed' : 'running', 'change')
    } else if (progress) {
      const exitCode = typeof item.exitCode === 'number' ? item.exitCode : undefined
      const command = typeof item.command === 'string' ? item.command : ''
      const isTest = item.type === 'commandExecution' && /\b(test|vitest|jest|pytest|playwright|cypress|cargo test|go test)\b/i.test(command)
      const logType = exitCode !== undefined && exitCode !== 0 ? 'error'
        : isTest ? 'test'
          : item.type === 'commandExecution' ? 'command'
            : item.type === 'fileChange' ? 'change'
              : item.type === 'webSearch' || item.type === 'mcpToolCall' ? 'tool' : 'status'
      const output = completed
        ? typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput
          : [item.stdout, item.stderr].filter((value): value is string => typeof value === 'string').join('\n')
        : ''
      appendEvent({
        id: `event-${randomUUID()}`,
        taskId: task.id,
        type: exitCode !== undefined && exitCode !== 0 ? 'error' : item.type === 'fileChange' ? 'file_change' : isTest ? 'test_result' : 'assistant_message',
        payload: { text: output ? `${progress}\n\n${output}` : progress, method: 'relay/progress', progressState: completed ? 'completed' : 'running', logType, itemId: typeof item.id === 'string' ? item.id : undefined },
        sequence: 0,
        createdAt: new Date().toISOString(),
      })
    }
  }
  if (message.method === 'item/started' && item?.type === 'fileChange' && typeof item.id === 'string') {
    const changes = normalizeFileChanges(item.changes)
    if (changes) fileChangePreviews.set(`${threadId}:${item.id}`, changes)
  }
  if (message.method === 'item/fileChange/patchUpdated' && typeof params.itemId === 'string') {
    const changes = normalizeFileChanges(params.changes)
    if (changes) {
      const key = `${threadId}:${params.itemId}`
      fileChangePreviews.set(key, changes)
      const progressText = formatFileChangeProgress(changes)
      if (progressText) upsertProgressEvent(task.id, params.itemId, progressText, 'running')
      const pending = task.pendingApprovals?.find(approval => approval.kind === 'file_change' && pendingApprovalRequests.get(approval.id)?.itemId === params.itemId)
      if (pending) {
        pending.changes = changes
        persist(task.projectId)
        broadcast({ type: 'approval_updated', taskId: task.id, approval: pending })
      }
    }
  }
  if (message.method === 'item/completed') {
    const completedItem = asRecord(params.item)
    const itemId = typeof completedItem?.id === 'string' ? completedItem.id : typeof params.itemId === 'string' ? params.itemId : undefined
    if (itemId) fileChangePreviews.delete(`${threadId}:${itemId}`)
  }
  const turn = params.turn as { id?: string } | undefined
  if (message.method === 'turn/started' && turn?.id) { task.activeTurnId = turn.id; resumeTaskTimer(task); persist(task.projectId) }
  if (message.method === 'turn/completed') { const now = new Date(); pauseTaskTimer(task, now); forgetTaskApprovals(task); for (const key of fileChangePreviews.keys()) if (key.startsWith(`${threadId}:`)) fileChangePreviews.delete(key); task.activeTurnId = undefined; task.status = 'completed'; task.lastActivityAt = now.toISOString(); activeCodexTasks.delete(task.id); persist(task.projectId); broadcastTaskStatus(task) }
  const delta = typeof params.delta === 'string' ? params.delta : undefined
  const itemId = typeof params.itemId === 'string' ? params.itemId : typeof item?.id === 'string' ? item.id : undefined
  if (delta) appendEvent({ id: `event-${randomUUID()}`, taskId: task.id, type: 'assistant_message', payload: { text: delta, method: message.method, itemId }, sequence: 0, createdAt: new Date().toISOString() })
})

app.use(express.static(resolve(process.cwd(), 'dist/web')))
app.get('/api/auth/status', (_request, response) => response.json({ required: Boolean(authToken) }))
app.post('/api/auth/verify', (request, response) => authorized(request.headers)
  ? response.json({ ok: true })
  : response.status(401).json({ error: 'Invalid access token' }))
app.get('/api/health', (_request, response) => {
  response.json({ ok: true, mode: 'local-codex', service: 'relay-backend', codex: process.env.CODEX_BIN ?? 'codex' })
})
app.use((request, response, next) => authorized(request.headers) ? next() : response.status(401).json({ error: 'Unauthorized' }))
app.use(express.json({ limit: '64kb' }))

app.get('/api/settings/approvals', (_request, response) => response.json(approvalSettings))
app.put('/api/settings/approvals', (request, response) => {
  if (typeof request.body?.autoApproveConfirmations !== 'boolean') return response.status(400).json({ error: 'autoApproveConfirmations must be a boolean' })
  const nextSettings = { autoApproveConfirmations: request.body.autoApproveConfirmations }
  writeApprovalSettings(nextSettings)
  approvalSettings = nextSettings
  broadcast({ type: 'approval_settings', settings: approvalSettings })
  return response.json(approvalSettings)
})

app.get('/api/environment', async (_request, response) => {
  const [codexState, claudeState, nodeState, gitState] = await Promise.all([
    commandVersion('codex'), commandVersion('claude'), commandVersion('node'), commandVersion('git'),
  ])
  const tool = (id: EnvironmentTool, state: { installed: boolean; version?: string }) => ({ id, label: environmentTools[id].label, ...state, ...(environmentInstalls.get(id) ?? {}) })
  return response.json({ tools: [tool('codex', codexState), tool('claude', claudeState)], requirements: [{ label: 'Node.js', ...nodeState }, { label: 'Git', ...gitState }] })
})

app.post('/api/environment/:tool/install', (request, response) => {
  const toolId = request.params.tool as EnvironmentTool
  const tool = environmentTools[toolId]
  if (!tool) return response.status(404).json({ error: 'Unknown environment tool' })
  if (environmentInstalls.get(toolId)?.status === 'installing') return response.status(409).json({ error: `${tool.label} installation is already running` })
  environmentInstalls.set(toolId, { status: 'installing' })
  const child = spawn('npm', ['install', '--global', tool.packageName], { env: process.env, stdio: 'pipe' })
  let output = ''
  child.stdout.on('data', chunk => { output += String(chunk) })
  child.stderr.on('data', chunk => { output += String(chunk) })
  child.once('error', error => environmentInstalls.set(toolId, { status: 'failed', detail: error.message }))
  child.once('exit', code => {
    if (code === 0) environmentInstalls.delete(toolId)
    else environmentInstalls.set(toolId, { status: 'failed', detail: output.trim().slice(-500) || `npm exited with code ${code ?? 'unknown'}` })
  })
  return response.status(202).json({ accepted: true, message: `Installing ${tool.label}…` })
})

app.get('/api/account/rate-limits', async (_request, response) => {
  try { return response.json(await codex.readRateLimits()) }
  catch (error) { return response.status(503).json({ error: error instanceof Error ? error.message : 'Codex account limits are unavailable' }) }
})

app.get('/api/models', async (_request, response) => {
  try { return response.json({ items: await codex.listModels() }) }
  catch (error) { return response.status(503).json({ error: error instanceof Error ? error.message : 'Unable to load Codex models' }) }
})

app.get('/api/machines', (_request, response) => response.json({ items: machines }))

app.get('/api/machines/:machineId', (request, response) => {
  const machine = machines.find(item => item.id === request.params.machineId)
  if (!machine) return response.status(404).json({ error: 'Machine not found' })
  return response.json(machine)
})

app.get('/api/projects', (request, response) => {
  const machineId = typeof request.query.machineId === 'string' ? request.query.machineId : undefined
  return response.json({ items: machineId ? projects.filter(project => project.machineId === machineId) : projects })
})

app.get('/api/projects/:projectId', (request, response) => {
  const project = projects.find(item => item.id === request.params.projectId)
  if (!project) return response.status(404).json({ error: 'Project not found' })
  return response.json(project)
})

app.get('/api/directories', (request, response) => {
  try {
    const requestedPath = typeof request.query.path === 'string' ? request.query.path : undefined
    return response.json(listDirectories(requestedPath))
  } catch (error) { return response.status(400).json({ error: error instanceof Error ? error.message : 'Unable to list directories' }) }
})

app.post('/api/projects/select', (request, response) => {
  try {
    const projectPath = validateProjectPath(typeof request.body?.path === 'string' ? request.body.path : '')
    saveSelectedProject(projectPath)
    refreshProjects(projectPath)
    const localProject = projects.find(project => project.path === projectPath)
    if (!localProject) throw new Error('Selected project is unavailable')
    hydrateProjectCache(localProject)
    const discovered = discoverCodexTasks(localProject.id, localProject.path)
    addDiscoveredTasks(discovered)
    persist(localProject.id)
    return response.json(localProject)
  } catch (error) { return response.status(400).json({ error: error instanceof Error ? error.message : 'Unable to select project' }) }
})

app.delete('/api/projects/:projectId', (request, response) => {
  const project = projects.find(item => item.id === request.params.projectId)
  if (!project) return response.status(404).json({ error: 'Project not found' })
  if (projects.length < 2) return response.status(409).json({ error: 'Keep at least one workspace' })
  if (tasks.some(task => task.projectId === project.id && (task.status === 'running' || task.status === 'waiting_for_approval'))) return response.status(409).json({ error: 'Finish or interrupt this workspace’s active task before removing it' })
  try {
    const nextPath = removeSavedProject(project.path)
    refreshProjects(nextPath)
    const taskIds = new Set(tasks.filter(task => task.projectId === project.id).map(task => task.id))
    for (let index = tasks.length - 1; index >= 0; index--) if (taskIds.has(tasks[index].id)) tasks.splice(index, 1)
    for (let index = events.length - 1; index >= 0; index--) if (taskIds.has(events[index].taskId)) events.splice(index, 1)
    for (const taskId of taskIds) eventSequences.delete(taskId)
    loadedProjectIds.delete(project.id)
    return response.status(204).end()
  } catch (error) { return response.status(400).json({ error: error instanceof Error ? error.message : 'Unable to remove workspace' }) }
})

app.get('/api/projects/:projectId/tasks', (request, response) => {
  const project = projects.find(item => item.id === request.params.projectId)
  if (project) {
    hydrateProjectCache(project)
    const discovered = discoverCodexTasks(project.id, project.path)
    addDiscoveredTasks(discovered)
    persist(project.id)
  }
  return response.json({ items: tasks.filter(task => task.projectId === request.params.projectId).map(({ tokenUsage: _tokenUsage, ...task }) => ({
    ...task,
    title: stripInjectedPromptContext(task.title),
  })) })
})

app.get('/api/tasks/:taskId/events', (request, response) => {
  const items = events.filter(event => event.taskId === request.params.taskId).sort((a, b) => a.sequence - b.sequence).slice(-1_000).flatMap(event => {
    if (typeof event.payload?.text !== 'string') return event
      const text = event.type === 'user_message' ? stripInjectedPromptContext(event.payload.text) : event.payload.text
    return text ? [{ ...event, payload: { ...event.payload, text } }] : []
  })
  return response.json({ items })
})

app.delete('/api/tasks/:taskId', (request, response) => {
  const taskIndex = tasks.findIndex(item => item.id === request.params.taskId)
  if (taskIndex < 0) return response.status(404).json({ error: 'Task not found' })
  const task = tasks[taskIndex]
  if (task.status === 'running' || task.status === 'waiting_for_approval' || activeCodexTasks.has(task.id)) {
    return response.status(409).json({ error: 'Interrupt or finish this task before deleting it' })
  }
  for (const sessionId of [task.remoteSessionId, ...(task.remoteSessionAliases ?? [])]) if (sessionId) hiddenCodexSessionIds.add(sessionId)
  activeCodexTasks.delete(task.id)
  for (const [approvalId, pending] of pendingApprovalRequests) if (pending.taskId === task.id) pendingApprovalRequests.delete(approvalId)
  for (const sessionId of [task.remoteSessionId, ...(task.remoteSessionAliases ?? [])]) {
    if (!sessionId) continue
    for (const key of fileChangePreviews.keys()) if (key.startsWith(`${sessionId}:`)) fileChangePreviews.delete(key)
  }
  tasks.splice(taskIndex, 1)
  for (let index = events.length - 1; index >= 0; index--) if (events[index].taskId === task.id) events.splice(index, 1)
  eventSequences.delete(task.id)
  persist(task.projectId)
  broadcast({ type: 'task_deleted', taskId: task.id })
  return response.status(204).end()
})

app.get('/api/tasks/:taskId/history', async (request, response) => {
  const task = tasks.find(item => item.id === request.params.taskId)
  if (!task) return response.status(404).json({ error: 'Task not found' })
  if (!task.remoteSessionId) return response.json({ thread: null })
  const localHistory = readCodexSessionHistory(task.remoteSessionId)
  if (localHistory.length) return response.json({ items: localHistory, source: 'local_transcript' })
  try {
    const result = await codex.readThread(task.remoteSessionId)
    const source = result as { thread?: { turns?: Array<{ items?: Array<Record<string, unknown>> }> }; turns?: Array<{ items?: Array<Record<string, unknown>> }> }
    const turns = source.thread?.turns ?? source.turns ?? []
    const items: Array<{ role: 'user' | 'assistant'; text: string }> = turns.flatMap(turn => turn.items ?? []).flatMap(item => {
      const type = typeof item.type === 'string' ? item.type : ''
      if (type !== 'userMessage' && type !== 'agentMessage') return []
      const content = Array.isArray(item.content) ? item.content : []
      const rawText = content.map(part => typeof part === 'object' && part && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : '').filter(Boolean).join('\n')
      const text = type === 'userMessage' ? stripInjectedPromptContext(rawText) : rawText
      return text ? [{ role: type === 'userMessage' ? 'user' : 'assistant', text }] : []
    })
    return response.json({ items: items.slice(-100) })
  }
  catch (error) {
    const localHistory = readCodexSessionHistory(task.remoteSessionId)
    if (localHistory.length) return response.json({ items: localHistory, source: 'local_transcript' })
    return response.status(503).json({ error: error instanceof Error ? error.message : 'Unable to read Codex session history' })
  }
})

app.get('/api/tasks/:taskId/usage', (request, response) => {
  const task = tasks.find(item => item.id === request.params.taskId)
  if (!task) return response.status(404).json({ error: 'Task not found' })
  if (!task.remoteSessionId) return response.json({ tokenUsage: null })
  return response.json({ tokenUsage: readCodexSessionTokenUsage(task.remoteSessionId) ?? null })
})

app.patch('/api/tasks/:taskId/model', (request, response) => {
  const task = tasks.find(item => item.id === request.params.taskId)
  if (!task) return response.status(404).json({ error: 'Task not found' })
  if (task.agent !== 'Codex') return response.status(400).json({ error: 'Model selection is only supported for Codex tasks' })
  if (task.status === 'running' || task.status === 'waiting_for_approval') return response.status(409).json({ error: 'Interrupt or finish the current turn before changing its model' })
  const model = typeof request.body?.model === 'string' ? request.body.model.trim() : ''
  const reasoningEffort = typeof request.body?.reasoningEffort === 'string' ? request.body.reasoningEffort.trim() : ''
  if (!model || model.length > 200) return response.status(400).json({ error: 'A valid model is required' })
  if (!reasoningEffort || reasoningEffort.length > 100) return response.status(400).json({ error: 'A valid reasoning level is required' })
  task.model = model
  task.reasoningEffort = reasoningEffort
  persist(task.projectId)
  return response.json(task)
})

app.post('/api/projects/:projectId/tasks', (request, response) => {
  const project = projects.find(item => item.id === request.params.projectId)
  const title = typeof request.body?.title === 'string' ? stripInjectedPromptContext(request.body.title) : ''
  const model = typeof request.body?.model === 'string' ? request.body.model.trim() : undefined
  const reasoningEffort = typeof request.body?.reasoningEffort === 'string' ? request.body.reasoningEffort.trim() : undefined
  const agent: AgentName = request.body?.agent === 'Claude' ? 'Claude' : 'Codex'
  if (!project) return response.status(404).json({ error: 'Project not found' })
  if (!title) return response.status(400).json({ error: 'Task title is required' })
  if (agent !== 'Codex') return response.status(501).json({ error: 'Claude provider is not implemented yet' })

  const now = new Date().toISOString()
  const task = { id: `task-${randomUUID()}`, projectId: project.id, title, agent, ...(model ? { model } : {}), ...(reasoningEffort ? { reasoningEffort } : {}), status: 'running' as const, createdAt: now, lastActivityAt: now, executionStartedAt: now, executionDurationMs: 0 }
  tasks.unshift(task)
  appendEvent({ id: `event-${randomUUID()}`, taskId: task.id, type: 'user_message', payload: { text: title }, sequence: 0, createdAt: now })
  if (agent === 'Codex') startCodexTask(task, title, project.path)
  return response.status(201).json(task)
})

app.post('/api/tasks/:taskId/messages', (request, response) => {
  const task = tasks.find(item => item.id === request.params.taskId)
  const message = typeof request.body?.message === 'string' ? stripInjectedPromptContext(request.body.message) : ''
  const model = typeof request.body?.model === 'string' ? request.body.model.trim() : undefined
  const reasoningEffort = typeof request.body?.reasoningEffort === 'string' ? request.body.reasoningEffort.trim() : undefined
  if (!task) return response.status(404).json({ error: 'Task not found' })
  if (!message) return response.status(400).json({ error: 'Message is required' })

  const event: SessionEvent = { id: `event-${randomUUID()}`, taskId: task.id, type: 'user_message', payload: { text: message }, sequence: 0, createdAt: new Date().toISOString() }
  if (model) task.model = model
  if (reasoningEffort) task.reasoningEffort = reasoningEffort
  appendEvent(event)
  task.lastActivityAt = event.createdAt
  if (task.status !== 'running') resumeTaskTimer(task, new Date(event.createdAt))
  if (task.status !== 'running') {
    task.status = 'running'
    persist(task.projectId)
    broadcastTaskStatus(task)
  }
  if (task.agent === 'Codex') {
    const projectPath = projects.find(project => project.id === task.projectId)?.path ?? process.cwd()
    activeCodexTasks.add(task.id)
    if (task.activeTurnId && task.remoteSessionId) {
      void codex.steerTurn(task.remoteSessionId, task.activeTurnId, message)
        .catch(async error => {
          if (!isThreadNotFound(error)) throw error
          const restoredThreadId = await restoreThreadFromLocalTranscript(task, projectPath)
          await codex.startTurn(restoredThreadId, message, projectPath, task.model, task.reasoningEffort)
        })
        .catch(error => failTask(task, error))
    } else if (task.remoteSessionId) {
      void resumeOrRestoreThread(task, projectPath, message).catch(error => failTask(task, error))
    } else startCodexTask(task, message, projectPath)
  }
  return response.status(202).json({ accepted: true, event })
})

app.post('/api/tasks/:taskId/approvals/:approvalId', (request, response) => {
  const task = tasks.find(item => item.id === request.params.taskId)
  if (!task) return response.status(404).json({ error: 'Task not found' })
  const body = asRecord(request.body)
  if (!body) return response.status(400).json({ error: 'Response body is required' })
  const approval = task.pendingApprovals?.find(item => item.id === request.params.approvalId)
  if (!approval || !pendingApprovalRequests.has(approval.id)) return response.status(404).json({ error: 'Approval request is no longer pending' })
  const wantsAccept = body.decision === 'accept' || body.action === 'accept' || (approval.kind === 'user_input' && body.answers !== undefined)
  if (wantsAccept && !approval.canApprove) return response.status(409).json({ error: 'This request cannot safely be accepted in Relay' })
  try {
    answerApproval(task, approval.id, body)
    return response.status(202).json({ accepted: true })
  } catch (error) {
    return response.status(503).json({ error: error instanceof Error ? error.message : 'Unable to answer Codex approval request' })
  }
})

app.post('/api/tasks/:taskId/interrupt', (request, response) => {
  const task = tasks.find(item => item.id === request.params.taskId)
  if (!task) return response.status(404).json({ error: 'Task not found' })
  if (!task.remoteSessionId || !task.activeTurnId) return response.status(409).json({ error: 'Task has no active Codex turn' })
  for (const approval of task.pendingApprovals ?? []) {
    const pending = pendingApprovalRequests.get(approval.id)
    if (!pending) continue
    try { codex.respondToServerRequest(pending.rpcId, makeApprovalResponse(pending.kind, 'decline', pending.requestedPermissions)) }
    catch (error) { return response.status(503).json({ error: error instanceof Error ? error.message : 'Unable to decline pending approval' }) }
    pendingApprovalRequests.delete(approval.id)
  }
  task.pendingApprovals = []
  pauseTaskTimer(task)
  void codex.interruptTurn(task.remoteSessionId, task.activeTurnId).catch(error => failTask(task, error))
  task.status = 'interrupted'
  task.activeTurnId = undefined
  task.lastActivityAt = new Date().toISOString()
  activeCodexTasks.delete(task.id)
  persist(task.projectId)
  broadcastTaskStatus(task)
  return response.status(202).json({ accepted: true })
})
websocket.on('connection', socket => {
  const sendReady = () => {
    authenticatedSockets.add(socket)
    socket.send(JSON.stringify({ type: 'connection_ready', payload: { mode: 'local-codex' } }))
  }
  if (!authToken) { sendReady(); return }
  const authenticationTimeout = setTimeout(() => socket.close(1008, 'Authentication required'), 5_000)
  authenticationTimeout.unref()
  socket.once('close', () => clearTimeout(authenticationTimeout))
  socket.once('message', data => {
    let message: { type?: string; token?: string } = {}
    try { message = JSON.parse(data.toString()) as typeof message } catch { /* Close malformed handshakes below. */ }
    if (message.type !== 'authenticate' || message.token !== authToken) {
      clearTimeout(authenticationTimeout)
      socket.close(1008, 'Unauthorized')
      return
    }
    clearTimeout(authenticationTimeout)
    sendReady()
  })
})

server.listen(port, host, () => {
  console.log(`Relay backend listening on http://${host}:${port}`)
  console.log(`WebSocket endpoint: ws://${host}:${port}/ws`)
  if (authToken) console.log(`Relay access token file: ${authTokenPath}`)
  if (!isLoopbackHost) console.warn('Relay is available to devices on your local network. Do not expose port 3000 to the public internet.')
})

const shutdown = () => { codex.stop(); server.close(() => process.exit(0)) }
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
