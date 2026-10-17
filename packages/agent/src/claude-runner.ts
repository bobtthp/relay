import { execFile } from 'node:child_process'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { query, getSessionMessages, type PermissionResult, type Query, type SDKMessage, type SDKUserMessage, type EffortLevel } from '@anthropic-ai/claude-agent-sdk'
import type { TokenUsage } from '../../protocol/src/types.js'

const execFileAsync = promisify(execFile)
/** Oldest Claude Code the SDK's control protocol is known to work with: the build it was released with. */
const requiredVersion = (() => {
  // The SDK does not export its package.json, so read it next to the entry point.
  const packageJson = path.join(path.dirname(fileURLToPath(import.meta.resolve('@anthropic-ai/claude-agent-sdk'))), 'package.json')
  return String((JSON.parse(fs.readFileSync(packageJson, 'utf8')) as { claudeCodeVersion?: string }).claudeCodeVersion ?? '0.0.0')
})()

// Relay always runs the user's own Claude Code. Release builds strip the SDK's
// bundled binary (~219MB), so an old local install must be updated instead.
export type ClaudeRuntime = {
  source: 'local' | 'outdated' | 'missing'
  executable?: string
  localVersion?: string
  requiredVersion: string
}

export type ClaudeReadiness = ClaudeRuntime & { loggedIn: boolean; account?: string }

/** Same shape as Codex's account/rateLimits windows so the UI renders both alike. */
export type ClaudeRateLimitWindow = { usedPercent: number; windowDurationMins: number; resetsAt: number }
export type ClaudeRateLimits = { primary: ClaudeRateLimitWindow; secondary?: ClaudeRateLimitWindow | null }

const FIVE_HOURS = 300
const SEVEN_DAYS = 7 * 24 * 60
const RATE_LIMIT_CACHE_MS = 2 * 60 * 1_000

/** From the /usage data: utilization 0-100, resets_at ISO 8601. */
const windowFromUsage = (value: unknown, windowDurationMins: number): ClaudeRateLimitWindow | undefined => {
  const window = value as { utilization?: unknown; resets_at?: unknown } | null | undefined
  const resetsAt = typeof window?.resets_at === 'string' ? Date.parse(window.resets_at) : NaN
  if (typeof window?.utilization !== 'number' || !Number.isFinite(resetsAt)) return undefined
  return { usedPercent: window.utilization, windowDurationMins, resetsAt: Math.floor(resetsAt / 1_000) }
}

/** From a rate_limit_event: utilization 0-1, resetsAt in epoch seconds. */
const windowFromEvent = (value: unknown, windowDurationMins: number): ClaudeRateLimitWindow | undefined => {
  const window = value as { utilization?: unknown; resetsAt?: unknown } | null | undefined
  if (typeof window?.utilization !== 'number' || typeof window.resetsAt !== 'number') return undefined
  return { usedPercent: Math.round(window.utilization * 1_000) / 10, windowDurationMins, resetsAt: window.resetsAt }
}

export class ClaudeUnavailableError extends Error {
  constructor(readonly code: 'claude_not_installed' | 'claude_outdated' | 'claude_login_required', message: string) { super(message) }
}

const compareVersions = (left: string, right: string) => {
  const a = left.split('.').map(Number)
  const b = right.split('.').map(Number)
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference) return Math.sign(difference)
  }
  return 0
}

