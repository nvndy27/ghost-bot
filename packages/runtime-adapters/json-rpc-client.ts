import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { Interface as ReadlineInterface } from 'node:readline'

export type JsonRpcId = string | number

export type JsonRpcErrorCode =
  | 'CLIENT_CLOSED'
  | 'PROCESS_EXITED'
  | 'PROCESS_ERROR'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'RPC_ERROR'
  | 'MALFORMED_PAYLOAD'
  | 'TRANSPORT_ERROR'

export class JsonRpcClientError extends Error {
  readonly code: JsonRpcErrorCode
  readonly rpcCode?: number
  readonly retryable: boolean
  readonly data?: unknown

  constructor(
    code: JsonRpcErrorCode,
    message: string,
    options?: { rpcCode?: number; retryable?: boolean; data?: unknown; cause?: unknown },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = 'JsonRpcClientError'
    this.code = code
    this.rpcCode = options?.rpcCode
    this.retryable = options?.retryable ?? false
    this.data = options?.data
  }
}

export interface JsonRpcNotification {
  method: string
  params?: unknown
}

export interface JsonRpcServerRequest {
  id: JsonRpcId
  method: string
  params?: unknown
}

export interface JsonRpcClientOptions {
  command: string
  args?: readonly string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  defaultTimeoutMs?: number
  shutdownGraceMs?: number
  onNotification?: (notification: JsonRpcNotification) => void
  onServerRequest?: (request: JsonRpcServerRequest) => Promise<unknown> | unknown
  onMalformedPayload?: (rawLine: string, error: JsonRpcClientError) => void
  onStderrLine?: (line: string) => void
  onExit?: (info: { code: number | null; signal: NodeJS.Signals | null }) => void
}

export interface RequestOptions {
  timeoutMs?: number
  signal?: AbortSignal
}

interface PendingRequest {
  method: string
  resolve: (value: unknown) => void
  reject: (error: JsonRpcClientError) => void
  timer?: NodeJS.Timeout
  abortCleanup?: () => void
}

/**
 * Reusable newline-delimited JSON-RPC 2.0 stdio transport client.
 * Handles concurrent requests, ID correlation, server-initiated requests,
 * notifications, timeouts, cancellation, malformed payloads, and graceful shutdown.
 */
export class JsonRpcStdioClient {
  private readonly options: JsonRpcClientOptions
  private readonly pending = new Map<JsonRpcId, PendingRequest>()
  private child: ChildProcessWithoutNullStreams | null = null
  private stdoutReader: ReadlineInterface | null = null
  private stderrReader: ReadlineInterface | null = null
  private nextId = 0
  private closed = false
  private closingPromise: Promise<void> | null = null
  private exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null

  constructor(options: JsonRpcClientOptions) {
    this.options = options
  }

  get isRunning(): boolean {
    return this.child !== null && this.exitInfo === null && !this.closed
  }

