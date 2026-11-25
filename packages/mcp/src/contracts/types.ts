import type { z } from 'zod'
import type {
  ListMcpServersQuerySchema,
  McpAuthContextSchema,
  McpCapabilitySnapshotSchema,
  McpConnectionStateSchema,
  McpPermissionsSchema,
  McpPromptDescriptorSchema,
  McpResourceDescriptorSchema,
  McpResourceTemplateDescriptorSchema,
  McpScopeKindSchema,
  McpScopeSchema,
  McpSecretRefSchema,
  McpServerConfigSchema,
  McpStdioTransportSchema,
  McpToolDescriptorSchema,
  McpTrustStateSchema,
  RegisterMcpServerInputSchema,
  UpdateMcpServerInputSchema,
} from './schemas.ts'

export type McpScopeKind = z.infer<typeof McpScopeKindSchema>
export type McpScope = z.infer<typeof McpScopeSchema>
export type McpPermissions = z.input<typeof McpPermissionsSchema>
export type McpAuthContext = z.input<typeof McpAuthContextSchema>
export type ParsedMcpAuthContext = z.output<typeof McpAuthContextSchema>
export type McpSecretRef = z.infer<typeof McpSecretRefSchema>
export type McpStdioTransportConfig = z.infer<typeof McpStdioTransportSchema>
export type McpTrustState = z.infer<typeof McpTrustStateSchema>
export type McpConnectionState = z.infer<typeof McpConnectionStateSchema>
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>
export type RegisterMcpServerInput = z.input<typeof RegisterMcpServerInputSchema>
export type UpdateMcpServerInput = z.input<typeof UpdateMcpServerInputSchema>
export type ListMcpServersQuery = z.input<typeof ListMcpServersQuerySchema>
export type McpToolDescriptor = z.infer<typeof McpToolDescriptorSchema>
export type McpResourceDescriptor = z.infer<typeof McpResourceDescriptorSchema>
export type McpResourceTemplateDescriptor = z.infer<typeof McpResourceTemplateDescriptorSchema>
export type McpPromptDescriptor = z.infer<typeof McpPromptDescriptorSchema>
export type McpCapabilitySnapshot = z.infer<typeof McpCapabilitySnapshotSchema>

export type Clock = () => Date
export type IdGenerator = () => string
