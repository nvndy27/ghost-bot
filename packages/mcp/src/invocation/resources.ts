import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { sanitizeErrorMessage } from '@ghost-bot/memory'
import {
  McpNotFoundError,
  McpProtocolError,
  McpTransportError,
  McpValidationError,
} from '../contracts/errors.ts'
import { MCP_LIMITS } from '../contracts/limits.ts'
import type { McpCapabilitySnapshot } from '../contracts/types.ts'

export interface McpResourceReadResult {
  readonly kind: 'untrusted_mcp_resource_data'
  readonly authority: 'none'
  readonly serverId: string
  readonly connectionGeneration: number
  readonly uri: string
  readonly contents: ReadonlyArray<{ uri: string; mimeType?: string; text: string }>
}

export interface McpPromptGetResult {
  readonly kind: 'untrusted_mcp_prompt_data'
  readonly authority: 'none'
  readonly serverId: string
  readonly connectionGeneration: number
  readonly promptName: string
  readonly description?: string
  readonly messages: ReadonlyArray<{ reportedRole: string; text: string }>
}

export async function readMcpResource(
  client: Client,
  snapshot: McpCapabilitySnapshot,
  params: { uri: string; timeoutMs: number; signal?: AbortSignal },
): Promise<McpResourceReadResult> {
  const found = snapshot.resources.find((r) => r.uri === params.uri)
  if (!found) {
    throw new McpNotFoundError('Requested resource URI is not in current capability snapshot')
  }

  let res: Awaited<ReturnType<Client['readResource']>>
  try {
    res = await client.readResource({ uri: params.uri }, { timeout: params.timeoutMs, signal: params.signal })
  } catch (err) {
    throw new McpTransportError(`Failed to read MCP resource: ${sanitizeErrorMessage(err)}`)
  }

  const totalBytes = Buffer.byteLength(JSON.stringify(res), 'utf8')
  if (totalBytes > MCP_LIMITS.maxResourceBytes) {
    throw new McpProtocolError(`MCP resource payload exceeds limit (${MCP_LIMITS.maxResourceBytes} bytes)`)
  }

  const contents = res.contents.map((c) => {
    if ('blob' in c && typeof c.blob === 'string') {
      throw new McpValidationError('Binary blob resource content is unsupported in Phase 3C')
    }
    return {
      uri: c.uri,
      ...(c.mimeType ? { mimeType: c.mimeType } : {}),
      text: 'text' in c && typeof c.text === 'string' ? c.text : '',
    }
  })

  return {
    kind: 'untrusted_mcp_resource_data',
    authority: 'none',
    serverId: snapshot.serverId,
    connectionGeneration: snapshot.connectionGeneration,
    uri: params.uri,
    contents,
  }
}

export async function getMcpPrompt(
  client: Client,
  snapshot: McpCapabilitySnapshot,
  params: { name: string; arguments?: Record<string, string>; timeoutMs: number; signal?: AbortSignal },
): Promise<McpPromptGetResult> {
  const found = snapshot.prompts.find((p) => p.name === params.name)
  if (!found) {
    throw new McpNotFoundError(`Prompt "${params.name}" is not in current capability snapshot`)
  }

  let res: Awaited<ReturnType<Client['getPrompt']>>
  try {
    res = await client.getPrompt(
      { name: params.name, arguments: params.arguments },
      { timeout: params.timeoutMs, signal: params.signal },
    )
  } catch (err) {
    throw new McpTransportError(`Failed to retrieve MCP prompt: ${sanitizeErrorMessage(err)}`)
  }

  if (res.messages.length > MCP_LIMITS.maxPromptMessages) {
    throw new McpProtocolError(`MCP prompt messages exceed limit (${MCP_LIMITS.maxPromptMessages})`)
  }

  const messages = res.messages.map((m) => {
    const contentObj = m.content as Record<string, unknown>
    const text = contentObj.type === 'text' && typeof contentObj.text === 'string' ? contentObj.text : JSON.stringify(contentObj)
    if (Buffer.byteLength(text, 'utf8') > MCP_LIMITS.maxPromptMessageBytes) {
      throw new McpProtocolError(`MCP prompt message exceeds limit (${MCP_LIMITS.maxPromptMessageBytes} bytes)`)
    }
    return {
      reportedRole: m.role,
      text,
    }
  })

  return {
    kind: 'untrusted_mcp_prompt_data',
    authority: 'none',
    serverId: snapshot.serverId,
    connectionGeneration: snapshot.connectionGeneration,
    promptName: params.name,
    ...(res.description ? { description: res.description.slice(0, MCP_LIMITS.maxCapabilityDescriptionLength) } : {}),
    messages,
  }
}