// LaunchAgent and Homebrew services start with a minimal PATH, so also look
// where Claude Code's installers put the binary.
const candidateExecutables = () => {
  const fromPath = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map(directory => path.join(directory, 'claude'))
  const home = os.homedir()
  return [...new Set([...fromPath, path.join(home, '.local/bin/claude'), path.join(home, '.claude/local/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'])]
}

async function resolveRuntime(): Promise<ClaudeRuntime> {
  const candidates = process.env.CLAUDE_BIN ? [process.env.CLAUDE_BIN] : candidateExecutables()
  // Several installs can coexist (npm, native installer); prefer the newest.
  let newest: { executable: string; version: string } | undefined
  for (const executable of candidates) {
    try { fs.accessSync(executable, fs.constants.X_OK) } catch { continue }
    try {
      const { stdout } = await execFileAsync(executable, ['--version'], { timeout: 10_000 })
      const version = stdout.match(/\d+\.\d+\.\d+/)?.[0]
      if (version && (!newest || compareVersions(version, newest.version) > 0)) newest = { executable, version }
    } catch { continue }
  }
  if (!newest) return { source: 'missing', requiredVersion }
  return compareVersions(newest.version, requiredVersion) >= 0
    ? { source: 'local', executable: newest.executable, localVersion: newest.version, requiredVersion }
    : { source: 'outdated', localVersion: newest.version, requiredVersion }
}

const unavailable = (runtime: ClaudeRuntime) => runtime.source === 'missing'
  ? new ClaudeUnavailableError('claude_not_installed', 'Claude Code is not installed on this Mac. Install it from the Overview page, then sign in.')
  : new ClaudeUnavailableError('claude_outdated', `Claude Code ${runtime.localVersion} is older than ${runtime.requiredVersion}, the oldest version Relay supports. Update it from the Overview page.`)

export type ClaudeModel = { id: string; model: string; displayName: string; description?: string; isDefault?: boolean; agent: 'Claude'; defaultReasoningEffort?: string; supportedReasoningEfforts?: Array<{ reasoningEffort: string; description: string }> }

export type ClaudeToolRequest = { toolName: string; input: Record<string, unknown>; toolUseId?: string; blockedPath?: string; signal: AbortSignal }

export type ClaudeTurnCallbacks = {
  onSessionId: (sessionId: string) => void
  onTextDelta: (itemId: string, text: string) => void
  onToolStarted: (toolUseId: string, toolName: string, input: Record<string, unknown>) => void
  onToolFinished: (toolUseId: string, output: string, isError: boolean) => void
  onUsage: (usage: TokenUsage) => void
  /** Called once per run, after the last queued prompt finished or the run stopped. */
  onFinished: (status: 'completed' | 'interrupted' | 'failed', error?: string) => void
  requestPermission: (request: ClaudeToolRequest) => Promise<PermissionResult>
}

export type ClaudeTurnOptions = { cwd: string; resume?: string; model?: string; effort?: string }

const effortLevels = new Set<string>(['low', 'medium', 'high', 'xhigh', 'max'])

/** Prompts pushed while a run is active are delivered to the same Claude process. */
class PromptQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = []
  private waiting?: (result: IteratorResult<SDKUserMessage>) => void
  private closed = false

  push(text: string) {
    const message: SDKUserMessage = { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null }
    if (this.waiting) { const resolve = this.waiting; this.waiting = undefined; resolve({ value: message, done: false }) }
    else this.items.push(message)
  }

  close() {
    this.closed = true
    if (this.waiting) { const resolve = this.waiting; this.waiting = undefined; resolve({ value: undefined, done: true }) }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift()
        if (item) return Promise.resolve({ value: item, done: false })
        if (this.closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise(resolve => { this.waiting = resolve })
      },
    }
  }
}

const textFromToolResult = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(part => part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : '').filter(Boolean).join('\n')
}

type ActiveRun = { query: Query; prompts: PromptQueue; queued: number; interrupted: boolean; finished: boolean }

export class ClaudeRunner {
  /** The SDK's env option replaces the subprocess environment, so this returns a complete one. */
  constructor(private readonly environment: () => NodeJS.ProcessEnv = () => process.env) {}

  private runs = new Map<string, ActiveRun>()
  private modelCache?: { at: number; models: ClaudeModel[] }
  private runtime?: Promise<ClaudeRuntime>
  private readinessCache?: { at: number; readiness: ClaudeReadiness }
  private rateLimitCache?: { at: number; limits: ClaudeRateLimits }
  private rateLimitHandlers = new Set<(limits: ClaudeRateLimits) => void>()

  onRateLimits(handler: (limits: ClaudeRateLimits) => void) { this.rateLimitHandlers.add(handler); return () => this.rateLimitHandlers.delete(handler) }

  private storeRateLimits(limits: ClaudeRateLimits) {
    this.rateLimitCache = { at: Date.now(), limits }
    this.rateLimitHandlers.forEach(handler => handler(limits))
  }

