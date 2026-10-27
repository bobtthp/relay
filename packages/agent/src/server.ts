import express from 'express'
import { createServer } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { execFile, spawn } from 'node:child_process'
import os from 'node:os'
import path, { resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { WebSocket, WebSocketServer } from 'ws'
import { events, machines, projects, refreshProjects, tasks } from './local-state.js'
import type { AgentName, PendingApproval, SessionEvent } from '../../protocol/src/types.js'
import { CodexAppServer, type RpcId } from './codex-app-server.js'
import { ClaudeRunner, ClaudeUnavailableError, type ClaudeToolRequest } from './claude-runner.js'
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import { loadProjectCache, saveProjectCache, type DeletedTask } from './project-cache.js'
import { discoverCodexTasks, readCodexSessionHistory, readCodexSessionHistoryPage, readCodexSessionTokenUsage, refreshCodexSessionCache, stripInjectedPromptContext } from './codex-history.js'
import { listDirectories, removeSavedProject, saveSelectedProject, validateProjectPath } from './local-project.js'
import { readApprovalSettings, writeApprovalSettings } from './approval-settings.js'
import { buildHandoff, checkpointDirectory, checkpointRule } from './handoff.js'
import { MemoryConflictError, MemoryWatcher, applyConsolidation, consolidationInstructions, consolidationPrompt, discardConsolidation, memoryStats, parseConsolidationPlan, readConsolidation, storeConsolidationProposal, claudeMemoryPromptAppend, codexMemoryInstructions, deleteMemoryEntry, estimateTokens, memoryPrimer, importClaudeMemories, listMemoryEntries, memoryDirectory, previewClaudeImport, readMemoryAudit, readMemoryIndex, readMemorySettings, rollbackClaudeImport, setMemoryEnabled, touchesMemory, writeMemoryEntry } from './project-memory.js'
import { DEEPSEEK_ENV_KEY, DEEPSEEK_PROVIDER_ID, deepseekModels, deepseekProviderOverrides, effectiveDeepSeekKey, isDeepSeekModel, normalizeProxyUrl, providerSettingsStatus, proxyEnvironment, readProviderSettings, writeProviderSettings } from './provider-settings.js'
import { deleteProjectImage, listProjectImages, projectImagePath, saveProjectImage } from './project-images.js'
import { createProjectImageShare, deleteProjectImageShare, projectIdForImageShare, projectImageShare } from './project-image-shares.js'

const app = express()
const server = createServer(app)
const imageUploadBody = express.raw({ type: ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/octet-stream'], limit: '10mb' })
const publicImageUploadAttempts = new Map<string, number[]>()
const HISTORY_PAGE_SIZE = 10
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
let shuttingDown = false
// Event deltas arrive frequently. Keep the per-task sequence in memory so
// appending an event stays O(1) instead of rescanning the full event log.
const eventSequences = new Map<string, number>()
const hiddenCodexSessionIds = new Set<string>()
const deletedTasks: DeletedTask[] = []
let providerSettings = readProviderSettings()
const claude = new ClaudeRunner(() => ({ ...process.env, ...proxyEnvironment(providerSettings) }))
const codex = new CodexAppServer(() => {
  const deepseekKey = effectiveDeepSeekKey(providerSettings)
  return { env: { ...process.env, ...proxyEnvironment(providerSettings), ...(deepseekKey ? { [DEEPSEEK_ENV_KEY]: deepseekKey } : {}) }, configOverrides: deepseekProviderOverrides }
})
// Codex reads provider keys from its environment at launch, so a changed key
// needs a fresh app-server. Wait for active turns so none are cut off.
let codexRestartPending = false
const restartCodexWhenIdle = () => {
  if (!codexRestartPending || activeCodexTasks.size > 0) return
  codexRestartPending = false
  codex.restart()
}
// Threads keep the provider they were started with, so switching between a
// DeepSeek model and a ChatGPT model must name the provider on resume.
const modelProviderForTask = (task: { model?: string; modelProvider?: string }) => isDeepSeekModel(task.model)
  ? DEEPSEEK_PROVIDER_ID
  : task.modelProvider === DEEPSEEK_PROVIDER_ID ? 'openai' : undefined
const rememberModelProvider = (task: typeof tasks[number]) => { task.modelProvider = isDeepSeekModel(task.model) ? DEEPSEEK_PROVIDER_ID : undefined }
// Shared memory is applied on thread/start and thread/resume alike, so a
// resumed thread sees the same memory as a new one.
const addMemoryTokens = (task: typeof tasks[number], kind: 'injected' | 'tools', text: string) => {
  const tokens = estimateTokens(text)
  if (!tokens) return
  const current = task.memoryTokens ?? { injected: 0, tools: 0 }
  task.memoryTokens = { ...current, [kind]: current[kind] + tokens }
}
// developerInstructions only take effect on thread/start (thread/resume ignores
// them for an existing thread), so only a new thread is counted and marked.
/** Directories outside the project that Relay lets agents write: shared memory and task checkpoints. */
const relayWritableRoots = (projectPath: string) => [
  ...(readMemorySettings(projectPath).enabled ? [memoryDirectory(projectPath)] : []),
  ...(providerSettings.checkpointsEnabled ? [checkpointDirectory(projectPath)] : []),
]
const codexThreadOptions = (task: { model?: string; modelProvider?: string }, projectPath: string, newThreadFor?: typeof tasks[number]) => {
  const developerInstructions = readMemorySettings(projectPath).enabled ? codexMemoryInstructions(projectPath) : undefined
  if (developerInstructions && newThreadFor) {
    addMemoryTokens(newThreadFor, 'injected', developerInstructions)
    newThreadFor.memorySession = memoryDirectory(projectPath)
  }
  const writableRoots = relayWritableRoots(projectPath)
  return { modelProvider: modelProviderForTask(task), ...(developerInstructions ? { developerInstructions } : {}), ...(writableRoots.length ? { writableRoots } : {}) }
}
/**
 * thread/resume ignores writable_roots for an existing thread, so a thread that
 * predates shared memory would need an approval for every memory write. Extend
 * its own workspace-write policy with the memory directory; other modes are
 * left alone (full access can already write, read-only stays read-only).
 */
const memorySandboxPolicy = (resumed: Record<string, unknown>, projectPath: string) => {
  const wanted = relayWritableRoots(projectPath)
  const sandbox = asRecord(resumed.sandbox)
  if (!wanted.length || sandbox?.type !== 'workspaceWrite') return undefined
  const roots = Array.isArray(sandbox.writableRoots) ? sandbox.writableRoots.filter((root): root is string => typeof root === 'string') : []
  const missing = wanted.filter(directory => !roots.includes(directory))
  return missing.length ? { ...sandbox, writableRoots: [...roots, ...missing] } : undefined
}
/**
 * Builds what the agent receives for a new turn: the handoff after an agent
 * switch (facts Relay recorded since that agent last worked on the task) and
 * the checkpoint rule once per agent session. Both are stripped from history.
 */
const prepareAgentPrompt = (task: typeof tasks[number], projectPath: string, message: string, currentEventId?: string) => {
  let prefix = ''
  if (task.handoffPending) {
    const since = task.handoffPending.sinceSequence
    const taskEvents = events.filter(event => event.taskId === task.id && event.sequence > since && event.id !== currentEventId).sort((a, b) => a.sequence - b.sequence)
    prefix += buildHandoff({ from: task.handoffPending.from, to: task.agent, projectPath, taskId: task.id, events: taskEvents })
    task.handoffPending = undefined
  }
  if (providerSettings.checkpointsEnabled && !task.checkpointSession) {
    prefix += checkpointRule(projectPath, task.id)
    task.checkpointSession = true
  }
  if (prefix) task.handoffTokens = (task.handoffTokens ?? 0) + estimateTokens(prefix)
  return prefix + message
}

/** Prepends the one-time memory note when this task's session predates shared memory. */
const withMemoryPrimer = (task: typeof tasks[number], projectPath: string, prompt: string) => {
  if (!readMemorySettings(projectPath).enabled || task.memorySession === memoryDirectory(projectPath)) return prompt
  const primer = memoryPrimer(task.agent, projectPath)
  addMemoryTokens(task, 'injected', primer)
  task.memorySession = memoryDirectory(projectPath)
  return primer + prompt
}
const projectPathOf = (task: typeof tasks[number]) => projects.find(project => project.id === task.projectId)?.path
let approvalSettings = readApprovalSettings()
const automaticApprovalKinds = new Set<PendingApproval['kind']>(['command', 'file_change', 'permissions'])
type PendingApprovalRequest = {
  taskId: string
  itemId: string
  kind: PendingApproval['kind']
  requestedPermissions?: Record<string, unknown>
  requestedSchema?: Record<string, unknown>
  questions?: NonNullable<PendingApproval['questions']>
  /** Codex approvals are answered over JSON-RPC. */
  rpcId?: RpcId
  /** Claude approvals resolve the SDK's canUseTool promise. */
  claude?: { input: Record<string, unknown>; resolve: (result: PermissionResult) => void }
}
const pendingApprovalRequests = new Map<string, PendingApprovalRequest>()
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
// Agents write memory files directly; the watcher attributes each change to the
// agent running in that project and keeps MEMORY.md in sync.
const memoryWatcher = new MemoryWatcher(projectPath => {
  const project = projects.find(item => item.path === projectPath)
  const agents = new Set<'Claude' | 'Codex'>()
  for (const task of tasks) if (project && task.projectId === project.id && activeCodexTasks.has(task.id)) agents.add(task.agent)
  return agents
}, projectPath => {
  const project = projects.find(item => item.path === projectPath)
  if (project) broadcast({ type: 'memory_changed', projectId: project.id })
})
const loadedProjectIds = new Set<string>()
const loadedTaskIds = new Set(tasks.map(task => task.id))
const loadedEventIds = new Set(events.map(event => event.id))
const hydrateProjectCache = (project: typeof projects[number]) => {
  if (loadedProjectIds.has(project.id)) return
  loadedProjectIds.add(project.id)
  if (readMemorySettings(project.path).enabled) memoryWatcher.watch(project.path)
  const cached = loadProjectCache(project.path)
  if (!cached) return
  for (const deleted of cached.deletedTasks ?? []) {
    deleted.task.projectId = project.id
    if (!deletedTasks.some(item => item.task.id === deleted.task.id)) deletedTasks.push(deleted)
  }
  for (const task of cached.tasks) {
    task.projectId = project.id
    if (task.status === 'running' || task.status === 'waiting_for_approval') {
      if (task.executionStartedAt) {
        const startedAt = Date.parse(task.executionStartedAt)
        if (Number.isFinite(startedAt)) task.executionDurationMs = (task.executionDurationMs ?? 0) + Math.max(0, Date.now() - startedAt)
      }
      task.status = 'interrupted'
      task.executionStartedAt = undefined
      task.activeTurnId = undefined
      task.pendingApprovals = []
    }
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
  saveProjectCache(project.path, {
    tasks: projectTasks,
    events: events.filter(event => projectTaskIds.has(event.taskId)),
    hiddenCodexSessionIds: [...hiddenCodexSessionIds],
    deletedTasks: deletedTasks.filter(deleted => deleted.task.projectId === project.id),
  })
}
for (const project of projects) hydrateProjectCache(project)
const websocket = new WebSocketServer({ server, path: '/ws' })
const authenticatedSockets = new WeakSet<WebSocket>()

const broadcast = (message: unknown) => {
  const encoded = JSON.stringify(message)
  websocket.clients.forEach(client => { if (client.readyState === WebSocket.OPEN && authenticatedSockets.has(client)) client.send(encoded) })
}

claude.onRateLimits(rateLimits => broadcast({ type: 'claude_rate_limits', rateLimits }))

const broadcastTaskStatus = (task: typeof tasks[number]) => {
  restartCodexWhenIdle()
  broadcastTaskStatusMessage(task)
}
const broadcastTaskStatusMessage = (task: typeof tasks[number]) => broadcast({
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
    deletedTasks: deletedTasks.filter(deleted => deleted.task.projectId === project.id),
  })
}

const eventPersistTimers = new Map<string, { debounce: NodeJS.Timeout; maxWait: NodeJS.Timeout }>()
const scheduleEventPersist = (projectId?: string) => {
  if (!projectId) return
  const project = projects.find(item => item.id === projectId)
  if (!project) return
  const existing = eventPersistTimers.get(projectId)
  if (existing) clearTimeout(existing.debounce)
  const flush = () => {
    const timers = eventPersistTimers.get(projectId)
    if (timers) {
      clearTimeout(timers.debounce)
      clearTimeout(timers.maxWait)
      eventPersistTimers.delete(projectId)
    }
    persist(projectId)
  }
  const debounce = setTimeout(flush, 5_000)
  debounce.unref()
  const maxWait = existing?.maxWait ?? setTimeout(flush, 15_000)
  maxWait.unref()
  eventPersistTimers.set(projectId, { debounce, maxWait })
}

const flushEventPersists = () => {
  const projectIds = [...eventPersistTimers.keys()]
  for (const timers of eventPersistTimers.values()) {
    clearTimeout(timers.debounce)
    clearTimeout(timers.maxWait)
  }
  eventPersistTimers.clear()
  for (const projectId of projectIds) persist(projectId)
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

const appendEvent = (event: SessionEvent) => {
  event.sequence = (eventSequences.get(event.taskId) ?? 0) + 1
  eventSequences.set(event.taskId, event.sequence)
  events.push(event)
  const task = tasks.find(item => item.id === event.taskId)
  if (task && event.type !== 'user_message' && event.payload.agent === undefined) event.payload.agent = task.agent
  scheduleEventPersist(task?.projectId)
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
    scheduleEventPersist(tasks.find(task => task.id === taskId)?.projectId)
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

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
const isQuotaError = (text: string) => /(?:rate.?limit|quota|usage limit|too many requests|capacity|credits?)/i.test(text)
const isLunaModelName = (model?: string) => model?.toLowerCase().includes('luna') === true
const quotaErrorText = (task: typeof tasks[number]) => task.agent === 'Claude'
  ? `Claude usage limit reached for ${task.model ?? 'the current model'}. Wait for the limit to reset or continue in a Codex task.`
  : isLunaModelName(task.model)
  ? `The ${task.model ?? 'Luna'} quota is exhausted. Wait for the quota reset or choose another available model.`
  : `The ${task.model ?? 'current model'} quota is exhausted. Switch to Luna if it still has quota, or wait for the quota reset.`

const failTask = (task: typeof tasks[number], error: unknown) => {
  const now = new Date()
  pauseTaskTimer(task, now)
  if (shuttingDown) {
    task.status = 'interrupted'
    task.activeTurnId = undefined
    task.pendingApprovals = []
    task.lastActivityAt = now.toISOString()
    activeCodexTasks.delete(task.id)
    persist(task.projectId)
    broadcastTaskStatus(task)
    return
  }
  task.status = 'failed'
  task.activeTurnId = undefined
  task.lastActivityAt = now.toISOString()
  activeCodexTasks.delete(task.id)
  persist(task.projectId)
  const originalText = errorText(error)
  const quotaExhausted = isQuotaError(originalText)
  appendEvent({ id: `event-${randomUUID()}`, taskId: task.id, type: 'error', payload: { text: quotaExhausted ? quotaErrorText(task) : originalText, error: true, logType: 'error', ...(quotaExhausted ? { code: 'quota_exhausted', model: task.model } : {}) }, sequence: 0, createdAt: new Date().toISOString() })
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
            : type === 'contextCompaction' ? (completed ? 'Compacted context' : 'Compacting context')
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

const getDefaultMcpFormResponse = (requestedSchema: Record<string, unknown> | undefined) => {
  if (requestedSchema?.type !== 'object') return undefined
  const properties = asRecord(requestedSchema.properties) ?? {}
  const required = Array.isArray(requestedSchema.required)
    ? requestedSchema.required.filter((key): key is string => typeof key === 'string')
    : []
  const content: Record<string, unknown> = {}

  for (const key of required) {
    const property = asRecord(properties[key])
    if (!property || !Object.hasOwn(property, 'default')) return undefined
  }

  for (const [key, rawProperty] of Object.entries(properties)) {
    const property = asRecord(rawProperty)
    if (!property || !Object.hasOwn(property, 'default')) continue
    const value = property.default
    const valid = property.type === 'boolean'
      ? typeof value === 'boolean'
      : property.type === 'number' || property.type === 'integer'
        ? typeof value === 'number' && Number.isFinite(value) && (property.type !== 'integer' || Number.isInteger(value))
        : property.type === 'string' && typeof value === 'string'
    if (!valid || (Array.isArray(property.enum) && !property.enum.includes(value))) return undefined
    content[key] = value
  }

  return { action: 'accept', content, _meta: null }
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
  const restoredThreadId = await codex.startThread(projectPath, codexThreadOptions({ model: task.model }, projectPath, task))
  rememberModelProvider(task)
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
    const resumed = await codex.resumeThread(threadId, projectPath, codexThreadOptions(task, projectPath))
    rememberModelProvider(task)
    await codex.startTurn(threadId, withMemoryPrimer(task, projectPath, prompt), projectPath, task.model, task.reasoningEffort, memorySandboxPolicy(resumed, projectPath))
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
  registerApproval(task, approval, { taskId: task.id, itemId, rpcId: message.id, kind, ...(requestedPermissions ? { requestedPermissions } : {}), ...(requestedSchema ? { requestedSchema } : {}), ...(questions ? { questions } : {}) })
})

const registerApproval = (task: typeof tasks[number], approval: PendingApproval, pending: PendingApprovalRequest) => {
  const { id: requestId, kind } = approval
  pendingApprovalRequests.set(requestId, pending)
  const automaticFormResponse = approvalSettings.autoAcceptDefaultMcpForms && approval.canApprove && kind === 'mcp_form'
    ? getDefaultMcpFormResponse(pending.requestedSchema)
    : undefined
  const automaticResponse = approvalSettings.autoApproveConfirmations && approval.canApprove && automaticApprovalKinds.has(kind)
    ? { decision: 'accept' }
    : automaticFormResponse
  if (automaticResponse) {
    try {
      answerApproval(task, requestId, automaticResponse)
      appendEvent({
        id: `event-${randomUUID()}`,
        taskId: task.id,
        type: 'assistant_message',
        payload: { text: kind === 'mcp_form'
          ? 'Relay automatically accepted this MCP form using its schema defaults.'
          : `Relay automatically approved this ${kind.replace('_', ' ')} request.`, method: 'relay/auto-approval', approvalKind: kind, logType: 'status' },
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
}

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
  if (pending.claude) pending.claude.resolve(claudePermissionResult(pending, decision, response))
  else if (pending.rpcId !== undefined) codex.respondToServerRequest(pending.rpcId, response)
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

const claudeDeniedMessage = 'The user denied this request in Relay. Try another approach or ask the user.'
const claudePermissionResult = (pending: PendingApprovalRequest, decision: 'accept' | 'decline', response: Record<string, unknown>): PermissionResult => {
  const input = pending.claude?.input ?? {}
  if (pending.kind === 'user_input') {
    const answers = asRecord(response.answers) ?? {}
    const byQuestion = Object.fromEntries((pending.questions ?? []).flatMap(question => {
      const selected = asRecord(answers[question.id])?.answers
      const text = Array.isArray(selected) ? selected.filter(item => typeof item === 'string' && item.trim()).join(', ') : ''
      return text ? [[question.question, text]] : []
    }))
    return Object.keys(byQuestion).length ? { behavior: 'allow', updatedInput: { ...input, answers: byQuestion } } : { behavior: 'deny', message: 'The user declined to answer in Relay.' }
  }
  return decision === 'accept' ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: claudeDeniedMessage }
}

const lineDiff = (prefix: '+' | '-', text: string) => text.split('\n').map(line => `${prefix}${line}`).join('\n')
const claudeFileChanges = (toolName: string, input: Record<string, unknown>): PendingApproval['changes'] => {
  const filePath = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : ''
  if (!filePath) return undefined
  if (toolName === 'Write') return [{ path: filePath, kind: fs.existsSync(filePath) ? 'update' : 'add', diff: lineDiff('+', String(input.content ?? '')) }]
  const edits = toolName === 'MultiEdit' && Array.isArray(input.edits) ? input.edits.map(edit => asRecord(edit) ?? {}) : [input]
  const diff = edits.map(edit => [
    typeof edit.old_string === 'string' && edit.old_string ? lineDiff('-', edit.old_string) : '',
    typeof edit.new_string === 'string' || typeof edit.new_source === 'string' ? lineDiff('+', String(edit.new_string ?? edit.new_source)) : '',
  ].filter(Boolean).join('\n')).filter(Boolean).join('\n@@\n')
  return [{ path: filePath, kind: 'update', diff }]
}
const claudeFileTools = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

const requestClaudePermission = (task: typeof tasks[number], projectPath: string, request: ClaudeToolRequest) => new Promise<PermissionResult>(resolve => {
  const { toolName, input } = request
  const requestId = randomUUID()
  let approval: PendingApproval
  let questions: PendingApproval['questions']
  if (toolName === 'AskUserQuestion' && Array.isArray(input.questions)) {
    questions = input.questions.flatMap((raw, index) => {
      const question = asRecord(raw)
      if (!question || typeof question.question !== 'string') return []
      const options = Array.isArray(question.options) ? question.options.flatMap(option => { const o = asRecord(option); return o && typeof o.label === 'string' ? [{ label: o.label, description: typeof o.description === 'string' ? o.description : '' }] : [] }) : []
      return [{ id: `q${index}`, header: typeof question.header === 'string' ? question.header : `Q${index + 1}`, question: question.question, isOther: true, ...(options.length ? { options } : {}) }]
    })
    approval = { id: requestId, kind: 'user_input', canApprove: questions.length > 0, questions }
  } else if (claudeFileTools.has(toolName)) {
    const changes = claudeFileChanges(toolName, input)
    approval = { id: requestId, kind: 'file_change', canApprove: Boolean(changes?.some(change => change.diff.trim())), ...(changes ? { changes } : {}) }
  } else {
    const command = toolName === 'Bash' && typeof input.command === 'string' ? input.command : `${toolName} ${JSON.stringify(input)}`
    const reason = toolName === 'Bash' ? input.description : `Claude wants to use the ${toolName} tool.`
    approval = { id: requestId, kind: 'command', canApprove: true, command, cwd: projectPath, ...(typeof reason === 'string' && reason ? { reason } : {}) }
  }
  if (request.blockedPath) approval.reason = `${approval.reason ? `${approval.reason}\n` : ''}Outside the allowed directories: ${request.blockedPath}`
  const settle = (result: PermissionResult) => { request.signal.removeEventListener('abort', onAbort); resolve(result) }
  const onAbort = () => {
    if (!pendingApprovalRequests.delete(requestId)) return
    task.pendingApprovals = (task.pendingApprovals ?? []).filter(item => item.id !== requestId)
    broadcast({ type: 'approval_resolved', taskId: task.id, approvalId: requestId })
    settle({ behavior: 'deny', message: claudeDeniedMessage })
  }
  request.signal.addEventListener('abort', onAbort, { once: true })
  registerApproval(task, approval, { taskId: task.id, itemId: request.toolUseId ?? requestId, kind: approval.kind, ...(questions ? { questions } : {}), claude: { input, resolve: settle } })
})

const describeClaudeTool = (toolName: string, input: Record<string, unknown>, completed: boolean) => {
  if (toolName === 'Bash') return { text: `${completed ? 'Finished command' : 'Running command'}: ${String(input.command ?? '')}`, logType: 'command' as const }
  if (claudeFileTools.has(toolName)) return { text: `${completed ? 'Updated files' : 'Editing files'}: ${String(input.file_path ?? input.notebook_path ?? '')}`, logType: 'change' as const }
  if (toolName === 'WebSearch' || toolName === 'WebFetch') return { text: `${completed ? 'Finished web request' : 'Searching the web'}: ${String(input.query ?? input.url ?? '')}`, logType: 'tool' as const }
  const target = input.file_path ?? input.path ?? input.pattern ?? input.description
  return { text: `${completed ? 'Finished' : 'Running'} ${toolName}${typeof target === 'string' && target ? `: ${target}` : ''}`, logType: 'tool' as const }
}

// The latest Claude run per task. A run that was interrupted can report its end
// after the next one started; that stale report must not touch the task.
const currentClaudeRuns = new Map<string, symbol>()
const startClaudeTurn = (task: typeof tasks[number], prompt: string, projectPath: string, { primer = true } = {}) => {
  const runToken = Symbol(task.id)
  currentClaudeRuns.set(task.id, runToken)
  activeCodexTasks.add(task.id)
  const tools = new Map<string, { name: string; input: Record<string, unknown> }>()
  const memory = readMemorySettings(projectPath).enabled ? { directory: memoryDirectory(projectPath), promptAppend: claudeMemoryPromptAppend } : undefined
  const writableDirectories = providerSettings.checkpointsEnabled ? [checkpointDirectory(projectPath)] : []
  if (memory && !task.remoteSessionId) {
    addMemoryTokens(task, 'injected', `${claudeMemoryPromptAppend}\n${readMemoryIndex(projectPath)}`)
    task.memorySession = memory.directory
  }
  const turnPrompt = task.remoteSessionId && primer ? withMemoryPrimer(task, projectPath, prompt) : prompt
  claude.start(task.id, turnPrompt, { cwd: projectPath, resume: task.remoteSessionId, model: task.model, effort: task.reasoningEffort, memory, writableDirectories }, {
    onSessionId: sessionId => {
      if (task.remoteSessionId === sessionId) return
      assignRemoteSession(task, sessionId)
      persist(task.projectId)
      broadcast({ type: 'task_session_started', taskId: task.id, sessionId })
    },
    onTextDelta: (itemId, text) => appendEvent({ id: `event-${randomUUID()}`, taskId: task.id, type: 'assistant_message', payload: { text, method: 'item/agentMessage/delta', itemId }, sequence: 0, createdAt: new Date().toISOString() }),
    onToolStarted: (toolUseId, name, input) => {
      tools.set(toolUseId, { name, input })
      const { text, logType } = describeClaudeTool(name, input, false)
      appendEvent({ id: `event-${randomUUID()}`, taskId: task.id, type: 'assistant_message', payload: { text, method: 'relay/progress', progressState: 'running', logType, itemId: toolUseId }, sequence: 0, createdAt: new Date().toISOString() })
    },
    onToolFinished: (toolUseId, output, isError) => {
      const tool = tools.get(toolUseId)
      if (!tool) return
      tools.delete(toolUseId)
      if (memory && (touchesMemory(projectPath, tool.input.file_path) || touchesMemory(projectPath, tool.input.command))) addMemoryTokens(task, 'tools', `${JSON.stringify(tool.input)}\n${output}`)
      const described = describeClaudeTool(tool.name, tool.input, true)
      const isTest = tool.name === 'Bash' && /\b(test|vitest|jest|pytest|playwright|cypress|cargo test|go test)\b/i.test(String(tool.input.command ?? ''))
      const logType = isError ? 'error' : isTest ? 'test' : described.logType
      const changes = claudeFileTools.has(tool.name) ? claudeFileChanges(tool.name, tool.input) : undefined
      const detail = changes ? formatFileChangeProgress(changes) : output.length > 8_000 ? `${output.slice(0, 8_000)}\n… output truncated …` : output
      appendEvent({
        id: `event-${randomUUID()}`,
        taskId: task.id,
        type: isError ? 'error' : changes ? 'file_change' : isTest ? 'test_result' : 'assistant_message',
        payload: { text: detail ? `${described.text}\n\n${detail}` : described.text, method: 'relay/progress', progressState: 'completed', logType, itemId: toolUseId },
        sequence: 0,
        createdAt: new Date().toISOString(),
      })
    },
    onUsage: usage => {
      const previous = task.tokenUsage
      task.tokenUsage = previous ? {
        inputTokens: previous.inputTokens + usage.inputTokens,
        cachedInputTokens: previous.cachedInputTokens + usage.cachedInputTokens,
        outputTokens: previous.outputTokens + usage.outputTokens,
        totalTokens: previous.totalTokens + usage.totalTokens,
      } : usage
    },
    onCompacted: (preTokens, postTokens) => appendEvent({
      id: `event-${randomUUID()}`,
      taskId: task.id,
      type: 'assistant_message',
      payload: { text: `Compacted context: ~${preTokens.toLocaleString('en-US')}${postTokens ? ` → ~${postTokens.toLocaleString('en-US')}` : ''} tokens`, method: 'relay/progress', progressState: 'completed', logType: 'status', itemId: `compact-${randomUUID()}` },
      sequence: 0,
      createdAt: new Date().toISOString(),
    }),
    onFinished: (status, error) => {
      if (currentClaudeRuns.get(task.id) !== runToken) return
      currentClaudeRuns.delete(task.id)
      if (status === 'failed') { forgetTaskApprovals(task); failTask(task, new Error(error ?? 'Claude turn failed')); return }
      const now = new Date()
      pauseTaskTimer(task, now)
      forgetTaskApprovals(task)
      task.status = status
      task.lastActivityAt = now.toISOString()
      activeCodexTasks.delete(task.id)
      persist(task.projectId)
      broadcastTaskStatus(task)
    },
    onBusy: () => {
      // Claude picked the task up again by itself (a background command ended).
      currentClaudeRuns.set(task.id, runToken)
      activeCodexTasks.add(task.id)
      if (task.status === 'running') return
      resumeTaskTimer(task, new Date())
      task.status = 'running'
      persist(task.projectId)
      broadcastTaskStatus(task)
    },
    requestPermission: request => requestClaudePermission(task, projectPath, request),
  }).catch(error => failTask(task, error))
}

const startAgentTask = (task: typeof tasks[number], prompt: string, projectPath: string) => task.agent === 'Claude'
  ? startClaudeTurn(task, prompt, projectPath)
  : startCodexTask(task, prompt, projectPath)

const startCodexTask = (task: typeof tasks[number], prompt: string, projectPath: string) => {
  activeCodexTasks.add(task.id)
  void codex.startThread(projectPath, codexThreadOptions({ model: task.model }, projectPath, task))
    .then(threadId => { rememberModelProvider(task); assignRemoteSession(task, threadId); persist(task.projectId); broadcast({ type: 'task_session_started', taskId: task.id, sessionId: threadId }); return codex.startTurn(threadId, prompt, projectPath, task.model, task.reasoningEffort) })
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
  if (message.method === 'item/completed' && item) {
    const projectPath = projectPathOf(task)
    if (projectPath && readMemorySettings(projectPath).enabled) {
      if (item.type === 'commandExecution' && touchesMemory(projectPath, item.command)) addMemoryTokens(task, 'tools', `${String(item.command)}\n${typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : ''}`)
      if (item.type === 'fileChange') for (const change of normalizeFileChanges(item.changes) ?? []) if (touchesMemory(projectPath, change.path)) addMemoryTokens(task, 'tools', change.diff)
    }
  }
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
  const turn = asRecord(params.turn)
  if (message.method === 'turn/started' && typeof turn?.id === 'string') { task.activeTurnId = turn.id; resumeTaskTimer(task); persist(task.projectId) }
  if (message.method === 'turn/completed') {
    const turnError = asRecord(turn?.error)
    const failureText = typeof turnError?.message === 'string' ? turnError.message : typeof turn?.error === 'string' ? turn.error : undefined
    const turnStatus = typeof turn?.status === 'string' ? turn.status : 'completed'
    if (task.status === 'failed') return
    if (turnStatus === 'failed' || failureText) {
      failTask(task, new Error(failureText ?? 'Codex turn failed'))
      return
    }
    const now = new Date(); pauseTaskTimer(task, now); forgetTaskApprovals(task); for (const key of fileChangePreviews.keys()) if (key.startsWith(`${threadId}:`)) fileChangePreviews.delete(key); task.activeTurnId = undefined; task.status = turnStatus === 'interrupted' ? 'interrupted' : 'completed'; task.lastActivityAt = now.toISOString(); activeCodexTasks.delete(task.id); persist(task.projectId); broadcastTaskStatus(task)
  }
  const delta = typeof params.delta === 'string' ? params.delta : undefined
  const itemId = typeof params.itemId === 'string' ? params.itemId : typeof item?.id === 'string' ? item.id : undefined
  if (delta) appendEvent({ id: `event-${randomUUID()}`, taskId: task.id, type: 'assistant_message', payload: { text: delta, method: message.method, itemId }, sequence: 0, createdAt: new Date().toISOString() })
})

const webRoot = resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../dist/web')
app.use(express.static(webRoot))
app.get('/', (_request, response) => response.status(503).type('html').send(`<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Relay 页面暂不可用</title><body style="margin:0;background:#0d1118;color:#e9ebf0;font:16px system-ui,sans-serif;display:grid;min-height:100vh;place-items:center">
<main style="max-width:34rem;padding:2rem;line-height:1.6"><h1>Relay 页面暂不可用</h1>
<p>Relay 服务正在运行，但网页文件没有加载。更新后请在 Mac 上重启 Relay 服务，再重新加载此页。</p>
<p>Homebrew：<code>brew services restart relay</code></p><p>LaunchAgent：重新运行 <code>sh deploy/launchd/install.sh</code></p>
<button onclick="location.reload()" style="padding:.6rem 1rem">重新加载</button></main></body></html>`))
app.get('/api/auth/status', (_request, response) => response.json({ required: Boolean(authToken) }))
app.post('/api/auth/verify', (request, response) => authorized(request.headers)
  ? response.json({ ok: true })
  : response.status(401).json({ error: 'Invalid access token' }))
app.get('/api/health', (_request, response) => {
  response.json({ ok: true, mode: 'local-codex', service: 'relay-backend', codex: process.env.CODEX_BIN ?? 'codex' })
})

const htmlEscape = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)
const uploadFileName = (request: express.Request) => {
  const encoded = request.get('x-relay-filename') ?? 'image'
  try { return decodeURIComponent(encoded) } catch { return 'image' }
}

app.get('/upload/:token', (request, response) => {
  const projectId = projectIdForImageShare(request.params.token)
  const project = projects.find(item => item.id === projectId)
  if (!project) return response.status(404).type('text').send('Upload link not found')
  const nonce = randomBytes(16).toString('base64')
  response.set({
    'Content-Security-Policy': `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'self'`,
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  })
  return response.type('html').send(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>上传图片 · Relay</title>
<style nonce="${nonce}">:root{color-scheme:dark;font-family:system-ui,sans-serif}*{box-sizing:border-box}body{min-height:100vh;margin:0;display:grid;place-items:center;padding:24px;background:#0d1118;color:#eef0f5}.card{width:min(100%,520px);padding:28px;border:1px solid #303849;border-radius:14px;background:#151a23;box-shadow:0 24px 70px #0006}h1{margin:5px 0 8px;font-size:25px}p{color:#9ca7b6;line-height:1.6}.drop{display:grid;place-items:center;gap:8px;margin:24px 0;padding:34px 18px;border:1px dashed #6657ba;border-radius:10px;background:#111620;text-align:center}.drop.drag{border-color:#aa9cff;background:#19162b}input{max-width:100%}button{padding:10px 16px;border:0;border-radius:7px;background:#6e54d9;color:white;font-weight:700;cursor:pointer}button:disabled{opacity:.5}.status{min-height:24px;margin-top:15px;color:#bdb5e9;font-size:13px}.hint{font-size:12px}</style>
<main class="card"><small>RELAY COLLABORATIVE UPLOAD</small><h1>${htmlEscape(project.name)}</h1><p>选择图片后会直接上传到项目的临时图片库。</p><label class="drop" id="drop"><strong>拖放图片到这里</strong><span>PNG、JPEG、GIF、WebP · 单张不超过 10 MB</span><input id="files" type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple></label><button id="upload">上传图片</button><div class="status" id="status"></div><p class="hint">图片保存在临时目录中，可能被系统自动清理。</p></main>
<script nonce="${nonce}">const token=${JSON.stringify(request.params.token)},input=document.querySelector('#files'),drop=document.querySelector('#drop'),button=document.querySelector('#upload'),status=document.querySelector('#status');for(const event of ['dragenter','dragover'])drop.addEventListener(event,e=>{e.preventDefault();drop.classList.add('drag')});for(const event of ['dragleave','drop'])drop.addEventListener(event,e=>{e.preventDefault();drop.classList.remove('drag')});drop.addEventListener('drop',e=>{input.files=e.dataTransfer.files});button.addEventListener('click',async()=>{const files=[...input.files];if(!files.length){status.textContent='请先选择图片';return}button.disabled=true;let done=0;try{for(const file of files){status.textContent='正在上传 '+file.name+'…';const response=await fetch('/api/public/image-uploads/'+encodeURIComponent(token),{method:'POST',headers:{'Content-Type':file.type||'application/octet-stream','X-Relay-Filename':encodeURIComponent(file.name)},body:file});const body=await response.json();if(!response.ok)throw new Error(body.error||'上传失败');done++}input.value='';status.textContent='已上传 '+done+' 张图片'}catch(error){status.textContent=error.message||'上传失败'}finally{button.disabled=false}});</script></html>`)
})

const allowPublicImageUpload = (request: express.Request, response: express.Response, next: express.NextFunction) => {
  const token = Array.isArray(request.params.token) ? request.params.token[0] ?? '' : request.params.token
  const projectId = projectIdForImageShare(token)
  if (!projects.some(item => item.id === projectId)) return response.status(404).json({ error: 'Upload link not found' })
  const now = Date.now()
  const rateKey = `${token}:${request.ip}`
  const attempts = (publicImageUploadAttempts.get(rateKey) ?? []).filter(timestamp => now - timestamp < 60 * 60 * 1_000)
  if (attempts.length >= 60) return response.set('Retry-After', '3600').status(429).json({ error: 'Upload limit reached. Try again later.' })
  attempts.push(now)
  publicImageUploadAttempts.set(rateKey, attempts)
  response.locals.projectId = projectId
  next()
}

app.post('/api/public/image-uploads/:token', allowPublicImageUpload, imageUploadBody, (request, response) => {
  try {
    if (!Buffer.isBuffer(request.body)) throw new Error('Provide an image file')
    const image = saveProjectImage(String(response.locals.projectId), uploadFileName(request), request.get('content-type') ?? '', request.body)
    return response.status(201).json({ name: image.name })
  } catch (error) { return response.status(400).json({ error: error instanceof Error ? error.message : 'Unable to upload image' }) }
})

app.use((request, response, next) => authorized(request.headers) ? next() : response.status(401).json({ error: 'Unauthorized' }))
app.use(express.json({ limit: '64kb' }))

app.get('/api/settings/approvals', (_request, response) => response.json(approvalSettings))
app.put('/api/settings/approvals', (request, response) => {
  const body = asRecord(request.body)
  if (!body || (typeof body.autoApproveConfirmations !== 'boolean' && typeof body.autoAcceptDefaultMcpForms !== 'boolean')) {
    return response.status(400).json({ error: 'At least one approval setting must be a boolean' })
  }
  const nextSettings = {
    autoApproveConfirmations: typeof body.autoApproveConfirmations === 'boolean' ? body.autoApproveConfirmations : approvalSettings.autoApproveConfirmations,
    autoAcceptDefaultMcpForms: typeof body.autoAcceptDefaultMcpForms === 'boolean' ? body.autoAcceptDefaultMcpForms : approvalSettings.autoAcceptDefaultMcpForms,
  }
  writeApprovalSettings(nextSettings)
  approvalSettings = nextSettings
  broadcast({ type: 'approval_settings', settings: approvalSettings })
  return response.json(approvalSettings)
})

app.get('/api/settings/providers', (_request, response) => response.json(providerSettingsStatus(providerSettings)))
app.put('/api/settings/providers', (request, response) => {
  const body = asRecord(request.body) ?? {}
  if (!('deepseekApiKey' in body) && !('httpProxy' in body) && !('checkpointsEnabled' in body)) return response.status(400).json({ error: 'Provide deepseekApiKey, httpProxy or checkpointsEnabled' })
  if ('checkpointsEnabled' in body && typeof body.checkpointsEnabled !== 'boolean') return response.status(400).json({ error: 'checkpointsEnabled must be a boolean' })
  const next = { ...providerSettings }
  if ('deepseekApiKey' in body) {
    const key = body.deepseekApiKey
    if (key !== null && typeof key !== 'string') return response.status(400).json({ error: 'deepseekApiKey must be a string or null' })
    const trimmed = typeof key === 'string' ? key.trim() : ''
    if (typeof key === 'string' && (!trimmed || trimmed.length > 512 || /\s/.test(trimmed))) return response.status(400).json({ error: 'Enter a valid DeepSeek API key' })
    if (trimmed) next.deepseekApiKey = trimmed
    else delete next.deepseekApiKey
  }
  if ('httpProxy' in body) {
    const proxy = body.httpProxy
    if (proxy !== null && typeof proxy !== 'string') return response.status(400).json({ error: 'httpProxy must be a string or null' })
    const normalized = typeof proxy === 'string' && proxy.trim() ? normalizeProxyUrl(proxy) : undefined
    if (typeof proxy === 'string' && proxy.trim() && !normalized) return response.status(400).json({ error: 'Enter a proxy URL such as http://127.0.0.1:7890' })
    if (normalized) next.httpProxy = normalized
    else delete next.httpProxy
  }
  if (typeof body.checkpointsEnabled === 'boolean') {
    if (body.checkpointsEnabled) next.checkpointsEnabled = true
    else delete next.checkpointsEnabled
  }
  providerSettings = next
  writeProviderSettings(providerSettings)
  // Claude reads the environment per run; Codex needs a fresh app-server.
  claude.invalidate()
  codexRestartPending = true
  restartCodexWhenIdle()
  const status = providerSettingsStatus(providerSettings)
  broadcast({ type: 'provider_settings', settings: status })
  return response.json({ ...status, restartPending: codexRestartPending })
})

app.get('/api/environment', async (_request, response) => {
  const [codexState, claudeState, nodeState, gitState] = await Promise.all([
    commandVersion('codex'), commandVersion('claude'), commandVersion('node'), commandVersion('git'),
  ])
  const tool = (id: EnvironmentTool, state: { installed: boolean; version?: string }) => ({ id, label: environmentTools[id].label, ...state, ...(environmentInstalls.get(id) ?? {}) })
  claude.invalidate()
  const claudeReadiness = await claude.readiness().catch(() => undefined)
  const claudeTool = { ...tool('claude', claudeState), ...(claudeReadiness ? { runtime: claudeReadiness.source, loggedIn: claudeReadiness.loggedIn, requiredVersion: claudeReadiness.requiredVersion, ...(claudeReadiness.account ? { account: claudeReadiness.account } : {}) } : {}) }
  return response.json({ tools: [tool('codex', codexState), claudeTool], requirements: [{ label: 'Node.js', ...nodeState }, { label: 'Git', ...gitState }] })
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
    if (code === 0) { environmentInstalls.delete(toolId); if (toolId === 'claude') claude.invalidate() }
    else environmentInstalls.set(toolId, { status: 'failed', detail: output.trim().slice(-500) || `npm exited with code ${code ?? 'unknown'}` })
  })
  return response.status(202).json({ accepted: true, message: `Installing ${tool.label}…` })
})

app.get('/api/account/rate-limits', async (request, response) => {
  if (request.query.agent === 'Claude') {
    try { return response.json({ rateLimits: await claude.readRateLimits() }) }
    catch (error) { return response.status(503).json({ error: error instanceof Error ? error.message : 'Claude plan limits are unavailable' }) }
  }
  try { return response.json(await codex.readRateLimits()) }
  catch (error) { return response.status(503).json({ error: error instanceof Error ? error.message : 'Codex account limits are unavailable' }) }
})

app.get('/api/models', async (request, response) => {
  if (request.query.agent === 'Claude') {
    try { return response.json({ items: await claude.listModels() }) }
    catch (error) { return response.status(503).json({ error: error instanceof Error ? error.message : 'Unable to load Claude models' }) }
  }
  const extraModels = providerSettingsStatus(providerSettings).deepseek.configured ? deepseekModels : []
  try { return response.json({ items: [...await codex.listModels(), ...extraModels] }) }
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

const imageProject = (projectId: string, response: express.Response) => {
  const project = projects.find(item => item.id === projectId)
  if (!project) { response.status(404).json({ error: 'Project not found' }); return undefined }
  return project
}
const imageResponse = (projectId: string, image: ReturnType<typeof projectImagePath>) => ({
  ...image,
  previewUrl: `/api/projects/${encodeURIComponent(projectId)}/images/${encodeURIComponent(image.name)}/content`,
})

app.get('/api/projects/:projectId/images', (request, response) => {
  if (!imageProject(request.params.projectId, response)) return
  return response.json({ items: listProjectImages(request.params.projectId).map(image => imageResponse(request.params.projectId, image)) })
})

app.post('/api/projects/:projectId/images', imageUploadBody, (request, response) => {
  if (!imageProject(request.params.projectId, response)) return
  try {
    if (!Buffer.isBuffer(request.body)) throw new Error('Provide an image file')
    const image = saveProjectImage(request.params.projectId, uploadFileName(request), request.get('content-type') ?? '', request.body)
    return response.status(201).json(imageResponse(request.params.projectId, image))
  } catch (error) { return response.status(400).json({ error: error instanceof Error ? error.message : 'Unable to upload image' }) }
})

app.get('/api/projects/:projectId/images/:name/content', (request, response) => {
  if (!imageProject(request.params.projectId, response)) return
  try {
    const image = projectImagePath(request.params.projectId, request.params.name)
    response.set({ 'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff' })
    return response.type(image.mimeType).sendFile(image.path)
  } catch { return response.status(404).json({ error: 'Image not found' }) }
})

app.delete('/api/projects/:projectId/images/:name', (request, response) => {
  if (!imageProject(request.params.projectId, response)) return
  try { deleteProjectImage(request.params.projectId, request.params.name); return response.status(204).end() }
  catch { return response.status(404).json({ error: 'Image not found' }) }
})

app.get('/api/projects/:projectId/image-upload-share', (request, response) => {
  if (!imageProject(request.params.projectId, response)) return
  const share = projectImageShare(request.params.projectId)
  return response.json({ active: Boolean(share), ...(share ? { url: `${request.protocol}://${request.get('host')}/upload/${share.token}`, createdAt: share.createdAt } : {}) })
})

app.post('/api/projects/:projectId/image-upload-share', (request, response) => {
  if (!imageProject(request.params.projectId, response)) return
  const share = createProjectImageShare(request.params.projectId)
  return response.json({ active: true, url: `${request.protocol}://${request.get('host')}/upload/${share.token}`, createdAt: share.createdAt })
})

app.delete('/api/projects/:projectId/image-upload-share', (request, response) => {
  if (!imageProject(request.params.projectId, response)) return
  deleteProjectImageShare(request.params.projectId)
  return response.status(204).end()
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
    deleteProjectImageShare(project.id)
    refreshProjects(nextPath)
    const taskIds = new Set(tasks.filter(task => task.projectId === project.id).map(task => task.id))
    for (let index = tasks.length - 1; index >= 0; index--) if (taskIds.has(tasks[index].id)) tasks.splice(index, 1)
    for (let index = events.length - 1; index >= 0; index--) if (taskIds.has(events[index].taskId)) events.splice(index, 1)
    for (const taskId of taskIds) eventSequences.delete(taskId)
    loadedProjectIds.delete(project.id)
    return response.status(204).end()
  } catch (error) { return response.status(400).json({ error: error instanceof Error ? error.message : 'Unable to remove workspace' }) }
})

const memoryProject = (projectId: string, response: express.Response) => {
  const project = projects.find(item => item.id === projectId)
  if (!project) { response.status(404).json({ error: 'Project not found' }); return undefined }
  return project
}
const memoryState = (projectPath: string) => {
  const settings = readMemorySettings(projectPath)
  const preview = settings.claudeImport ? undefined : previewClaudeImport(projectPath)
  return {
    enabled: settings.enabled,
    directory: memoryDirectory(projectPath),
    entries: listMemoryEntries(projectPath),
    stats: memoryStats(projectPath),
    consolidation: { ...readConsolidation(projectPath), running: consolidatingProjects.has(projectPath) },
    claudeImport: settings.claudeImport
      ? { imported: true, at: settings.claudeImport.at, files: settings.claudeImport.files }
      : { imported: false, sourceDirectory: preview?.sourceDirectory ?? null, files: preview?.files ?? [] },
  }
}
const consolidatingProjects = new Set<string>()
const memoryError = (response: express.Response, error: unknown) => response.status(error instanceof MemoryConflictError ? 409 : 400).json({ error: error instanceof Error ? error.message : 'Memory request failed' })
const afterMemoryWrite = (project: typeof projects[number]) => {
  memoryWatcher.resync(project.path)
  broadcast({ type: 'memory_changed', projectId: project.id })
}

app.get('/api/projects/:projectId/memory', (request, response) => {
  const project = memoryProject(request.params.projectId, response)
  if (project) return response.json(memoryState(project.path))
})
app.get('/api/projects/:projectId/memory/usage', (request, response) => {
  const project = memoryProject(request.params.projectId, response)
  if (!project) return
  const items = tasks.filter(task => task.projectId === project.id && task.memoryTokens).map(task => {
    const taskTotal = task.agent === 'Claude' ? task.tokenUsage?.totalTokens : task.remoteSessionId ? readCodexSessionTokenUsage(task.remoteSessionId)?.totalTokens : undefined
    return { id: task.id, title: stripInjectedPromptContext(task.title), agent: task.agent, injected: task.memoryTokens!.injected, tools: task.memoryTokens!.tools, taskTotal: taskTotal ?? null }
  }).sort((a, b) => (b.injected + b.tools) - (a.injected + a.tools))
  const injected = items.reduce((sum, item) => sum + item.injected, 0)
  const toolTokens = items.reduce((sum, item) => sum + item.tools, 0)
  const measured = items.filter(item => item.taskTotal)
  const taskTotal = measured.reduce((sum, item) => sum + (item.taskTotal ?? 0), 0)
  const measuredMemory = measured.reduce((sum, item) => sum + item.injected + item.tools, 0)
  const consolidation = readConsolidation(project.path)
  // Applied or discarded proposals move into history, so pending is never counted twice.
  const consolidationTokens = [...consolidation.history, ...(consolidation.pending ? [consolidation.pending] : [])].reduce((sum, item) => sum + item.tokens, 0)
  return response.json({ estimated: true, injected, tools: toolTokens, consolidation: consolidationTokens, total: injected + toolTokens + consolidationTokens, taskTotal, share: taskTotal ? measuredMemory / taskTotal : null, items: items.slice(0, 20) })
})
app.put('/api/projects/:projectId/memory/settings', (request, response) => {
  const project = memoryProject(request.params.projectId, response)
  if (!project) return
  if (typeof request.body?.enabled !== 'boolean') return response.status(400).json({ error: 'enabled must be a boolean' })
  setMemoryEnabled(project.path, request.body.enabled)
  if (request.body.enabled) memoryWatcher.watch(project.path)
  else memoryWatcher.unwatch(project.path)
  afterMemoryWrite(project)
  return response.json(memoryState(project.path))
})
app.get('/api/projects/:projectId/memory/audit', (request, response) => {
  const project = memoryProject(request.params.projectId, response)
  if (project) return response.json({ items: readMemoryAudit(project.path, Math.min(500, Number(request.query.limit) || 100)) })
})
app.put('/api/projects/:projectId/memory/entries/:file', (request, response) => {
  const project = memoryProject(request.params.projectId, response)
  if (!project) return
  const body = asRecord(request.body) ?? {}
  if (typeof body.name !== 'string' || !body.name.trim() || typeof body.body !== 'string') return response.status(400).json({ error: 'name and body are required' })
  try {
    const entry = writeMemoryEntry(project.path, request.params.file, { name: body.name, description: typeof body.description === 'string' ? body.description : '', type: typeof body.type === 'string' ? body.type : undefined, body: body.body }, typeof body.revision === 'string' ? body.revision : undefined)
    afterMemoryWrite(project)
    return response.json(entry)
  } catch (error) { return memoryError(response, error) }
})
app.delete('/api/projects/:projectId/memory/entries/:file', (request, response) => {
  const project = memoryProject(request.params.projectId, response)
  if (!project) return
  try {
    deleteMemoryEntry(project.path, request.params.file, typeof request.query.revision === 'string' ? request.query.revision : '')
    afterMemoryWrite(project)
    return response.status(204).end()
  } catch (error) { return memoryError(response, error) }
})
// One tool-less call over every entry; the user reviews the proposal before it changes anything.
app.post('/api/projects/:projectId/memory/consolidate', async (request, response) => {
  const project = memoryProject(request.params.projectId, response)
  if (!project) return
  const agent: AgentName = request.body?.agent === 'Codex' ? 'Codex' : 'Claude'
  if (consolidatingProjects.has(project.path)) return response.status(409).json({ error: 'A consolidation is already running for this project' })
  const entries = listMemoryEntries(project.path)
  if (entries.length < 2) return response.status(400).json({ error: 'There is nothing to consolidate yet' })
  consolidatingProjects.add(project.path)
  broadcast({ type: 'memory_changed', projectId: project.id })
  try {
    const prompt = consolidationPrompt(entries)
    let result: { text: string; usage?: { totalTokens: number } }
    let model: string | undefined
    if (agent === 'Claude') {
      await claude.ensureReady()
      model = 'sonnet'
      result = await claude.runOneShot(prompt, { model, systemPrompt: consolidationInstructions })
    } else {
      result = await codex.runOneShot(project.path, prompt, { developerInstructions: consolidationInstructions })
    }
    const plan = parseConsolidationPlan(result.text, entries)
    if (readConsolidation(project.path).pending) discardConsolidation(project.path)
    const proposal = storeConsolidationProposal(project.path, { agent, ...(model ? { model } : {}), tokens: result.usage?.totalTokens ?? estimateTokens(prompt + result.text), tokensMeasured: Boolean(result.usage), ...plan })
    return response.json({ proposal, state: memoryState(project.path) })
  } catch (error) {
    if (error instanceof ClaudeUnavailableError) return claudeUnavailableResponse(response, error)
    return response.status(502).json({ error: error instanceof Error ? error.message : 'Consolidation failed' })
  } finally {
    consolidatingProjects.delete(project.path)
    broadcast({ type: 'memory_changed', projectId: project.id })
  }
})
app.post('/api/projects/:projectId/memory/consolidate/apply', (request, response) => {
  const project = memoryProject(request.params.projectId, response)
  if (!project) return
  try {
    const result = applyConsolidation(project.path)
    afterMemoryWrite(project)
    return response.json({ ...result, state: memoryState(project.path) })
  } catch (error) { return memoryError(response, error) }
})
app.delete('/api/projects/:projectId/memory/consolidate', (request, response) => {
  const project = memoryProject(request.params.projectId, response)
  if (!project) return
  discardConsolidation(project.path)
  afterMemoryWrite(project)
  return response.json(memoryState(project.path))
})

app.post('/api/projects/:projectId/memory/import-claude', (request, response) => {
  const project = memoryProject(request.params.projectId, response)
  if (!project) return
  const files = Array.isArray(request.body?.files) ? request.body.files.filter((file: unknown): file is string => typeof file === 'string') : []
  if (!files.length) return response.status(400).json({ error: 'Choose at least one memory to import' })
  try {
    const imported = importClaudeMemories(project.path, files)
    afterMemoryWrite(project)
    return response.json({ imported, state: memoryState(project.path) })
  } catch (error) { return memoryError(response, error) }
})
app.post('/api/projects/:projectId/memory/import-claude/rollback', (request, response) => {
  const project = memoryProject(request.params.projectId, response)
  if (!project) return
  try {
    const result = rollbackClaudeImport(project.path)
    afterMemoryWrite(project)
    return response.json({ ...result, state: memoryState(project.path) })
  } catch (error) { return memoryError(response, error) }
})

app.get('/api/projects/:projectId/task-status', (request, response) => {
  const project = projects.find(item => item.id === request.params.projectId)
  if (!project) return response.status(404).json({ error: 'Project not found' })
  return response.json({ items: tasks.filter(task => task.projectId === project.id).map(task => ({
    id: task.id,
    status: task.status,
    executionStartedAt: task.executionStartedAt ?? null,
    executionDurationMs: task.executionDurationMs,
    pendingApprovals: task.pendingApprovals ?? [],
  })) })
})

app.get('/api/projects/:projectId/tasks', (request, response) => {
  const project = projects.find(item => item.id === request.params.projectId)
  if (project) {
    hydrateProjectCache(project)
  }
  return response.json({ items: tasks.filter(task => task.projectId === request.params.projectId).map(({ tokenUsage: _tokenUsage, ...task }) => ({
    ...task,
    title: stripInjectedPromptContext(task.title),
  })) })
})

app.get('/api/projects/:projectId/deleted-tasks', (request, response) => {
  const project = projects.find(item => item.id === request.params.projectId)
  if (!project) return response.status(404).json({ error: 'Project not found' })
  hydrateProjectCache(project)
  refreshCodexSessionCache()
  const archived = deletedTasks.filter(item => item.task.projectId === project.id)
  const discovered = discoverCodexTasks(project.id, project.path)
  const archivedBySessionId = new Map(archived.flatMap(item => item.task.remoteSessionId ? [[item.task.remoteSessionId, item] as const] : []))
  const items = discovered.flatMap(task => {
    const sessionId = task.remoteSessionId
    if (!sessionId) return []
    const deleted = archivedBySessionId.get(sessionId)
    return [{ id: sessionId, title: task.title, lastActivityAt: task.lastActivityAt, deletedAt: deleted?.deletedAt ?? task.lastActivityAt }]
  })
  return response.json({ items })
})

app.post('/api/projects/:projectId/deleted-tasks/:sessionId/restore', async (request, response) => {
  const project = projects.find(item => item.id === request.params.projectId)
  if (!project) return response.status(404).json({ error: 'Project not found' })
  hydrateProjectCache(project)
  refreshCodexSessionCache()
  const sessionId = request.params.sessionId
  const archivedClaudeIndex = deletedTasks.findIndex(item => item.task.agent === 'Claude' && item.task.projectId === project.id && (item.task.remoteSessionId === sessionId || item.task.id === sessionId))
  if (archivedClaudeIndex >= 0) {
    const archived = deletedTasks.splice(archivedClaudeIndex, 1)[0]
    const restored = { ...archived.task, status: archived.task.status === 'running' || archived.task.status === 'waiting_for_approval' ? 'interrupted' as const : archived.task.status, executionStartedAt: undefined, activeTurnId: undefined, pendingApprovals: [] }
    tasks.push(restored)
    for (const event of archived.events) {
      events.push(event)
      eventSequences.set(event.taskId, Math.max(eventSequences.get(event.taskId) ?? 0, event.sequence))
    }
    for (const id of [restored.remoteSessionId, ...(restored.remoteSessionAliases ?? [])]) if (id) hiddenCodexSessionIds.delete(id)
    persist(project.id)
    broadcast({ type: 'task_restored', taskId: restored.id })
    const { tokenUsage: _tokenUsage, ...publicTask } = restored
    return response.json(publicTask)
  }
  const codexTask = discoverCodexTasks(project.id, project.path).find(task => task.remoteSessionId === sessionId)
  if (!codexTask) return response.status(404).json({ error: 'Recoverable Codex session not found' })
  const existing = tasks.find(task => task.projectId === project.id && (task.remoteSessionId === sessionId || (task.remoteSessionAliases ?? []).includes(sessionId)))
  if (existing?.status === 'running' || existing?.status === 'waiting_for_approval') {
    const { tokenUsage: _tokenUsage, ...publicTask } = existing
    return response.json(publicTask)
  }
  try {
    await codex.resumeThread(sessionId, project.path, codexThreadOptions({}, project.path))
  } catch (error) {
    return response.status(503).json({ error: error instanceof Error ? `Codex 无法恢复此会话：${error.message}` : 'Codex 无法恢复此会话' })
  }
  const archivedIndex = deletedTasks.findIndex(item => item.task.projectId === project.id && (item.task.remoteSessionId === sessionId || item.task.id === sessionId))
  let restored: typeof tasks[number] | undefined
  if (existing) {
    restored = existing
    restored.title = codexTask.title
    restored.lastActivityAt = codexTask.lastActivityAt
    restored.status = 'interrupted'
    restored.executionStartedAt = undefined
    restored.activeTurnId = undefined
    restored.pendingApprovals = []
    if (archivedIndex >= 0) deletedTasks.splice(archivedIndex, 1)
  } else if (archivedIndex >= 0) {
    const archived = deletedTasks.splice(archivedIndex, 1)[0]
    restored = {
      ...archived.task,
      title: codexTask.title,
      lastActivityAt: codexTask.lastActivityAt,
      status: 'interrupted',
      executionStartedAt: undefined,
      activeTurnId: undefined,
      pendingApprovals: [],
    }
    tasks.push(restored)
  } else {
    restored = codexTask
    restored.status = 'interrupted'
    restored.activeTurnId = undefined
    restored.pendingApprovals = []
    tasks.push(restored)
  }
  for (const id of [restored.remoteSessionId, ...(restored.remoteSessionAliases ?? [])]) if (id) hiddenCodexSessionIds.delete(id)
  persist(project.id)
  broadcast({ type: 'task_restored', taskId: restored.id })
  const { tokenUsage: _tokenUsage, ...publicTask } = restored
  return response.json(publicTask)
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
  claude.release(task.id)
  activeCodexTasks.delete(task.id)
  for (const [approvalId, pending] of pendingApprovalRequests) if (pending.taskId === task.id) pendingApprovalRequests.delete(approvalId)
  for (const sessionId of [task.remoteSessionId, ...(task.remoteSessionAliases ?? [])]) {
    if (!sessionId) continue
    for (const key of fileChangePreviews.keys()) if (key.startsWith(`${sessionId}:`)) fileChangePreviews.delete(key)
  }
  const [removedTask] = tasks.splice(taskIndex, 1)
  const removedEvents: SessionEvent[] = []
  for (let index = events.length - 1; index >= 0; index--) if (events[index].taskId === task.id) removedEvents.unshift(...events.splice(index, 1))
  deletedTasks.push({ task: removedTask, events: removedEvents, deletedAt: new Date().toISOString() })
  eventSequences.delete(task.id)
  persist(task.projectId)
  broadcast({ type: 'task_deleted', taskId: task.id })
  return response.status(204).end()
})

app.get('/api/tasks/:taskId/history', async (request, response) => {
  const task = tasks.find(item => item.id === request.params.taskId)
  if (!task) return response.status(404).json({ error: 'Task not found' })
  if (!task.remoteSessionId) return response.json({ thread: null })
  const cursorValue = typeof request.query.before === 'string' ? request.query.before : undefined
  if (task.agent === 'Claude') {
    const projectPath = projects.find(project => project.id === task.projectId)?.path ?? process.cwd()
    try {
      const items = (await claude.readHistory(task.remoteSessionId, projectPath)).map(item => item.role === 'user' ? { ...item, text: stripInjectedPromptContext(item.text) } : item)
      const cursor = cursorValue?.match(/^thread:(\d+)$/)
      const end = Math.min(cursor ? Number(cursor[1]) : items.length, items.length)
      const start = Math.max(0, end - HISTORY_PAGE_SIZE)
      return response.json({ items: items.slice(start, end), nextCursor: start > 0 ? `thread:${start}` : null, source: 'claude_session' })
    } catch (error) {
      return response.status(503).json({ error: error instanceof Error ? error.message : 'Unable to read Claude session history' })
    }
  }
  const fileCursor = cursorValue?.match(/^file:(\d+)$/)
  const threadCursor = cursorValue?.match(/^thread:(\d+)$/)
  if (fileCursor || !cursorValue) {
    const localHistory = readCodexSessionHistoryPage(task.remoteSessionId, fileCursor ? Number(fileCursor[1]) : undefined)
    if (localHistory.available && (localHistory.items.length || fileCursor)) return response.json({ items: localHistory.items, nextCursor: localHistory.nextCursor, source: 'local_transcript' })
  }
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
    const end = Math.min(threadCursor ? Number(threadCursor[1]) : items.length, items.length)
    const start = Math.max(0, end - HISTORY_PAGE_SIZE)
    return response.json({ items: items.slice(start, end), nextCursor: start > 0 ? `thread:${start}` : null })
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
  if (task.agent === 'Claude') return response.json({ tokenUsage: task.tokenUsage ?? null })
  if (!task.remoteSessionId) return response.json({ tokenUsage: null })
  return response.json({ tokenUsage: readCodexSessionTokenUsage(task.remoteSessionId) ?? null })
})

app.patch('/api/tasks/:taskId/model', (request, response) => {
  const task = tasks.find(item => item.id === request.params.taskId)
  if (!task) return response.status(404).json({ error: 'Task not found' })
  if (task.status === 'running' || task.status === 'waiting_for_approval') return response.status(409).json({ error: 'Interrupt or finish the current turn before changing its model' })
  const model = typeof request.body?.model === 'string' ? request.body.model.trim() : ''
  const reasoningEffort = typeof request.body?.reasoningEffort === 'string' ? request.body.reasoningEffort.trim() : ''
  if (!model || model.length > 200) return response.status(400).json({ error: 'A valid model is required' })
  if ((!reasoningEffort && task.agent !== 'Claude') || reasoningEffort.length > 100) return response.status(400).json({ error: 'A valid reasoning level is required' })
  task.model = model
  task.reasoningEffort = reasoningEffort || undefined
  persist(task.projectId)
  return response.json(task)
})

const claudeUnavailableResponse = (response: express.Response, error: unknown) => error instanceof ClaudeUnavailableError
  ? response.status(409).json({ error: error.message, code: error.code })
  : response.status(503).json({ error: error instanceof Error ? error.message : 'Claude is unavailable' })

app.patch('/api/tasks/:taskId/agent', async (request, response) => {
  const task = tasks.find(item => item.id === request.params.taskId)
  if (!task) return response.status(404).json({ error: 'Task not found' })
  const agent: AgentName | undefined = request.body?.agent === 'Codex' || request.body?.agent === 'Claude' ? request.body.agent : undefined
  if (!agent) return response.status(400).json({ error: 'agent must be Codex or Claude' })
  if (task.status === 'running' || task.status === 'waiting_for_approval' || activeCodexTasks.has(task.id)) return response.status(409).json({ error: 'Interrupt or finish the current turn before switching agents' })
  const model = typeof request.body?.model === 'string' ? request.body.model.trim() : undefined
  const reasoningEffort = typeof request.body?.reasoningEffort === 'string' ? request.body.reasoningEffort.trim() : undefined
  if (agent === task.agent) return response.json(task)
  if (agent === 'Claude') {
    try { await claude.ensureReady() } catch (error) { return claudeUnavailableResponse(response, error) }
  }
  const lastSequence = eventSequences.get(task.id) ?? 0
  const sessions = { ...(task.agentSessions ?? {}) }
  // Park the current agent's session so switching back resumes it.
  sessions[task.agent] = { sessionId: task.remoteSessionId, lastSequence, memorySession: task.memorySession, checkpointSession: task.checkpointSession }
  const incoming = sessions[agent]
  delete sessions[agent]
  const from = task.agent
  if (from === 'Claude') claude.release(task.id)
  task.agent = agent
  task.agentSessions = sessions
  task.remoteSessionId = incoming?.sessionId
  task.memorySession = incoming?.memorySession
  task.checkpointSession = incoming?.checkpointSession
  task.activeTurnId = undefined
  task.model = model || undefined
  task.reasoningEffort = reasoningEffort || undefined
  // The incoming agent only needs what happened since it last worked on the task.
  task.handoffPending = { from, sinceSequence: incoming?.lastSequence ?? 0 }
  appendEvent({ id: `event-${randomUUID()}`, taskId: task.id, type: 'assistant_message', payload: { text: `Switched from ${from} to ${agent}. ${agent} receives a handoff of what Relay recorded with the next message.`, method: 'relay/agent-switch', logType: 'status', agent }, sequence: 0, createdAt: new Date().toISOString() })
  persist(task.projectId)
  broadcast({ type: 'task_agent_changed', taskId: task.id, agent, model: task.model ?? null, reasoningEffort: task.reasoningEffort ?? null })
  const { tokenUsage: _tokenUsage, ...publicTask } = task
  return response.json(publicTask)
})

app.post('/api/projects/:projectId/tasks', async (request, response) => {
  const project = projects.find(item => item.id === request.params.projectId)
  const title = typeof request.body?.title === 'string' ? stripInjectedPromptContext(request.body.title) : ''
  const model = typeof request.body?.model === 'string' ? request.body.model.trim() : undefined
  const reasoningEffort = typeof request.body?.reasoningEffort === 'string' ? request.body.reasoningEffort.trim() : undefined
  const agent: AgentName = request.body?.agent === 'Claude' ? 'Claude' : 'Codex'
  if (!project) return response.status(404).json({ error: 'Project not found' })
  if (!title) return response.status(400).json({ error: 'Task title is required' })
  if (agent === 'Claude') {
    try { await claude.ensureReady() } catch (error) { return claudeUnavailableResponse(response, error) }
  }

  const now = new Date().toISOString()
  const task = { id: `task-${randomUUID()}`, projectId: project.id, title, agent, ...(model ? { model } : {}), ...(reasoningEffort ? { reasoningEffort } : {}), status: 'running' as const, createdAt: now, lastActivityAt: now, executionStartedAt: now, executionDurationMs: 0 }
  tasks.unshift(task)
  appendEvent({ id: `event-${randomUUID()}`, taskId: task.id, type: 'user_message', payload: { text: title }, sequence: 0, createdAt: now })
  startAgentTask(task, prepareAgentPrompt(task, project.path, title), project.path)
  return response.status(201).json(task)
})

app.post('/api/tasks/:taskId/messages', async (request, response) => {
  const task = tasks.find(item => item.id === request.params.taskId)
  const message = typeof request.body?.message === 'string' ? stripInjectedPromptContext(request.body.message) : ''
  const model = typeof request.body?.model === 'string' ? request.body.model.trim() : undefined
  const reasoningEffort = typeof request.body?.reasoningEffort === 'string' ? request.body.reasoningEffort.trim() : undefined
  if (!task) return response.status(404).json({ error: 'Task not found' })
  if (!message) return response.status(400).json({ error: 'Message is required' })
  if (task.agent === 'Claude' && !claude.isActive(task.id)) {
    try { await claude.ensureReady() } catch (error) { return claudeUnavailableResponse(response, error) }
  }

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
  if (task.agent === 'Claude') {
    const projectPath = projects.find(project => project.id === task.projectId)?.path ?? process.cwd()
    // A message sent mid-turn joins the running Claude process as the next prompt.
    if (!claude.push(task.id, message)) startClaudeTurn(task, prepareAgentPrompt(task, projectPath, message, event.id), projectPath)
  } else if (task.agent === 'Codex') {
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
      void resumeOrRestoreThread(task, projectPath, prepareAgentPrompt(task, projectPath, message, event.id)).catch(error => failTask(task, error))
    } else startCodexTask(task, prepareAgentPrompt(task, projectPath, message, event.id), projectPath)
  }
  return response.status(202).json({ accepted: true, event })
})

/**
 * Summarizes the task's conversation so later turns read less context. Nothing
 * is prepended: Claude Code only recognizes /compact at the start of a prompt,
 * and a pending handoff stays pending for the next real message.
 */
app.post('/api/tasks/:taskId/compact', async (request, response) => {
  const task = tasks.find(item => item.id === request.params.taskId)
  if (!task) return response.status(404).json({ error: 'Task not found' })
  if (task.status === 'running' || task.status === 'waiting_for_approval') return response.status(409).json({ error: 'Wait for the current turn to finish before compacting' })
  if (!task.remoteSessionId) return response.status(409).json({ error: 'This task has no conversation to compact yet' })
  if (task.agent === 'Claude') {
    try { await claude.ensureReady() } catch (error) { return claudeUnavailableResponse(response, error) }
  }
  const projectPath = projectPathOf(task) ?? process.cwd()
  const now = new Date()
  resumeTaskTimer(task, now)
  task.status = 'running'
  task.lastActivityAt = now.toISOString()
  persist(task.projectId)
  broadcastTaskStatus(task)
  if (task.agent === 'Claude') startClaudeTurn(task, '/compact', projectPath, { primer: false })
  else {
    const threadId = task.remoteSessionId
    activeCodexTasks.add(task.id)
    void codex.resumeThread(threadId, projectPath, codexThreadOptions(task, projectPath))
      .then(() => { rememberModelProvider(task); return codex.compactThread(threadId) })
      .catch(error => failTask(task, error))
  }
  return response.status(202).json({ accepted: true })
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
  const claudeTurn = task.agent === 'Claude' && claude.isActive(task.id)
  if (!claudeTurn && (!task.remoteSessionId || !task.activeTurnId)) return response.status(409).json({ error: 'Task has no active turn' })
  for (const approval of task.pendingApprovals ?? []) {
    const pending = pendingApprovalRequests.get(approval.id)
    if (!pending) continue
    try {
      if (pending.claude) pending.claude.resolve({ behavior: 'deny', message: claudeDeniedMessage, interrupt: true })
      else if (pending.rpcId !== undefined) codex.respondToServerRequest(pending.rpcId, makeApprovalResponse(pending.kind, 'decline', pending.requestedPermissions))
    }
    catch (error) { return response.status(503).json({ error: error instanceof Error ? error.message : 'Unable to decline pending approval' }) }
    pendingApprovalRequests.delete(approval.id)
  }
  task.pendingApprovals = []
  pauseTaskTimer(task)
  if (claudeTurn) void claude.interrupt(task.id).catch(error => failTask(task, error))
  else if (task.remoteSessionId && task.activeTurnId) void codex.interruptTurn(task.remoteSessionId, task.activeTurnId).catch(error => failTask(task, error))
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

const shutdown = () => {
  if (shuttingDown) return
  shuttingDown = true
  flushEventPersists()
  const now = new Date()
  for (const task of tasks) {
    if (task.status !== 'running' && task.status !== 'waiting_for_approval') continue
    pauseTaskTimer(task, now)
    task.status = 'interrupted'
    task.activeTurnId = undefined
    task.pendingApprovals = []
    task.lastActivityAt = now.toISOString()
    activeCodexTasks.delete(task.id)
    persist(task.projectId)
    broadcastTaskStatus(task)
  }
  codex.stop()
  claude.stopAll()
  memoryWatcher.stopAll()
  server.close(() => process.exit(0))
}
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
