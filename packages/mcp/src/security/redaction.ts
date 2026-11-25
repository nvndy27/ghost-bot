import { containsCredentialPattern, redactSecrets, sanitizeErrorMessage } from '@ghost-bot/memory'
import { McpCredentialError } from '../contracts/errors.ts'
import type { McpStdioTransportConfig } from '../contracts/types.ts'

export { containsCredentialPattern, redactSecrets, sanitizeErrorMessage }

const BLOCKED_ENV_VARS = new Set([
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'NPM_TOKEN',
  'NODE_AUTH_TOKEN',
  'PATH',
  'NODE_OPTIONS',
  'NODE_PATH',
  'BASH_ENV',
  'ENV',
  'GCONV_PATH',
  'GLIBC_TUNABLES',
  'RUBYOPT',
  'PERL5OPT',
])

function isBlockedEnvVar(name: string): boolean {
  return BLOCKED_ENV_VARS.has(name) || /^(?:LD_|DYLD_|PYTHON)/.test(name)
}

const SAFE_BASELINE_ENV_KEYS = ['LANG', 'LC_ALL', 'TERM'] as const

export function assertNoCredentialsInServerInput(fields: {
  displayName?: string
  description?: string
  transport?: McpStdioTransportConfig
}): void {
  if (fields.displayName && containsCredentialPattern(fields.displayName)) {
    throw new McpCredentialError('MCP displayName rejected because it matches a recognized credential pattern')
  }
  if (fields.description && containsCredentialPattern(fields.description)) {
    throw new McpCredentialError('MCP description rejected because it matches a recognized credential pattern')
  }
  if (fields.transport) {
    if (
      containsCredentialPattern(fields.transport.executablePath) ||
      containsCredentialPattern(fields.transport.cwd)
    ) {
      throw new McpCredentialError('MCP transport path rejected because it matches a recognized credential pattern')
    }
    for (const arg of fields.transport.args) {
      if (containsCredentialPattern(arg)) {
        throw new McpCredentialError('MCP transport argument rejected because it matches a recognized credential pattern')
      }
    }
    for (const envVar of fields.transport.envAllowlist) {
      if (isBlockedEnvVar(envVar)) {
        throw new McpCredentialError(`MCP envAllowlist cannot include protected environment variable "${envVar}"`)
      }
    }
    for (const ref of fields.transport.secretRefs) {
      if (isBlockedEnvVar(ref.envVar)) {
        throw new McpCredentialError(`MCP secretRefs cannot target protected environment variable "${ref.envVar}"`)
      }
      if (ref.label && containsCredentialPattern(ref.label)) {
        throw new McpCredentialError('MCP secretRef label rejected because it matches a recognized credential pattern')
      }
    }
  }
}

export function buildMinimalChildEnv(
  envAllowlist: readonly string[],
  hostEnv: Readonly<Record<string, string | undefined>> = {},
  resolvedSecrets: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const env: Record<string, string> = {
    PATH: '/usr/local/bin:/usr/bin:/bin',
  }

  for (const key of SAFE_BASELINE_ENV_KEYS) {
    const val = hostEnv[key]
    if (typeof val === 'string' && !val.includes('\0')) {
      env[key] = val
    }
  }

  for (const key of envAllowlist) {
    if (isBlockedEnvVar(key)) continue
    const val = hostEnv[key]
    if (typeof val === 'string' && !val.includes('\0')) {
      env[key] = val
    }
  }

  for (const [key, val] of Object.entries(resolvedSecrets)) {
    if (isBlockedEnvVar(key)) continue
    if (typeof val === 'string' && !val.includes('\0')) {
      env[key] = val
    }
  }

  return env
}
