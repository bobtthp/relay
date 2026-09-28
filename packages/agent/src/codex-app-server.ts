import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'

export type RpcId = number | string
export type RpcMessage = { id?: RpcId; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { code?: number; message?: string } }
type NotificationHandler = (message: RpcMessage) => void
type ServerRequestHandler = (message: RpcMessage & { id: RpcId; method: string }) => void

const codexBinary = process.env.CODEX_BIN ?? 'codex'

export class CodexAppServer {
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
      const child = spawn(codexBinary, ['app-server'], { stdio: 'pipe', env: process.env })
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

  async startThread(cwd: string) {
    await this.ensureStarted()
    const result = await this.request('thread/start', { cwd })
    const thread = result.thread as { id?: string } | undefined
    if (!thread?.id) throw new Error('Codex app-server did not return a thread id')
    return thread.id
  }

  async resumeThread(threadId: string, cwd: string) { await this.ensureStarted(); await this.request('thread/resume', { threadId, cwd }) }
  async injectItems(threadId: string, items: Array<Record<string, unknown>>) { await this.ensureStarted(); await this.request('thread/inject_items', { threadId, items }) }
  async startTurn(threadId: string, text: string, cwd: string, model?: string, effort?: string) { await this.ensureStarted(); await this.request('turn/start', { threadId, cwd, ...(model ? { model } : {}), ...(effort ? { effort } : {}), input: [{ type: 'text', text }] }) }
  async steerTurn(threadId: string, turnId: string, text: string) { await this.ensureStarted(); await this.request('turn/steer', { threadId, expectedTurnId: turnId, input: [{ type: 'text', text }] }) }
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
  async readRateLimits() { await this.ensureStarted(); return this.request('account/rateLimits/read', {}) }
  stop() { this.process?.kill('SIGTERM') }
}
