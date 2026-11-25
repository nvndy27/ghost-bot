import { createHash } from 'node:crypto'
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

function assertBoundedSchema(value: unknown, depth = 0): void {
  if (depth > MCP_LIMITS.maxSchemaDepth) {
    throw new McpProtocolError('Discovered tool schema exceeds maximum nesting depth')
  }
  if (Array.isArray(value)) {
    for (const item of value) assertBoundedSchema(item, depth + 1)
  } else if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    if (typeof obj.$ref === 'string' && /^https?:\/\//i.test(obj.$ref)) {
      throw new McpProtocolError('Discovered tool schema must not contain remote $ref URLs')
    }
    if ('$dynamicRef' in obj || '$recursiveRef' in obj) {
      throw new McpProtocolError('Discovered tool schema contains unsupported dynamic/recursive $ref')
    }
    if (typeof obj.pattern === 'string' && obj.pattern.length > MCP_LIMITS.maxSchemaPatternLength) {
      throw new McpProtocolError('Discovered tool schema pattern exceeds maximum length')
    }
    if (Array.isArray(obj.enum) && obj.enum.length > MCP_LIMITS.maxSchemaEnumItems) {
      throw new McpProtocolError('Discovered tool schema enum exceeds maximum items')
    }
    for (const item of Object.values(obj)) assertBoundedSchema(item, depth + 1)
  }
}

function assertUniqueCapabilities<T>(
  entries: readonly T[],
  identity: (entry: T) => string,
  limit: number,
): void {
  const keys = entries.map(identity)
  if (keys.some((key) => key.length === 0 || key.length > limit) || new Set(keys).size !== keys.length) {
    throw new McpProtocolError('MCP discovery returned an invalid or duplicate capability identity')
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

  let discoveryBytes = 0
  function accountForPage(page: unknown): void {
    discoveryBytes += Buffer.byteLength(JSON.stringify(page), 'utf8')
    if (discoveryBytes > MCP_LIMITS.maxTotalDiscoveryBytes) {
      throw new McpProtocolError('MCP discovery exceeds total byte limit')
    }
  }

  const reqOpts = { timeout: params.timeoutMs, signal: params.signal }

  if (serverCaps.tools) {
    let cursor: string | undefined
    const seenCursors = new Set<string>()
    for (let page = 0; page < MCP_LIMITS.maxDiscoveryPages; page++) {
      const res = await client.listTools(cursor ? { cursor } : undefined, reqOpts)
      accountForPage(res)
      for (const tool of res.tools) {
        if (tools.length >= MCP_LIMITS.maxDiscoveredTools) {
          throw new McpProtocolError(`Discovered tools exceed limit (${MCP_LIMITS.maxDiscoveredTools})`)
        }
        const inputSchema = (tool.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>
        assertBoundedSchema(inputSchema)
        const definition = JSON.stringify([tool.name, tool.description ?? '', inputSchema])
        if (Buffer.byteLength(JSON.stringify(inputSchema), 'utf8') > MCP_LIMITS.maxSchemaBytes) {
          throw new McpProtocolError('Discovered tool schema exceeds maximum size')
        }
        tools.push({
          capabilityKey: buildCapabilityKey(params.serverId, tool.name),
          serverId: params.serverId,
          name: tool.name,
          description: truncateText(tool.description, MCP_LIMITS.maxCapabilityDescriptionLength),
          inputSchema,
          definitionHash: createHash('sha256').update(definition).digest('hex'),
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
      accountForPage(res)
      for (const r of res.resources) {
        if (resources.length >= MCP_LIMITS.maxDiscoveredResources) {
          throw new McpProtocolError(`Discovered resources exceed limit (${MCP_LIMITS.maxDiscoveredResources})`)
        }
        resources.push({
          capabilityKey: buildCapabilityKey(params.serverId, r.uri),
          serverId: params.serverId,
          uri: r.uri,
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
    accountForPage(tmplRes)
    for (const tmpl of tmplRes.resourceTemplates) {
      if (resourceTemplates.length >= MCP_LIMITS.maxDiscoveredResources) break
      resourceTemplates.push({
        capabilityKey: buildCapabilityKey(params.serverId, tmpl.uriTemplate),
        serverId: params.serverId,
        uriTemplate: tmpl.uriTemplate,
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
      accountForPage(res)
      for (const p of res.prompts) {
        if (prompts.length >= MCP_LIMITS.maxDiscoveredPrompts) {
          throw new McpProtocolError(`Discovered prompts exceed limit (${MCP_LIMITS.maxDiscoveredPrompts})`)
        }
        prompts.push({
          capabilityKey: buildCapabilityKey(params.serverId, p.name),
          serverId: params.serverId,
          name: p.name,
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

  assertUniqueCapabilities(tools, (tool) => tool.name, MCP_LIMITS.maxCapabilityNameLength)
  assertUniqueCapabilities(resources, (resource) => resource.uri, 2048)
  assertUniqueCapabilities(resourceTemplates, (template) => template.uriTemplate, 2048)
  assertUniqueCapabilities(prompts, (prompt) => prompt.name, MCP_LIMITS.maxCapabilityNameLength)

  const snapshot = McpCapabilitySnapshotSchema.parse({
    serverId: params.serverId,
    configFingerprint: params.configFingerprint,
    connectionGeneration: params.connectionGeneration,
    discoveredAt: params.discoveredAt,
    tools,
    resources,
    resourceTemplates,
    prompts,
  })
  const totalBytes = Buffer.byteLength(JSON.stringify(snapshot), 'utf8')
  if (totalBytes > MCP_LIMITS.maxTotalDiscoveryBytes) {
    throw new McpProtocolError(
      `Total discovered capability snapshot exceeds limit (${MCP_LIMITS.maxTotalDiscoveryBytes} bytes)`,
    )
  }
  return snapshot
}
