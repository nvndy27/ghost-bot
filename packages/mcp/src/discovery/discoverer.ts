import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { McpProtocolError } from '../contracts/errors.ts'
import { MCP_LIMITS } from '../contracts/limits.ts'
import { McpCapabilitySnapshotSchema } from '../contracts/schemas.ts'
import type {
  McpCapabilitySnapshot,
  McpPromptDescriptor,
  McpResourceDescriptor,
  McpResourceTemplateDescriptor,
  McpToolDescriptor,
} from '../contracts/types.ts'

export function buildCapabilityKey(serverId: string, capabilityName: string): string {
  return `${serverId}::${capabilityName}`
}

function assertBoundedSchema(schema: Record<string, unknown>, depth = 0): void {
  if (depth > MCP_LIMITS.maxSchemaDepth) {
    throw new McpProtocolError(`Discovered tool schema exceeds maximum nesting depth (${MCP_LIMITS.maxSchemaDepth})`)
  }
  if (depth === 0) {
    const bytes = Buffer.byteLength(JSON.stringify(schema), 'utf8')
    if (bytes > MCP_LIMITS.maxSchemaBytes) {
      throw new McpProtocolError(`Discovered tool schema exceeds maximum size (${MCP_LIMITS.maxSchemaBytes} bytes)`)
    }
  }
  for (const val of Object.values(schema)) {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      assertBoundedSchema(val as Record<string, unknown>, depth + 1)
    } else if (Array.isArray(val)) {
      for (const item of val) {
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          assertBoundedSchema(item as Record<string, unknown>, depth + 1)
        }
      }
    }
  }
}

function truncateText(text: string | undefined, maxLen: number): string {
  if (!text) return ''
  const trimmed = text.trim()
  return trimmed.length <= maxLen ? trimmed : trimmed.slice(0, maxLen)
}