  /**
   * Claude.ai plan windows (5h / 7d), or null for API-key sessions. Reads the
   * experimental /usage control request; runs keep the cache fresh through
   * rate_limit_event messages, so a future SDK change only loses idle refreshes.
   */
  async readRateLimits(): Promise<ClaudeRateLimits | null> {
    if (this.rateLimitCache && Date.now() - this.rateLimitCache.at < RATE_LIMIT_CACHE_MS) return this.rateLimitCache.limits
    const runtime = await this.resolveRuntime()
    if (runtime.source !== 'local' || !runtime.executable) return null
    const prompts = new PromptQueue()
    const probe = query({ prompt: prompts, options: { pathToClaudeCodeExecutable: runtime.executable, env: this.environment(), persistSession: false } })
    try {
      const readUsage = (probe as Partial<Pick<Query, 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET'>>).usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET
      if (typeof readUsage !== 'function') return this.rateLimitCache?.limits ?? null
      const usage = await readUsage.call(probe, { skipBehaviors: true })
      const primary = windowFromUsage(usage.rate_limits?.five_hour, FIVE_HOURS)
      if (!usage.rate_limits_available || !primary) return null
      const limits = { primary, secondary: windowFromUsage(usage.rate_limits?.seven_day, SEVEN_DAYS) ?? null }
      this.storeRateLimits(limits)
      return limits
    } catch {
      return this.rateLimitCache?.limits ?? null
    } finally {
      prompts.close()
      probe.close()
    }
  }

  /** Forget the detected runtime, e.g. after Claude Code was installed or signed in. */
  invalidate() { this.runtime = undefined; this.readinessCache = undefined; this.modelCache = undefined }

  private resolveRuntime() {
    this.runtime ??= resolveRuntime()
    return this.runtime
  }

  private async executableOptions() {
    const runtime = await this.resolveRuntime()
    if (runtime.source !== 'local' || !runtime.executable) throw unavailable(runtime)
    return { pathToClaudeCodeExecutable: runtime.executable, env: this.environment() }
  }

  async readiness(): Promise<ClaudeReadiness> {
    if (this.readinessCache && (Date.now() - this.readinessCache.at < 60_000 || this.runs.size > 0)) return this.readinessCache.readiness
    const runtime = await this.resolveRuntime()
    if (runtime.source !== 'local' || !runtime.executable) return { ...runtime, loggedIn: false }
    const prompts = new PromptQueue()
    const probe = query({ prompt: prompts, options: { pathToClaudeCodeExecutable: runtime.executable, env: this.environment(), persistSession: false } })
    try {
      const info = await probe.accountInfo()
      const loggedIn = Boolean(info.email || (info.tokenSource && info.tokenSource !== 'none') || (info.apiKeySource && info.apiKeySource !== 'none'))
      const readiness: ClaudeReadiness = { ...runtime, loggedIn, ...(info.subscriptionType ? { account: info.subscriptionType } : {}) }
      this.readinessCache = { at: Date.now(), readiness }
      return readiness
    } finally {
      prompts.close()
      probe.close()
    }
  }

  /** Throws ClaudeUnavailableError when a new Claude run could not start. */
  async ensureReady() {
    const readiness = await this.readiness()
    if (readiness.source !== 'local') throw unavailable(readiness)
    if (!readiness.loggedIn) throw new ClaudeUnavailableError('claude_login_required', 'Claude Code is not signed in. Run `claude` in a terminal on this Mac and sign in, then try again.')
  }

  isActive(taskId: string) { return this.runs.has(taskId) }

  async start(taskId: string, prompt: string, options: ClaudeTurnOptions, callbacks: ClaudeTurnCallbacks) {
    if (this.runs.has(taskId)) throw new Error('Claude is already running this task')
    const executable = await this.executableOptions()
    if (this.runs.has(taskId)) throw new Error('Claude is already running this task')
    const prompts = new PromptQueue()
    prompts.push(prompt)
    const effort = options.effort && effortLevels.has(options.effort) ? options.effort as EffortLevel : undefined
    const claudeQuery = query({
      prompt: prompts,
      options: {
        cwd: options.cwd,
        ...(options.resume ? { resume: options.resume } : {}),
        ...(options.model ? { model: options.model } : {}),
        ...(effort ? { effort } : {}),
        ...executable,
        includePartialMessages: true,
        permissionMode: 'default',
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        canUseTool: (toolName, input, context) => callbacks.requestPermission({ toolName, input, toolUseId: context.toolUseID, blockedPath: context.blockedPath, signal: context.signal }),
      },
    })
    const run: ActiveRun = { query: claudeQuery, prompts, queued: 1, interrupted: false, finished: false }
    this.runs.set(taskId, run)
    const finish = (status: 'completed' | 'interrupted' | 'failed', error?: string) => {
      if (run.finished) return
      run.finished = true
      this.runs.delete(taskId)
      prompts.close()
      callbacks.onFinished(status, error)
    }
    void this.consume(run, callbacks, finish)
      .then(() => finish(run.interrupted ? 'interrupted' : 'completed'))
      .catch(error => finish(run.interrupted ? 'interrupted' : 'failed', error instanceof Error ? error.message : String(error)))
  }

  /** Delivers a follow-up prompt to an active run. Returns false when no run is active. */
  push(taskId: string, prompt: string) {
    const run = this.runs.get(taskId)
    if (!run || run.finished) return false
    run.queued += 1
    run.prompts.push(prompt)
    return true
  }

  async interrupt(taskId: string) {
    const run = this.runs.get(taskId)
    if (!run) return
    run.interrupted = true
    run.prompts.close()
    await run.query.interrupt()
  }

  async listModels(): Promise<ClaudeModel[]> {
    if (this.modelCache && Date.now() - this.modelCache.at < 60 * 60 * 1_000) return this.modelCache.models
    const prompts = new PromptQueue()
    const probe = query({ prompt: prompts, options: { ...await this.executableOptions(), persistSession: false } })
    try {
      const available = await probe.supportedModels()
      const models = available.map((model, index): ClaudeModel => ({
        id: `claude:${model.value}`,
        model: model.value,
        displayName: model.displayName || model.value,
        description: model.description,
        agent: 'Claude',
        ...(index === 0 ? { isDefault: true } : {}),
        ...(model.supportedEffortLevels?.length ? {
          defaultReasoningEffort: model.supportedEffortLevels.includes('high') ? 'high' : model.supportedEffortLevels[0],
          supportedReasoningEfforts: model.supportedEffortLevels.map(level => ({ reasoningEffort: level, description: level })),
        } : {}),
      }))
      this.modelCache = { at: Date.now(), models }
      return models
    } finally {
      prompts.close()
      probe.close()
    }
  }

  async readHistory(sessionId: string, cwd: string) {
    const messages = await getSessionMessages(sessionId, { dir: cwd })
    return messages.flatMap(entry => {
      if (entry.parent_tool_use_id || (entry.type !== 'user' && entry.type !== 'assistant')) return []
      const message = entry.message as { content?: unknown } | undefined
      const content = message?.content
      const text = typeof content === 'string'
        ? content
        : Array.isArray(content) ? content.map(part => part && typeof part === 'object' && (part as { type?: unknown }).type === 'text' ? String((part as { text?: unknown }).text ?? '') : '').filter(Boolean).join('\n') : ''
      return text.trim() ? [{ role: entry.type, text }] : []
    })
  }

  stopAll() {
    for (const [taskId, run] of this.runs) { run.interrupted = true; run.prompts.close(); run.query.close(); this.runs.delete(taskId) }
  }

  private async consume(run: ActiveRun, callbacks: ClaudeTurnCallbacks, finish: (status: 'completed' | 'interrupted' | 'failed', error?: string) => void) {
    let messageId = ''
    let sessionReported = false
    for await (const message of run.query as AsyncIterable<SDKMessage>) {
      if (!sessionReported && 'session_id' in message && typeof message.session_id === 'string' && message.session_id) {
        sessionReported = true
        callbacks.onSessionId(message.session_id)
      }
      // Subagent traffic stays inside the subagent; Relay shows the main thread.
      if ('parent_tool_use_id' in message && message.parent_tool_use_id) continue
      if (message.type === 'rate_limit_event') {
        // unifiedWindows carries both plan windows; older CLIs report only the window that changed.
        const info = message.rate_limit_info as typeof message.rate_limit_info & { unifiedWindows?: Record<string, unknown> }
        const previous = this.rateLimitCache?.limits
        const primary = windowFromEvent(info.unifiedWindows?.five_hour, FIVE_HOURS)
          ?? (info.rateLimitType === 'five_hour' ? windowFromEvent(info, FIVE_HOURS) : undefined) ?? previous?.primary
        const secondary = windowFromEvent(info.unifiedWindows?.seven_day, SEVEN_DAYS)
          ?? (info.rateLimitType === 'seven_day' ? windowFromEvent(info, SEVEN_DAYS) : undefined) ?? previous?.secondary ?? null
        if (primary) this.storeRateLimits({ primary, secondary })
        continue
      }
      if (message.type === 'stream_event') {
        const event = message.event
        if (event.type === 'message_start') messageId = event.message.id
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') callbacks.onTextDelta(`${messageId}:${event.index}`, event.delta.text)
      } else if (message.type === 'assistant') {
        for (const block of message.message.content) {
          if (block.type === 'tool_use') callbacks.onToolStarted(block.id, block.name, (block.input ?? {}) as Record<string, unknown>)
        }
      } else if (message.type === 'user') {
        const content = message.message.content
        if (Array.isArray(content)) for (const block of content) {
          if (block.type === 'tool_result') callbacks.onToolFinished(block.tool_use_id, textFromToolResult(block.content), block.is_error === true)
        }
      } else if (message.type === 'result') {
        const usage = message.usage
        callbacks.onUsage({
          inputTokens: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
          cachedInputTokens: usage.cache_read_input_tokens ?? 0,
          outputTokens: usage.output_tokens ?? 0,
          totalTokens: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.output_tokens ?? 0),
        })
        run.queued = Math.max(0, run.queued - 1)
        if (message.subtype !== 'success' && !run.interrupted) {
          finish('failed', message.errors.join('\n') || `Claude stopped: ${message.subtype}`)
          return
        }
        if (message.subtype === 'success' && message.is_error && !run.interrupted) {
          finish('failed', message.result || 'Claude returned an error')
          return
        }
        if (run.queued === 0) run.prompts.close()
      }
    }
  }
}
