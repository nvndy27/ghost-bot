import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { redactSecrets, sanitizeErrorMessage } from '@ghost-bot/memory'
import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js'
import { JSONRPCMessageSchema, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { McpProtocolError, McpTransportError } from '../contracts/errors.ts'
import { MCP_LIMITS } from '../contracts/limits.ts'

export interface BoundedStdioTransportOptions {
  readonly executablePath: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly maxMessageBytes?: number
  readonly maxStderrBytes?: number
  readonly gracefulShutdownMs?: number
}

export class BoundedStdioClientTransport implements Transport {
  private readonly options: BoundedStdioTransportOptions
  private readonly maxMessageBytes: number
  private readonly maxStderrBytes: number
  private readonly gracefulShutdownMs: number

  private child: ChildProcessWithoutNullStreams | null = null
  private started = false
  private closed = false
  private lineChunks: Buffer[] = []
  private lineByteCount = 0
  private stderrChunks: Buffer[] = []
  private stderrByteCount = 0

  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void

  constructor(options: BoundedStdioTransportOptions) {
    this.options = options
    this.maxMessageBytes = options.maxMessageBytes ?? MCP_LIMITS.maxMessageBytes
    this.maxStderrBytes = options.maxStderrBytes ?? MCP_LIMITS.maxStderrBytes
    this.gracefulShutdownMs = options.gracefulShutdownMs ?? MCP_LIMITS.gracefulShutdownMs
  }

  get pid(): number | null {
    return this.child?.pid ?? null
  }

  getSanitizedStderr(): string {
    if (this.stderrChunks.length === 0) return ''
    return redactSecrets(Buffer.concat(this.stderrChunks).toString('utf8')).trim()
  }

  async start(): Promise<void> {
    if (this.started) {
      throw new McpTransportError('BoundedStdioClientTransport already started')
    }
    if (this.closed) {
      throw new McpTransportError('BoundedStdioClientTransport is already closed')
    }
    this.started = true

    await new Promise<void>((resolve, reject) => {
      let settled = false
      const child = spawn(this.options.executablePath, [...this.options.args], {
        cwd: this.options.cwd,
        env: { ...this.options.env },
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      this.child = child

      child.once('error', (err) => {
        const wrapped = new McpTransportError(`Failed to spawn MCP server: ${sanitizeErrorMessage(err)}`)
        if (!settled) {
          settled = true
          reject(wrapped)
        } else {
          this.onerror?.(wrapped)
        }
      })

      child.once('spawn', () => {
        if (!settled) {
          settled = true
          resolve()
        }
      })

      child.stdout.on('data', (chunk: Buffer) => {
        if (this.closed) return
        this.handleStdoutChunk(chunk)
      })

      child.stderr.on('data', (chunk: Buffer) => {
        if (this.closed) return
        this.appendStderr(chunk)
      })

      child.once('close', (code, signal) => {
        const wasClosed = this.closed
        this.closed = true
        this.child = null
        this.lineChunks = []
        this.lineByteCount = 0
        if (!wasClosed) {
          if (code !== 0 && code !== null) {
            const stderrNote = this.getSanitizedStderr()
            this.onerror?.(
              new McpTransportError(
                `MCP server exited with code ${code}${stderrNote ? `: ${stderrNote.slice(0, 200)}` : ''}`,
              ),
            )
          } else if (signal) {
            this.onerror?.(new McpTransportError(`MCP server terminated by signal ${signal}`))
          }
          this.onclose?.()
        }
      })
    })
  }

  private appendStderr(chunk: Buffer): void {
    if (this.stderrByteCount >= this.maxStderrBytes) return
    const remaining = this.maxStderrBytes - this.stderrByteCount
    const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk
    this.stderrChunks.push(slice)
    this.stderrByteCount += slice.length
  }

  private handleStdoutChunk(chunk: Buffer): void {
    let offset = 0
    while (offset < chunk.length && !this.closed) {
      const nlIdx = chunk.indexOf(0x0a, offset)
      if (nlIdx === -1) {
        const segmentLen = chunk.length - offset
        if (this.lineByteCount + segmentLen > this.maxMessageBytes) {
          this.abortOversizedMessage()
          return
        }
        this.lineChunks.push(chunk.subarray(offset))
        this.lineByteCount += segmentLen
        return
      }

      const segmentLen = nlIdx - offset
      if (this.lineByteCount + segmentLen > this.maxMessageBytes) {
        this.abortOversizedMessage()
        return
      }

      if (segmentLen > 0) {
        this.lineChunks.push(chunk.subarray(offset, nlIdx))
      }
      const lineBuf = this.lineChunks.length === 1 ? this.lineChunks[0]! : Buffer.concat(this.lineChunks)
      this.lineChunks = []
      this.lineByteCount = 0
      offset = nlIdx + 1

      const lineStr = lineBuf.toString('utf8').replace(/\r$/, '').trim()
      if (!lineStr) continue

      let rawJson: unknown
      try {
        rawJson = JSON.parse(lineStr)
      } catch {
        this.onerror?.(new McpProtocolError('MCP server emitted malformed JSON'))
        continue
      }

      const parsed = JSONRPCMessageSchema.safeParse(rawJson)
      if (!parsed.success) {
        this.onerror?.(new McpProtocolError('MCP server emitted invalid JSON-RPC message framing'))
        continue
      }
      this.onmessage?.(parsed.data)
    }
  }

  private abortOversizedMessage(): void {
    this.lineChunks = []
    this.lineByteCount = 0
    const err = new McpTransportError(
      `MCP server message exceeded hard transport limit (${this.maxMessageBytes} bytes)`,
    )
    this.onerror?.(err)
    void this.close()
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    if (this.closed || !this.child || !this.child.stdin.writable) {
      throw new McpTransportError('Cannot send message: MCP STDIO transport is not open')
    }
    const serialized = `${JSON.stringify(message)}\n`
    const byteLen = Buffer.byteLength(serialized, 'utf8')
    if (byteLen > this.maxMessageBytes) {
      throw new McpTransportError(`Outgoing MCP message exceeds maximum byte limit (${this.maxMessageBytes} bytes)`)
    }

    await new Promise<void>((resolve, reject) => {
      const child = this.child
      if (!child || !child.stdin.writable) {
        reject(new McpTransportError('MCP stdin stream is closed'))
        return
      }
      child.stdin.write(serialized, 'utf8', (err) => {
        if (err) {
          reject(new McpTransportError(`Failed to write to MCP stdin: ${sanitizeErrorMessage(err)}`))
        } else {
          resolve()
        }
      })
    })
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.lineChunks = []
    this.lineByteCount = 0

    const child = this.child
    this.child = null

    if (child) {
      try {
        child.stdin.end()
      } catch {
        // Ignore stdin close error.
      }
      try {
        child.stdout.destroy()
        child.stderr.destroy()
      } catch {
        // Ignore stream destroy error.
      }

      if (child.exitCode === null && child.signalCode === null && child.pid) {
        await new Promise<void>((resolve) => {
          let finished = false
          const done = () => {
            if (finished) return
            finished = true
            clearTimeout(killTimer)
            resolve()
          }
          child.once('exit', done)
          child.once('close', done)
          try {
            child.kill('SIGTERM')
          } catch {
            done()
            return
          }
          const killTimer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null && child.pid) {
              try {
                child.kill('SIGKILL')
              } catch {
                // Ignore kill failure.
              }
            }
            done()
          }, this.gracefulShutdownMs)
          killTimer.unref()
        })
      }
    }

    this.onclose?.()
  }
}