  start(): void {
    if (this.child) {
      throw new JsonRpcClientError('TRANSPORT_ERROR', 'JSON-RPC process already started')
    }
    if (this.closed) {
      throw new JsonRpcClientError('CLIENT_CLOSED', 'JSON-RPC client is closed')
    }

    const child = spawn(this.options.command, [...(this.options.args ?? [])], {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child

    this.stdoutReader = createInterface({ input: child.stdout, crlfDelay: Infinity })
    this.stdoutReader.on('line', (line) => {
      this.handleLine(line)
    })

    this.stderrReader = createInterface({ input: child.stderr, crlfDelay: Infinity })
    this.stderrReader.on('line', (line) => {
      this.options.onStderrLine?.(line)
    })

    child.stdin.on('error', (err) => {
      const normalized = new JsonRpcClientError('TRANSPORT_ERROR', 'Failed writing to process stdin', {
        cause: err,
      })
      this.rejectAllPending(normalized)
    })

    child.on('error', (err) => {
      const normalized = new JsonRpcClientError('PROCESS_ERROR', `Process error: ${err.message}`, {
        cause: err,
      })
      this.rejectAllPending(normalized)
    })

    child.on('close', (code, signal) => {
      this.exitInfo = { code, signal }
      const detail = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`
      const err = new JsonRpcClientError(
        this.closed ? 'CLIENT_CLOSED' : 'PROCESS_EXITED',
        `JSON-RPC process exited with ${detail}`,
      )
      this.rejectAllPending(err)
      this.cleanupReaders()
      this.options.onExit?.({ code, signal })
    })
  }

  request<T = unknown>(method: string, params?: unknown, options?: RequestOptions): Promise<T> {
    if (this.closed) {
      return Promise.reject(new JsonRpcClientError('CLIENT_CLOSED', 'JSON-RPC client is closed'))
    }
    if (!this.child || this.exitInfo !== null) {
      return Promise.reject(
        new JsonRpcClientError('PROCESS_EXITED', 'JSON-RPC process is not running'),
      )
    }
    if (options?.signal?.aborted) {
      return Promise.reject(
        new JsonRpcClientError('CANCELLED', `Request ${method} aborted before dispatch`),
      )
    }

    const id = ++this.nextId
    const timeoutMs = options?.timeoutMs ?? this.options.defaultTimeoutMs ?? 30_000

    return new Promise<T>((resolve, reject) => {
      const pending: PendingRequest = {
        method,
        resolve: (val) => resolve(val as T),
        reject,
      }

      if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
        pending.timer = setTimeout(() => {
          if (this.pending.delete(id)) {
            pending.abortCleanup?.()
            reject(
              new JsonRpcClientError('TIMEOUT', `Request ${method} timed out after ${timeoutMs}ms`, {
                retryable: true,
              }),
            )
          }
        }, timeoutMs)
      }

      if (options?.signal) {
        const onAbort = () => {
          if (this.pending.delete(id)) {
            if (pending.timer) clearTimeout(pending.timer)
            reject(new JsonRpcClientError('CANCELLED', `Request ${method} was cancelled`))
          }
        }
        options.signal.addEventListener('abort', onAbort, { once: true })
        pending.abortCleanup = () => options.signal?.removeEventListener('abort', onAbort)
      }

      this.pending.set(id, pending)
      try {
        this.writeMessage(params === undefined ? { id, method } : { id, method, params })
      } catch (err) {
        this.pending.delete(id)
        if (pending.timer) clearTimeout(pending.timer)
        pending.abortCleanup?.()
        reject(
          err instanceof JsonRpcClientError
            ? err
            : new JsonRpcClientError('TRANSPORT_ERROR', 'Failed to send request', { cause: err }),
        )
      }
    })
  }

  notify(method: string, params?: unknown): void {
    if (this.closed || !this.child || this.exitInfo !== null) {
      throw new JsonRpcClientError('PROCESS_EXITED', 'Cannot send notification; process is not running')
    }
    this.writeMessage(params === undefined ? { method } : { method, params })
  }

  async close(): Promise<void> {
    if (this.closingPromise) return this.closingPromise
    this.closed = true
    this.rejectAllPending(new JsonRpcClientError('CLIENT_CLOSED', 'JSON-RPC client closed'))

    const child = this.child
    if (!child || this.exitInfo !== null) {
      this.cleanupReaders()
      return
    }

    const graceMs = this.options.shutdownGraceMs ?? 2000
    this.closingPromise = new Promise<void>((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(termTimer)
        clearTimeout(killTimer)
        this.cleanupReaders()
        resolve()
      }

      child.once('close', finish)

      try {
        child.stdin.end()
      } catch {
        // Ignore stdin close errors during shutdown.
      }

      const termTimer = setTimeout(() => {
        if (this.exitInfo === null) {
          try {
            child.kill('SIGTERM')
          } catch {
            finish()
          }
        }
      }, Math.min(graceMs, 500))

      const killTimer = setTimeout(() => {
        if (this.exitInfo === null) {
          try {
            child.kill('SIGKILL')
          } catch {
            // Ignore kill errors if already exited.
          }
        }
        finish()
      }, graceMs)
    })

    return this.closingPromise
  }

  private writeMessage(payload: Record<string, unknown>): void {
    if (!this.child || !this.child.stdin.writable) {
      throw new JsonRpcClientError('TRANSPORT_ERROR', 'Process stdin is not writable')
    }
    this.child.stdin.write(JSON.stringify(payload) + '\n')
  }

  private handleLine(rawLine: string): void {
    const trimmed = rawLine.trim()
    if (!trimmed) return

    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch (err) {
      const malformed = new JsonRpcClientError('MALFORMED_PAYLOAD', 'Received invalid JSON line', {
        cause: err,
      })
      this.options.onMalformedPayload?.(rawLine, malformed)
      return
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      const malformed = new JsonRpcClientError(
        'MALFORMED_PAYLOAD',
        'Received JSON-RPC payload that is not an object',
      )
      this.options.onMalformedPayload?.(rawLine, malformed)
      return
    }

    const msg = parsed as Record<string, unknown>
    const hasId = typeof msg.id === 'string' || typeof msg.id === 'number'
    const hasMethod = typeof msg.method === 'string' && msg.method.length > 0

    // Server-initiated request: has both id and method.
    if (hasId && hasMethod) {
      void this.handleServerRequest({
        id: msg.id as JsonRpcId,
        method: msg.method as string,
        params: msg.params,
      })
      return
    }

    // Response to a client request: has id, no method.
    if (hasId && !hasMethod) {
      const pending = this.pending.get(msg.id as JsonRpcId)
      if (!pending) {
        const malformed = new JsonRpcClientError(
          'MALFORMED_PAYLOAD',
          `Received response for unknown request id ${String(msg.id)}`,
        )
        this.options.onMalformedPayload?.(rawLine, malformed)
        return
      }
      this.pending.delete(msg.id as JsonRpcId)
      if (pending.timer) clearTimeout(pending.timer)
      pending.abortCleanup?.()

      if (msg.error !== undefined && msg.error !== null) {
        const errObj =
          typeof msg.error === 'object' ? (msg.error as Record<string, unknown>) : undefined
        const rpcCode = typeof errObj?.code === 'number' ? errObj.code : undefined
        const errMsg =
          typeof errObj?.message === 'string'
            ? errObj.message
            : `RPC error in ${pending.method}`
        pending.reject(
          new JsonRpcClientError('RPC_ERROR', errMsg, {
            rpcCode,
            data: errObj?.data,
          }),
        )
        return
      }

      if (!('result' in msg)) {
        pending.reject(
          new JsonRpcClientError(
            'MALFORMED_PAYLOAD',
            `Response for ${pending.method} missing both result and error`,
          ),
        )
        return
      }

      pending.resolve(msg.result)
      return
    }

    // Notification: has method, no id.
    if (hasMethod && msg.id === undefined) {
      this.options.onNotification?.({
        method: msg.method as string,
        params: msg.params,
      })
      return
    }

    const malformed = new JsonRpcClientError(
      'MALFORMED_PAYLOAD',
      'Received JSON-RPC message without valid method or id',
    )
    this.options.onMalformedPayload?.(rawLine, malformed)
  }

  private async handleServerRequest(req: JsonRpcServerRequest): Promise<void> {
    if (!this.options.onServerRequest) {
      this.safeWriteResponse({
        id: req.id,
        error: { code: -32601, message: `No handler registered for server request ${req.method}` },
      })
      return
    }

    try {
      const result = await this.options.onServerRequest(req)
      this.safeWriteResponse({ id: req.id, result: result ?? {} })
    } catch (err) {
      const code =
        err instanceof JsonRpcClientError && typeof err.rpcCode === 'number' ? err.rpcCode : -32000
      const message = err instanceof Error ? err.message : 'Server request handler failed'
      this.safeWriteResponse({ id: req.id, error: { code, message } })
    }
  }

  private safeWriteResponse(payload: Record<string, unknown>): void {
    if (this.closed || !this.child || this.exitInfo !== null) return
    try {
      this.writeMessage(payload)
    } catch {
      // Ignore write errors if process closed concurrently.
    }
  }

  private rejectAllPending(error: JsonRpcClientError): void {
    for (const [id, pending] of this.pending.entries()) {
      this.pending.delete(id)
      if (pending.timer) clearTimeout(pending.timer)
      pending.abortCleanup?.()
      pending.reject(error)
    }
  }

  private cleanupReaders(): void {
    this.stdoutReader?.close()
    this.stderrReader?.close()
    this.stdoutReader = null
    this.stderrReader = null
  }
}
