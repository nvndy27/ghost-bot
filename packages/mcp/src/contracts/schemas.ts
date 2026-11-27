import {
  MemoryAuthContextSchema,
  MemoryScopeKindSchema,
  MemoryScopeSchema,
  SafeIdentifierSchema,
  UtcTimestampSchema,
} from '@ghost-bot/memory'
import { z } from 'zod'
import { MCP_LIMITS, MCP_SCHEMA_VERSION } from './limits.ts'

const ENV_VAR_NAME_REGEX = /^[A-Z_][A-Z0-9_]{0,63}$/

function hasNoInlineControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) {
      return false
    }
  }
  return true
}

function hasNoNulBytes(value: string): boolean {
  return !value.includes('\0')
}

export const McpServerIdSchema = SafeIdentifierSchema
export const McpScopeSchema = MemoryScopeSchema
export const McpScopeKindSchema = MemoryScopeKindSchema
export const McpBaseAuthContextSchema = MemoryAuthContextSchema

export const McpPermissionsSchema = z
  .object({
    canReadConfig: z.boolean().default(false),
    canManageConfig: z.boolean().default(false),
    canLaunch: z.boolean().default(false),
    canDiscover: z.boolean().default(false),
    allowedTools: z.array(z.string().min(1).max(MCP_LIMITS.maxCapabilityNameLength)).max(200).default([]),
    allowedToolHashes: z.record(z.string().min(1), z.string().regex(/^[a-f0-9]{64}$/)).optional(),
    allowedResources: z.array(z.string().min(1).max(2048)).max(200).default([]),
    allowedPrompts: z.array(z.string().min(1).max(MCP_LIMITS.maxCapabilityNameLength)).max(200).default([]),
  })
  .strict()

export const McpAuthContextSchema = z
  .object({
    host: McpBaseAuthContextSchema,
    permissions: McpPermissionsSchema,
  })
  .strict()

export const McpEnvVarNameSchema = z
  .string()
  .min(1)
  .max(MCP_LIMITS.maxEnvVarNameLength)
  .regex(ENV_VAR_NAME_REGEX, 'Environment variable name must match ^[A-Z_][A-Z0-9_]{0,63}$')

export const McpSecretRefSchema = z
  .object({
    envVar: McpEnvVarNameSchema,
    refId: SafeIdentifierSchema,
    label: z.string().trim().min(1).max(120).refine(hasNoInlineControlChars).optional(),
  })
  .strict()

export const McpStdioTransportSchema = z
  .object({
    type: z.literal('stdio'),
    executablePath: z.string().min(1).max(MCP_LIMITS.maxPathLength).refine(hasNoInlineControlChars),
    args: z
      .array(z.string().max(MCP_LIMITS.maxArgLength).refine(hasNoNulBytes))
      .max(MCP_LIMITS.maxArgsCount)
      .default([]),
    cwd: z.string().min(1).max(MCP_LIMITS.maxPathLength).refine(hasNoInlineControlChars),
    envAllowlist: z.array(McpEnvVarNameSchema).max(MCP_LIMITS.maxEnvAllowlistCount).default([]),
    secretRefs: z.array(McpSecretRefSchema).max(MCP_LIMITS.maxSecretRefsCount).default([]),
  })
  .strict()

export const McpTrustStateSchema = z.enum(['untrusted', 'trusted', 'revoked'])
export const McpConnectionStateSchema = z.enum([
  'disconnected',
  'connecting',
  'ready',
  'disconnecting',
  'failed',
])

export const Sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/)

export const McpServerConfigSchema = z
  .object({
    schemaVersion: z.literal(MCP_SCHEMA_VERSION),
    id: McpServerIdSchema,
    scope: McpScopeSchema,
    displayName: z.string().trim().min(1).max(MCP_LIMITS.maxDisplayNameLength).refine(hasNoInlineControlChars),
    description: z.string().trim().max(MCP_LIMITS.maxDescriptionLength).refine(hasNoNulBytes).default(''),
    transport: McpStdioTransportSchema,
    enabled: z.boolean(),
    trustState: McpTrustStateSchema,
    configFingerprint: Sha256HexSchema,
    trustedFingerprint: Sha256HexSchema.nullable(),
    trustedBinaryDigest: Sha256HexSchema.nullable().default(null),
    connectTimeoutMs: z.number().int().min(500).max(MCP_LIMITS.maxTimeoutMs).default(MCP_LIMITS.defaultConnectTimeoutMs),
    requestTimeoutMs: z.number().int().min(500).max(MCP_LIMITS.maxTimeoutMs).default(MCP_LIMITS.defaultRequestTimeoutMs),
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
  })
  .strict()

