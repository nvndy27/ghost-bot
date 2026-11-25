import { Validator, type Schema } from '@cfworker/json-schema'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { sanitizeErrorMessage } from '@ghost-bot/memory'
import {
  McpCancelledError,
  McpNotFoundError,
  McpProtocolError,
  McpTimeoutError,
  McpTransportError,
  McpValidationError,
} from '../contracts/errors.ts'
import { MCP_LIMITS } from '../contracts/limits.ts'
import type { McpCapabilitySnapshot } from '../contracts/types.ts'

export interface McpToolInvocationResult {
  readonly kind: 'untrusted_mcp_tool_result'
  readonly authority: 'none'
  readonly serverId: string
  readonly connectionGeneration: number
  readonly capabilityKey: string
  readonly toolName: string
  readonly isToolError: boolean
  readonly content: ReadonlyArray<{ type: string; text?: string; mimeType?: string }>
  readonly structuredContent?: Record<string, unknown>
}

function validateArgsAgainstSchema(args: Record<string, unknown>, inputSchema: Record<string, unknown>): void {
  const argsBytes = Buffer.byteLength(JSON.stringify(args), 'utf8')
  if (argsBytes > MCP_LIMITS.maxToolArgsBytes) {
    throw new McpValidationError(`Tool arguments exceed maximum size (${MCP_LIMITS.maxToolArgsBytes} bytes)`)
  }
  const schemaBytes = Buffer.byteLength(JSON.stringify(inputSchema), 'utf8')
  if (schemaBytes > MCP_LIMITS.maxSchemaBytes) {
    throw new McpProtocolError('Tool input schema exceeds maximum allowed size')
  }

  // Validate locally with no remote $ref resolution
  const validator = new Validator(inputSchema as Schema, '2020-12', false)
  const result = validator.validate(args)
  if (!result.valid) {
    const firstErr = result.errors[0]?.error ?? 'schema validation failed'
    throw new McpValidationError(`Invalid tool arguments: ${firstErr}`)
  }
}

export async function invokeMcpTool(
  client: Client,
  snapshot: McpCapabilitySnapshot,
  params: {
    toolName: string
    args: Record<string, unknown>
    timeoutMs: number
    signal?: AbortSignal
  },
): Promise<McpToolInvocationResult> {
  const tool = snapshot.tools.find((t) => t.name === params.toolName)
  if (!tool) {
    throw new McpNotFoundError(`Tool "${params.toolName}" is not present in current capability snapshot`)
  }

  validateArgsAgainstSchema(params.args, tool.inputSchema)

  if (params.signal?.aborted) {
    throw new McpCancelledError('MCP tool invocation cancelled before dispatch')
  }

  let rawResult: Awaited<ReturnType<Client['callTool']>>
  try {
    rawResult = await client.callTool(
      { name: tool.name, arguments: params.args },
      undefined,
      { timeout: params.timeoutMs, signal: params.signal },
    )
  } catch (err) {
    if (params.signal?.aborted) {
      throw new McpCancelledError('MCP tool invocation cancelled; external side effects are uncertain', {
        uncertainOutcome: true,
      })
    }
    const msg = sanitizeErrorMessage(err)
    if (msg.toLowerCase().includes('timed out') || msg.includes('-32001')) {
      throw new McpTimeoutError('MCP tool invocation timed out; external side effects are uncertain', {
        uncertainOutcome: true,
      })
    }
    throw new McpTransportError(`MCP tool invocation failed: ${msg}`, { uncertainOutcome: true })
  }

  const rawBytes = Buffer.byteLength(JSON.stringify(rawResult), 'utf8')
  if (rawBytes > MCP_LIMITS.maxToolResultBytes) {
    throw new McpProtocolError(
      `MCP tool result exceeds maximum allowed size (${MCP_LIMITS.maxToolResultBytes} bytes)`,
    )
  }

  const rawContent = Array.isArray(rawResult.content) ? rawResult.content : []
  const normalizedContent = rawContent.map((item) => {
    const entry = item as Record<string, unknown>
    return {
      type: typeof entry.type === 'string' ? entry.type : 'unknown',
      ...(typeof entry.text === 'string' ? { text: entry.text } : {}),
      ...(typeof entry.mimeType === 'string' ? { mimeType: entry.mimeType } : {}),
    }
  })

  return {
    kind: 'untrusted_mcp_tool_result',
    authority: 'none',
    serverId: snapshot.serverId,
    connectionGeneration: snapshot.connectionGeneration,
    capabilityKey: tool.capabilityKey,
    toolName: tool.name,
    isToolError: rawResult.isError === true,
    content: normalizedContent,
    ...(rawResult.structuredContent && typeof rawResult.structuredContent === 'object'
      ? { structuredContent: rawResult.structuredContent as Record<string, unknown> }
      : {}),
  }
}
