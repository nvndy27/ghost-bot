import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { CodexAppServerAdapter } from '@ghost-bot/runtime-adapters/codex'
import type { CodexAccountSummary } from '@ghost-bot/runtime-adapters/codex'
import { MockRuntimeAdapter } from '@ghost-bot/runtime-adapters/mock'
import type {
  ProviderSummary,
  RuntimeSnapshot,
} from '@ghost-bot/shared-types/ipc'
import type { ModelInfo, UsageSnapshot } from '@ghost-bot/shared-types/runtime'
import { redactSecrets } from '../errors.ts'
import { resolveCodexVerifiedEvidence } from './policy-broker.ts'

const execFileAsync = promisify(execFile)
const DEFAULT_CACHE_TTL_MS = 30_000
const REFRESH_COOLDOWN_MS = 2_000

export interface CodexMetadataClient {
  getAccountSummary(refreshToken?: boolean): Promise<CodexAccountSummary>
  listModels(): Promise<ModelInfo[]>
  getUsage(): Promise<UsageSnapshot | null>
  close(): Promise<void>
}

export interface RuntimeRegistryOptions {
  runtimeMode: 'codex' | 'mock'
  codexCommand?: string
  codexVersionOverride?: string | null
  codexClientFactory?: (version: string | null) => CodexMetadataClient
  cacheTtlMs?: number
}

export async function detectCodexVersion(command = 'codex'): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(command, ['--version'], {
      timeout: 3000,
      env: { PATH: process.env.PATH },
    })
    const match = /(\d+\.\d+\.\d+)/.exec(stdout)
    return match ? match[1] : stdout.trim() || null
  } catch {
    return null
  }
}

/**
 * Daemon-owned runtime registry.
 * Manages runtime discovery, metadata caching, request deduplication,
 * and lifecycle shutdown without initiating model inference.
 */
export class RuntimeRegistry {
  private readonly options: RuntimeRegistryOptions
  private readonly mock = new MockRuntimeAdapter()
  private codexClient: CodexMetadataClient | null = null
  private codexVersion: string | null | undefined = undefined
  private cachedSnapshot: RuntimeSnapshot | null = null
  private cachedAtMs = 0
  private lastRefreshRequestMs = 0
  private inFlight: Promise<RuntimeSnapshot> | null = null
  private stopped = false

  constructor(options: RuntimeRegistryOptions) {
    this.options = options
  }