export async function discoverServerCapabilities(
  client: Client,
  params: {
    serverId: string
    configFingerprint: string
    connectionGeneration: number
    discoveredAt: string
    timeoutMs: number
    signal?: AbortSignal
  },
): Promise<McpCapabilitySnapshot> {
  const serverCaps = client.getServerCapabilities() ?? {}
  const tools: McpToolDescriptor[] = []
  const resources: McpResourceDescriptor[] = []
  const resourceTemplates: McpResourceTemplateDescriptor[] = []
  const prompts: McpPromptDescriptor[] = []

  const reqOpts = { timeout: params.timeoutMs, signal: params.signal }

  if (serverCaps.tools) {
    let cursor: string | undefined
    const seenCursors = new Set<string>()
    for (let page = 0; page < MCP_LIMITS.maxDiscoveryPages; page++) {
      const res = await client.listTools(cursor ? { cursor } : undefined, reqOpts)
      for (const tool of res.tools) {
        if (tools.length >= MCP_LIMITS.maxDiscoveredTools) {
          throw new McpProtocolError(`Discovered tools exceed limit (${MCP_LIMITS.maxDiscoveredTools})`)
        }
        const inputSchema = (tool.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>
        assertBoundedSchema(inputSchema)
        tools.push({
          capabilityKey: buildCapabilityKey(params.serverId, tool.name),
          serverId: params.serverId,
          name: tool.name.slice(0, MCP_LIMITS.maxCapabilityNameLength),
          description: truncateText(tool.description, MCP_LIMITS.maxCapabilityDescriptionLength),
          inputSchema,
        })
      }
      if (!res.nextCursor) break
      if (seenCursors.has(res.nextCursor)) {
        throw new McpProtocolError('MCP server returned repeated pagination cursor during tools/list')
      }
      seenCursors.add(res.nextCursor)
      cursor = res.nextCursor
      if (page === MCP_LIMITS.maxDiscoveryPages - 1) {
        throw new McpProtocolError('MCP tools/list exceeded maximum discovery pages')
      }
    }
  }

  if (serverCaps.resources) {
    let cursor: string | undefined
    const seenCursors = new Set<string>()
    for (let page = 0; page < MCP_LIMITS.maxDiscoveryPages; page++) {
      const res = await client.listResources(cursor ? { cursor } : undefined, reqOpts)
      for (const r of res.resources) {
        if (resources.length >= MCP_LIMITS.maxDiscoveredResources) {
          throw new McpProtocolError(`Discovered resources exceed limit (${MCP_LIMITS.maxDiscoveredResources})`)
        }
        resources.push({
          capabilityKey: buildCapabilityKey(params.serverId, r.uri),
          serverId: params.serverId,
          uri: r.uri.slice(0, 2048),
          name: r.name.slice(0, MCP_LIMITS.maxCapabilityNameLength),
          description: truncateText(r.description, MCP_LIMITS.maxCapabilityDescriptionLength),
          ...(r.mimeType ? { mimeType: r.mimeType.slice(0, 128) } : {}),
        })
      }
      if (!res.nextCursor) break
      if (seenCursors.has(res.nextCursor)) {
        throw new McpProtocolError('MCP server returned repeated pagination cursor during resources/list')
      }
      seenCursors.add(res.nextCursor)
      cursor = res.nextCursor
      if (page === MCP_LIMITS.maxDiscoveryPages - 1) {
        throw new McpProtocolError('MCP resources/list exceeded maximum discovery pages')
      }
    }

    const tmplRes = await client.listResourceTemplates(undefined, reqOpts).catch(() => ({ resourceTemplates: [] }))
    for (const tmpl of tmplRes.resourceTemplates) {
      if (resourceTemplates.length >= MCP_LIMITS.maxDiscoveredResources) break
      resourceTemplates.push({
        capabilityKey: buildCapabilityKey(params.serverId, tmpl.uriTemplate),
        serverId: params.serverId,
        uriTemplate: tmpl.uriTemplate.slice(0, 2048),
        name: tmpl.name.slice(0, MCP_LIMITS.maxCapabilityNameLength),
        description: truncateText(tmpl.description, MCP_LIMITS.maxCapabilityDescriptionLength),
        ...(tmpl.mimeType ? { mimeType: tmpl.mimeType.slice(0, 128) } : {}),
      })
    }
  }

  if (serverCaps.prompts) {
    let cursor: string | undefined
    const seenCursors = new Set<string>()
    for (let page = 0; page < MCP_LIMITS.maxDiscoveryPages; page++) {
      const res = await client.listPrompts(cursor ? { cursor } : undefined, reqOpts)
      for (const p of res.prompts) {
        if (prompts.length >= MCP_LIMITS.maxDiscoveredPrompts) {
          throw new McpProtocolError(`Discovered prompts exceed limit (${MCP_LIMITS.maxDiscoveredPrompts})`)
        }
        prompts.push({
          capabilityKey: buildCapabilityKey(params.serverId, p.name),
          serverId: params.serverId,
          name: p.name.slice(0, MCP_LIMITS.maxCapabilityNameLength),
          description: truncateText(p.description, MCP_LIMITS.maxCapabilityDescriptionLength),
          arguments: (p.arguments ?? []).slice(0, 32).map((a) => ({
            name: a.name.slice(0, 128),
            ...(a.description ? { description: truncateText(a.description, 512) } : {}),
            ...(a.required !== undefined ? { required: a.required } : {}),
          })),
        })
      }
      if (!res.nextCursor) break
      if (seenCursors.has(res.nextCursor)) {
        throw new McpProtocolError('MCP server returned repeated pagination cursor during prompts/list')
      }
      seenCursors.add(res.nextCursor)
      cursor = res.nextCursor
      if (page === MCP_LIMITS.maxDiscoveryPages - 1) {
        throw new McpProtocolError('MCP prompts/list exceeded maximum discovery pages')
      }
    }
  }

  return McpCapabilitySnapshotSchema.parse({
    serverId: params.serverId,
    configFingerprint: params.configFingerprint,
    connectionGeneration: params.connectionGeneration,
    discoveredAt: params.discoveredAt,
    tools,
    resources,
    resourceTemplates,
    prompts,
  })
}
