import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'

export type RpcId = number | string
export type RpcMessage = { id?: RpcId; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { code?: number; message?: string } }
type NotificationHandler = (message: RpcMessage) => void
type ServerRequestHandler = (message: RpcMessage & { id: RpcId; method: string }) => void

const codexBinary = process.env.CODEX_BIN ?? 'codex'

export type CodexLaunchOptions = () => { env: NodeJS.ProcessEnv; configOverrides: string[] }

/** Per-thread settings Relay applies on both thread/start and thread/resume, so resumed threads match new ones. */
export type CodexThreadOptions = { modelProvider?: string; developerInstructions?: string; writableRoots?: string[] }

const threadParams = (options: CodexThreadOptions = {}) => ({
  ...(options.modelProvider ? { modelProvider: options.modelProvider } : {}),
  ...(options.developerInstructions ? { developerInstructions: options.developerInstructions } : {}),
  ...(options.writableRoots?.length ? { config: { sandbox_workspace_write: { writable_roots: options.writableRoots } } } : {}),
})

export class CodexAppServer {
  constructor(private readonly launchOptions: CodexLaunchOptions = () => ({ env: process.env, configOverrides: [] })) {}

  private process?: ChildProcessWithoutNullStreams
  private startup?: Promise<void>
  private nextId = 1
  private pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout }>()
  private handlers = new Set<NotificationHandler>()
  private serverRequestHandlers = new Set<ServerRequestHandler>()

  onNotification(handler: NotificationHandler) { this.handlers.add(handler); return () => this.handlers.delete(handler) }
  onServerRequest(handler: ServerRequestHandler) { this.serverRequestHandlers.add(handler); return () => this.serverRequestHandlers.delete(handler) }

  private async ensureStarted() {
    if (this.startup) return this.startup
    this.startup = new Promise<void>((resolve, reject) => {
      const { env, configOverrides } = this.launchOptions()
      const child = spawn(codexBinary, ['app-server', ...configOverrides.flatMap(override => ['-c', override])], { stdio: 'pipe', env })
      this.process = child
      createInterface({ input: child.stdout }).on('line', line => {
        try {
          const message = JSON.parse(line) as RpcMessage
          if (message.method && message.id !== undefined) {
            const serverRequest = message as RpcMessage & { id: RpcId; method: string }
            if (this.serverRequestHandlers.size === 0) this.respondToServerRequestError(message.id, -32601, `Unsupported server request: ${message.method}`)
            else this.serverRequestHandlers.forEach(handler => {
              try { handler(serverRequest) }
              catch (error) { this.respondToServerRequestError(message.id!, -32603, error instanceof Error ? error.message : 'Unable to handle Codex request') }
            })
          } else if (typeof message.id === 'number' && this.pending.has(message.id)) {
            const pending = this.pending.get(message.id)!
            this.pending.delete(message.id)
            clearTimeout(pending.timeout)
            if (message.error) pending.reject(new Error(message.error.message ?? 'Codex app-server request failed'))
            else pending.resolve(message.result ?? {})
          } else this.handlers.forEach(handler => handler(message))
        } catch { /* Ignore diagnostics that are not JSON-RPC messages. */ }
      })
      child.once('error', reject)
      child.once('exit', (code, signal) => {
        // After restart() a replacement process may already own this client.
        if (this.process && this.process !== child) return
        this.process = undefined
        this.startup = undefined
        for (const pending of this.pending.values()) { clearTimeout(pending.timeout); pending.reject(new Error(`Codex app-server exited (${signal ?? code ?? 'unknown'})`)) }
        this.pending.clear()
      })
      this.request('initialize', { clientInfo: { name: 'relay-web', title: 'Relay Web', version: '0.1.0' }, capabilities: { experimentalApi: true } })
        .then(() => { this.notify('initialized', {}); resolve() })
        .catch(reject)
    })
    return this.startup
  }

  private notify(method: string, params: Record<string, unknown>) { this.process?.stdin.write(`${JSON.stringify({ method, params })}\n`) }

  respondToServerRequest(id: RpcId, result: Record<string, unknown>) {
    if (!this.process?.stdin.writable) throw new Error('Codex app-server is not available')
    this.process.stdin.write(`${JSON.stringify({ id, result })}\n`)
  }

  respondToServerRequestError(id: RpcId, code: number, message: string) {
    if (!this.process?.stdin.writable) throw new Error('Codex app-server is not available')
    this.process.stdin.write(`${JSON.stringify({ id, error: { code, message } })}\n`)
  }

  private request(method: string, params: Record<string, unknown>) {
    const id = this.nextId++
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Codex app-server timed out while calling ${method}`))
      }, 30_000)
      this.pending.set(id, { resolve, reject, timeout })
      this.process?.stdin.write(`${JSON.stringify({ method, id, params })}\n`)
    })
  }

  async startThread(cwd: string, options?: CodexThreadOptions) {
    await this.ensureStarted()
    const result = await this.request('thread/start', { cwd, ...threadParams(options) })
    const thread = result.thread as { id?: string } | undefined
    if (!thread?.id) throw new Error('Codex app-server did not return a thread id')
    return thread.id
  }

  /** Returns the resume result, including the thread's effective `sandbox` policy. */
  async resumeThread(threadId: string, cwd: string, options?: CodexThreadOptions) { await this.ensureStarted(); return this.request('thread/resume', { threadId, cwd, ...threadParams(options) }) }
  async injectItems(threadId: string, items: Array<Record<string, unknown>>) { await this.ensureStarted(); await this.request('thread/inject_items', { threadId, items }) }
  async startTurn(threadId: string, text: string, cwd: string, model?: string, effort?: string, sandboxPolicy?: Record<string, unknown>) {
    await this.ensureStarted()
    // Luna is the display model for the reserve quota, but the app-server
    // route must use the hidden reserve model id. Sending gpt-5.6-luna or
    // gpt-6-luna directly uses the regular model quota and can be rejected.
    const explicitModel = model?.toLowerCase().includes('luna') ? 'gpt-reserve' : model
    await this.request('turn/start', { threadId, cwd, ...(explicitModel ? { model: explicitModel } : {}), ...(effort ? { effort } : {}), ...(sandboxPolicy ? { sandboxPolicy } : {}), input: [{ type: 'text', text }] })
  }
  async steerTurn(threadId: string, turnId: string, text: string) { await this.ensureStarted(); await this.request('turn/steer', { threadId, expectedTurnId: turnId, input: [{ type: 'text', text }] }) }
  /** Runs as a turn of its own: turn/started, a contextCompaction item, turn/completed. */
  async compactThread(threadId: string) { await this.ensureStarted(); await this.request('thread/compact/start', { threadId }) }
  async interruptTurn(threadId: string, turnId: string) { await this.ensureStarted(); await this.request('turn/interrupt', { threadId, turnId }) }
  async readThread(threadId: string) { await this.ensureStarted(); return this.request('thread/read', { threadId, includeTurns: true }) }
  async listModels() {
    await this.ensureStarted()
    const models: Array<{ id: string; model: string; displayName: string; description?: string; isDefault?: boolean; hidden?: boolean; defaultReasoningEffort?: string; supportedReasoningEfforts?: Array<{ reasoningEffort: string; description: string }> }> = []
    let cursor: string | undefined
    do {
      const page = await this.request('model/list', { includeHidden: false, ...(cursor ? { cursor } : {}) })
      const data = Array.isArray(page.data) ? page.data as typeof models : []
      models.push(...data)
      cursor = typeof page.nextCursor === 'string' && page.nextCursor ? page.nextCursor : undefined
    } while (cursor)
    return models
  }
  /**
   * A single question on a throwaway read-only thread that never asks for
   * approval; used for maintenance jobs such as consolidating shared memory.
   */
  async runOneShot(cwd: string, prompt: string, options: { model?: string; developerInstructions: string }) {
    await this.ensureStarted()
    const result = await this.request('thread/start', { cwd, ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never', developerInstructions: options.developerInstructions })
    const threadId = (result.thread as { id?: string } | undefined)?.id
    if (!threadId) throw new Error('Codex app-server did not return a thread id')
    let text = ''
    let usage: { totalTokens: number; inputTokens: number; outputTokens: number } | undefined
    const done = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { unsubscribe(); reject(new Error('Codex did not finish within 5 minutes')) }, 5 * 60_000)
      const unsubscribe = this.onNotification(message => {
        const params = message.params ?? {}
        if (params.threadId !== threadId) return
        if (message.method === 'item/agentMessage/delta' && typeof params.delta === 'string') text += params.delta
        const tokenUsage = (params.tokenUsage as { total?: { totalTokens?: number; inputTokens?: number; outputTokens?: number } } | undefined)?.total
        if (message.method === 'thread/tokenUsage/updated' && typeof tokenUsage?.totalTokens === 'number') usage = { totalTokens: tokenUsage.totalTokens, inputTokens: tokenUsage.inputTokens ?? 0, outputTokens: tokenUsage.outputTokens ?? 0 }
        if (message.method !== 'turn/completed') return
        clearTimeout(timeout)
        unsubscribe()
        const turn = params.turn as { status?: string; error?: { message?: string } } | undefined
        if (turn?.status === 'failed' || turn?.error) reject(new Error(turn.error?.message ?? 'Codex turn failed'))
        else resolve()
      })
    })
    await this.startTurn(threadId, prompt, cwd, options.model)
    await done
    return { text, usage }
  }

  async readRateLimits() { await this.ensureStarted(); return this.request('account/rateLimits/read', {}) }
  stop() { this.process?.kill('SIGTERM') }
  /** Stops the current process; the next request starts one with fresh launch options. */
  restart() {
    const child = this.process
    if (!child) return
    this.process = undefined
    this.startup = undefined
    child.kill('SIGTERM')
  }
}