export const RegisterMcpServerInputSchema = z
  .object({
    id: McpServerIdSchema.optional(),
    scope: McpScopeSchema,
    displayName: z.string().trim().min(1).max(MCP_LIMITS.maxDisplayNameLength).refine(hasNoInlineControlChars),
    description: z.string().trim().max(MCP_LIMITS.maxDescriptionLength).refine(hasNoNulBytes).default(''),
    transport: McpStdioTransportSchema,
    connectTimeoutMs: z.number().int().min(500).max(MCP_LIMITS.maxTimeoutMs).optional(),
    requestTimeoutMs: z.number().int().min(500).max(MCP_LIMITS.maxTimeoutMs).optional(),
  })
  .strict()

export const UpdateMcpServerInputSchema = z
  .object({
    displayName: z.string().trim().min(1).max(MCP_LIMITS.maxDisplayNameLength).refine(hasNoInlineControlChars).optional(),
    description: z.string().trim().max(MCP_LIMITS.maxDescriptionLength).refine(hasNoNulBytes).optional(),
    transport: McpStdioTransportSchema.optional(),
    connectTimeoutMs: z.number().int().min(500).max(MCP_LIMITS.maxTimeoutMs).optional(),
    requestTimeoutMs: z.number().int().min(500).max(MCP_LIMITS.maxTimeoutMs).optional(),
  })
  .strict()
  .refine(
    (val) =>
      val.displayName !== undefined ||
      val.description !== undefined ||
      val.transport !== undefined ||
      val.connectTimeoutMs !== undefined ||
      val.requestTimeoutMs !== undefined,
    { message: 'At least one updatable field must be provided' },
  )

export const ListMcpServersQuerySchema = z
  .object({
    scopeKinds: z.array(McpScopeKindSchema).min(1).max(3).optional(),
    includeUserWide: z.boolean().default(false),
    enabledOnly: z.boolean().default(false),
    limit: z.number().int().min(1).max(MCP_LIMITS.maxServersPerList).default(MCP_LIMITS.defaultListLimit),
    offset: z.number().int().min(0).max(100_000).default(0),
  })
  .strict()

export const McpToolDescriptorSchema = z
  .object({
    capabilityKey: z.string().min(1),
    serverId: McpServerIdSchema,
    name: z.string().min(1).max(MCP_LIMITS.maxCapabilityNameLength),
    description: z.string().max(MCP_LIMITS.maxCapabilityDescriptionLength),
    inputSchema: z.record(z.string(), z.unknown()),
    definitionHash: Sha256HexSchema,
  })
  .strict()

export const McpResourceDescriptorSchema = z
  .object({
    capabilityKey: z.string().min(1),
    serverId: McpServerIdSchema,
    uri: z.string().min(1).max(2048),
    name: z.string().min(1).max(MCP_LIMITS.maxCapabilityNameLength),
    description: z.string().max(MCP_LIMITS.maxCapabilityDescriptionLength),
    mimeType: z.string().max(128).optional(),
  })
  .strict()

export const McpResourceTemplateDescriptorSchema = z
  .object({
    capabilityKey: z.string().min(1),
    serverId: McpServerIdSchema,
    uriTemplate: z.string().min(1).max(2048),
    name: z.string().min(1).max(MCP_LIMITS.maxCapabilityNameLength),
    description: z.string().max(MCP_LIMITS.maxCapabilityDescriptionLength),
    mimeType: z.string().max(128).optional(),
  })
  .strict()

export const McpPromptDescriptorSchema = z
  .object({
    capabilityKey: z.string().min(1),
    serverId: McpServerIdSchema,
    name: z.string().min(1).max(MCP_LIMITS.maxCapabilityNameLength),
    description: z.string().max(MCP_LIMITS.maxCapabilityDescriptionLength),
    arguments: z
      .array(
        z
          .object({
            name: z.string().min(1).max(128),
            description: z.string().max(512).optional(),
            required: z.boolean().optional(),
          })
          .strict(),
      )
      .max(32),
  })
  .strict()

export const McpCapabilitySnapshotSchema = z
  .object({
    serverId: McpServerIdSchema,
    configFingerprint: Sha256HexSchema,
    connectionGeneration: z.number().int().min(1),
    discoveredAt: UtcTimestampSchema,
    tools: z.array(McpToolDescriptorSchema),
    resources: z.array(McpResourceDescriptorSchema),
    resourceTemplates: z.array(McpResourceTemplateDescriptorSchema),
    prompts: z.array(McpPromptDescriptorSchema),
  })
  .strict()