  async getSnapshot(refresh = false): Promise<RuntimeSnapshot> {
    if (this.stopped) {
      throw new Error('RuntimeRegistry is stopped')
    }

    const now = Date.now()
    const ttl = this.options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
    const cacheFresh = this.cachedSnapshot !== null && now - this.cachedAtMs < ttl

    if (!refresh && cacheFresh && this.cachedSnapshot) {
      return { ...this.cachedSnapshot, cached: true }
    }

    // Enforce cooldown on explicit refresh unless cache is empty.
    if (refresh && this.cachedSnapshot && now - this.lastRefreshRequestMs < REFRESH_COOLDOWN_MS) {
      return {
        ...this.cachedSnapshot,
        status: cacheFresh ? this.cachedSnapshot.status : 'stale',
        cached: true,
      }
    }

    if (this.inFlight) {
      return this.inFlight
    }

    if (refresh) {
      this.lastRefreshRequestMs = now
    }

    this.inFlight = this.fetchSnapshot().finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  async listProviders(): Promise<ProviderSummary[]> {
    const snap = await this.getSnapshot(false)
    if (snap.runtimeMode === 'mock') {
      return [
        {
          id: this.mock.id,
          label: 'Mock Offline Runtime',
          kind: 'mock',
          status: 'mock',
          detail: 'Explicit offline mock runtime (no real provider calls)',
        },
      ]
    }

    return [
      {
        id: 'codex-app-server',
        label: 'OpenAI Codex (ChatGPT Subscription)',
        kind: 'subscription',
        status:
          snap.authStatus === 'connected'
            ? 'connected'
            : snap.status === 'unavailable'
              ? 'unavailable'
              : 'disconnected',
        detail: snap.detail,
      },
      {
        id: 'openclaw',
        label: 'OpenClaw Gateway',
        kind: 'local',
        status: 'unavailable',
        detail: 'Phase 0 probe verified read-only health; native adapter pending Phase 2',
      },
      {
        id: 'ollama',
        label: 'Ollama Local',
        kind: 'local',
        status: 'unavailable',
        detail: 'Local service not detected at 127.0.0.1:11434',
      },
    ]
  }

  async stop(): Promise<void> {
    this.stopped = true
    await this.mock.disconnect()
    if (this.codexClient) {
      const client = this.codexClient
      this.codexClient = null
      await client.close().catch(() => undefined)
    }
  }

  private async fetchSnapshot(): Promise<RuntimeSnapshot> {
    const observedAt = new Date().toISOString()

    if (this.options.runtimeMode === 'mock') {
      const models = await this.mock.listModels()
      const snap: RuntimeSnapshot = {
        runtimeMode: 'mock',
        codexVersion: null,
        status: 'mock',
        authStatus: 'connected',
        authMethod: 'mock',
        planType: null,
        workspaceName: null,
        detail: 'Offline mock runtime active (sample UI mode; not real account data)',
        models: models.map((m) => ({ id: m.id, label: m.label, efforts: m.efforts })),
        usageStatus: 'mock',
        usageWindows: [],
        usageObservedAt: null,
        verifiedPermissionModes: [],
        observedAt,
        cached: false,
      }
      this.cachedSnapshot = snap
      this.cachedAtMs = Date.now()
      return snap
    }

    if (this.codexVersion === undefined) {
      this.codexVersion =
        this.options.codexVersionOverride !== undefined
          ? this.options.codexVersionOverride
          : await detectCodexVersion(this.options.codexCommand ?? 'codex')
    }

    if (!this.codexVersion) {
      const snap: RuntimeSnapshot = {
        runtimeMode: 'codex',
        codexVersion: null,
        status: 'unavailable',
        authStatus: 'disconnected',
        authMethod: 'none',
        planType: null,
        workspaceName: null,
        detail: 'Codex CLI is not installed or not found on PATH.',
        models: [],
        usageStatus: 'unavailable',
        usageWindows: [],
        usageObservedAt: null,
        verifiedPermissionModes: [],
        observedAt,
        cached: false,
      }
      this.cachedSnapshot = snap
      this.cachedAtMs = Date.now()
      return snap
    }

    const evidence = resolveCodexVerifiedEvidence(this.codexVersion)
    const verifiedModes = (evidence?.verifiedModes ?? []).filter(
      (m): m is 'read-only' | 'ask-approval' | 'workspace' => m !== 'full-access',
    )

    if (!evidence) {
      const snap: RuntimeSnapshot = {
        runtimeMode: 'codex',
        codexVersion: this.codexVersion,
        status: 'unsupported',
        authStatus: 'disconnected',
        authMethod: 'none',
        planType: null,
        workspaceName: null,
        detail: `Codex ${this.codexVersion} is below the verified >= 0.172.0 baseline.`,
        models: [],
        usageStatus: 'unsupported',
        usageWindows: [],
        usageObservedAt: null,
        verifiedPermissionModes: [],
        observedAt,
        cached: false,
      }
      this.cachedSnapshot = snap
      this.cachedAtMs = Date.now()
      return snap
    }

    try {
      if (!this.codexClient) {
        this.codexClient = this.options.codexClientFactory
          ? this.options.codexClientFactory(this.codexVersion)
          : new CodexAppServerAdapter({
              command: this.options.codexCommand,
              permissionEvidence: evidence,
              fullAccessOptIn: false,
            })
      }

      const account = await this.codexClient.getAccountSummary(false)
      const models = await this.codexClient.listModels()

      if (!account.accountPresent) {
        const snap: RuntimeSnapshot = {
          runtimeMode: 'codex',
          codexVersion: this.codexVersion,
          status: 'auth-required',
          authStatus: 'disconnected',
          authMethod: 'none',
          planType: null,
          workspaceName: null,
          detail:
            'Codex profile is not signed in. Sign in manually with: CODEX_HOME=~/.config/ghost-bot/codex-profile codex login --device-auth',
          models: models.map((m) => ({ id: m.id, label: m.label, efforts: m.efforts })),
          usageStatus: 'auth-required',
          usageWindows: [],
          usageObservedAt: null,
          verifiedPermissionModes: verifiedModes,
          observedAt,
          cached: false,
        }
        this.cachedSnapshot = snap
        this.cachedAtMs = Date.now()
        return snap
      }

      if (account.accountType === 'apiKey') {
        const snap: RuntimeSnapshot = {
          runtimeMode: 'codex',
          codexVersion: this.codexVersion,
          status: 'unsupported',
          authStatus: 'error',
          authMethod: 'apiKey',
          planType: null,
          workspaceName: null,
          detail:
            'API-key account detected; subscription-first policy blocks silent paid API usage.',
          models: models.map((m) => ({ id: m.id, label: m.label, efforts: m.efforts })),
          usageStatus: 'unsupported',
          usageWindows: [],
          usageObservedAt: null,
          verifiedPermissionModes: verifiedModes,
          observedAt,
          cached: false,
        }
        this.cachedSnapshot = snap
        this.cachedAtMs = Date.now()
        return snap
      }

      let usage: UsageSnapshot | null = null
      let usageStatus: RuntimeSnapshot['usageStatus'] = 'unavailable'
      try {
        usage = await this.codexClient.getUsage()
        usageStatus = usage && usage.windows.length > 0 ? 'available' : 'unavailable'
      } catch {
        usageStatus = 'unavailable'
      }

      const snap: RuntimeSnapshot = {
        runtimeMode: 'codex',
        codexVersion: this.codexVersion,
        status: 'available',
        authStatus: 'connected',
        authMethod: 'chatgpt',
        planType: account.planType,
        workspaceName: account.workspaceName,
        detail: `Codex ${this.codexVersion} connected (${account.planType ?? 'chatgpt'})`,
        models: models.map((m) => ({ id: m.id, label: m.label, efforts: m.efforts })),
        usageStatus,
        usageWindows: usage?.windows ?? [],
        usageObservedAt: usage?.observedAt ?? null,
        verifiedPermissionModes: verifiedModes,
        observedAt,
        cached: false,
      }
      this.cachedSnapshot = snap
      this.cachedAtMs = Date.now()
      return snap
    } catch (err) {
      // Close potentially broken adapter process so next refresh spawns cleanly.
      if (this.codexClient) {
        const client = this.codexClient
        this.codexClient = null
        await client.close().catch(() => undefined)
      }

      const safeMessage = redactSecrets(
        err instanceof Error ? err.message : 'Codex runtime query failed',
      )

      if (this.cachedSnapshot && this.cachedSnapshot.status === 'available') {
        return {
          ...this.cachedSnapshot,
          status: 'stale',
          usageStatus: 'stale',
          detail: `Showing cached metadata; latest refresh failed: ${safeMessage}`,
          cached: true,
        }
      }

      return {
        runtimeMode: 'codex',
        codexVersion: this.codexVersion,
        status: 'error',
        authStatus: 'error',
        authMethod: 'none',
        planType: null,
        workspaceName: null,
        detail: safeMessage,
        models: [],
        usageStatus: 'error',
        usageWindows: [],
        usageObservedAt: null,
        verifiedPermissionModes: verifiedModes,
        observedAt,
        cached: false,
      }
    }
  }
}
