export const MCP_SCHEMA_VERSION = 1 as const
export const MCP_SUPPORTED_SPEC_VERSION = '2025-11-25' as const
export const MCP_SDK_VERSION = '1.32.2' as const

export const MCP_LIMITS = {
  maxIdLength: 128,
  maxDisplayNameLength: 120,
  maxDescriptionLength: 512,
  maxPathLength: 4096,
  maxArgsCount: 64,
  maxArgLength: 1024,
  maxEnvAllowlistCount: 32,
  maxEnvVarNameLength: 64,
  maxSecretRefsCount: 16,
  maxServersPerList: 100,
  defaultListLimit: 25,
  maxMessageBytes: 1_048_576, // 1 MiB
  maxStderrBytes: 16_384, // 16 KiB
  maxPendingRequests: 32,
  maxConcurrentConnections: 16,
  maxDiscoveryPages: 20,
  maxDiscoveredTools: 200,
  maxDiscoveredResources: 200,
  maxDiscoveredPrompts: 200,
  maxCapabilityNameLength: 128,
  maxCapabilityDescriptionLength: 1024,
  maxSchemaBytes: 65_536,
  maxSchemaDepth: 12,
  maxToolArgsBytes: 65_536,
  maxToolResultBytes: 262_144, // 256 KiB
  maxResourceBytes: 262_144,
  maxPromptMessages: 50,
  maxPromptMessageBytes: 65_536,
  defaultConnectTimeoutMs: 5000,
  defaultRequestTimeoutMs: 5000,
  maxTimeoutMs: 30_000,
  gracefulShutdownMs: 1000,
} as const
