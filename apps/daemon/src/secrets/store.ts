import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { McpCredentialError } from '@ghost-bot/mcp'

export interface SecretStoreStatus {
  available: boolean
  locked: boolean
  backend: 'linux-secret-service' | 'memory-test-only' | 'unavailable'
  reason: string | null
  diagnostics?: {
    executableAvailable: boolean
    dbusSessionAvailable: boolean
    dbusServiceAvailable: boolean
    collectionAccessible: boolean
  }
}

export interface SecretCoordinate {
  ownerId: string
  serverId: string
  refId: string
}

export interface SecretStore {
  getStatus(): SecretStoreStatus
  store(coord: SecretCoordinate, label: string, secretValue: string): void
  replace(coord: SecretCoordinate, label: string, secretValue: string): void
  resolve(coord: SecretCoordinate): string
  exists(coord: SecretCoordinate): boolean
  delete(coord: SecretCoordinate): boolean
}

const MAX_SECRET_BYTES = 16 * 1024

function validateSecretInput(coord: SecretCoordinate, label: string, secretValue: string): string {
  if (!coord.ownerId || !coord.serverId || !coord.refId) {
    throw new McpCredentialError('Secret coordinate requires ownerId, serverId, and refId')
  }
  if (typeof secretValue !== 'string' || secretValue.length === 0) {
    throw new McpCredentialError('Secret value must be a non-empty string')
  }
  if (secretValue.includes('\0')) {
    throw new McpCredentialError('Secret value cannot contain NUL bytes')
  }
  if (Buffer.byteLength(secretValue, 'utf8') > MAX_SECRET_BYTES) {
    throw new McpCredentialError(`Secret value exceeds maximum ${MAX_SECRET_BYTES} bytes`)
  }
  const cleanLabel = label.replace(/[\r\n\0]/g, ' ').trim().slice(0, 120)
  return cleanLabel || `Ghost Bot MCP (${coord.refId})`
}

function resolveExecutable(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

export class UnavailableSecretStore implements SecretStore {
  private readonly reason: string

  constructor(reason = 'OS Secret Service is unavailable on this host') {
    this.reason = reason
  }

  getStatus(): SecretStoreStatus {
    return {
      available: false,
      locked: false,
      backend: 'unavailable',
      reason: this.reason,
    }
  }

  store(): void {
    throw new McpCredentialError(this.reason)
  }

  replace(): void {
    throw new McpCredentialError(this.reason)
  }

  resolve(): string {
    throw new McpCredentialError(this.reason)
  }

  exists(): boolean {
    return false
  }

  delete(): boolean {
    throw new McpCredentialError(this.reason)
  }
}

export class LinuxSecretServiceStore implements SecretStore {
  private readonly namespace: string
  private readonly secretToolPath: string | null
  private readonly busctlPath: string | null

  constructor(options: { namespace?: string; secretToolPath?: string; busctlPath?: string } = {}) {
    this.namespace = options.namespace?.trim() || 'prod'
    this.secretToolPath =
      options.secretToolPath ?? resolveExecutable(['/usr/bin/secret-tool', '/bin/secret-tool'])
    this.busctlPath = options.busctlPath ?? resolveExecutable(['/usr/bin/busctl', '/bin/busctl'])
  }

  private attrs(coord: SecretCoordinate): string[] {
    return [
      'service',
      'ghost-bot.mcp',
      'namespace',
      this.namespace,
      'owner_id',
      coord.ownerId,
      'server_id',
      coord.serverId,
      'ref_id',
      coord.refId,
    ]
  }

  getStatus(): SecretStoreStatus {
    if (process.platform !== 'linux') {
      return {
        available: false,
        locked: false,
        backend: 'unavailable',
        reason: 'Linux Secret Service is only supported on Linux hosts',
        diagnostics: {
          executableAvailable: false,
          dbusSessionAvailable: false,
          dbusServiceAvailable: false,
          collectionAccessible: false,
        },
      }
    }
    if (!this.secretToolPath) {
      return {
        available: false,
        locked: false,
        backend: 'unavailable',
        reason: 'secret-tool CLI is not installed; OS Secret Service unavailable',
        diagnostics: {
          executableAvailable: false,
          dbusSessionAvailable: Boolean(process.env.DBUS_SESSION_BUS_ADDRESS),
          dbusServiceAvailable: false,
          collectionAccessible: false,
        },
      }
    }
    if (!process.env.DBUS_SESSION_BUS_ADDRESS) {
      return {
        available: false,
        locked: false,
        backend: 'unavailable',
        reason: 'D-Bus user session bus is unavailable; cannot reach OS Secret Service',
        diagnostics: {
          executableAvailable: true,
          dbusSessionAvailable: false,
          dbusServiceAvailable: false,
          collectionAccessible: false,
        },
      }
    }

    if (!this.busctlPath || !fs.existsSync(this.busctlPath)) {
      return {
        available: false,
        locked: false,
        backend: 'unavailable',
        reason: 'busctl CLI is not installed; cannot verify OS Secret Service collection state',
        diagnostics: {
          executableAvailable: true,
          dbusSessionAvailable: true,
          dbusServiceAvailable: false,
          collectionAccessible: false,
        },
      }
    }

    let serviceReachable = false
    try {
      execFileSync(
        this.busctlPath,
        [
          '--user',
          'call',
          'org.freedesktop.DBus',
          '/org/freedesktop/DBus',
          'org.freedesktop.DBus',
          'GetNameOwner',
          's',
          'org.freedesktop.secrets',
        ],
        { stdio: ['ignore', 'pipe', 'pipe'], timeout: 2_000 },
      )
      serviceReachable = true
    } catch {
      serviceReachable = false
    }

    if (!serviceReachable) {
      return {
        available: false,
        locked: false,
        backend: 'unavailable',
        reason: 'org.freedesktop.secrets D-Bus service is not running or unreachable',
        diagnostics: {
          executableAvailable: true,
          dbusSessionAvailable: true,
          dbusServiceAvailable: false,
          collectionAccessible: false,
        },
      }
    }

    for (const objectPath of [
      '/org/freedesktop/secrets/aliases/default',
      '/org/freedesktop/secrets/collection/login',
    ]) {
      try {
        const out = execFileSync(
          this.busctlPath,
          [
            '--user',
            'get-property',
            'org.freedesktop.secrets',
            objectPath,
            'org.freedesktop.Secret.Collection',
            'Locked',
          ],
          { stdio: ['ignore', 'pipe', 'pipe'], timeout: 2_000 },
        )
          .toString('utf8')
          .trim()
        if (out === 'b true') {
          return {
            available: false,
            locked: true,
            backend: 'linux-secret-service',
            reason: 'OS Secret Service keyring is locked; unlock your login keyring to access secrets',
            diagnostics: {
              executableAvailable: true,
              dbusSessionAvailable: true,
              dbusServiceAvailable: true,
              collectionAccessible: true,
            },
          }
        }
        if (out === 'b false') {
          return {
            available: true,
            locked: false,
            backend: 'linux-secret-service',
            reason: null,
            diagnostics: {
              executableAvailable: true,
              dbusSessionAvailable: true,
              dbusServiceAvailable: true,
              collectionAccessible: true,
            },
          }
        }
      } catch {
        // Try next collection object path
      }
    }

    return {
      available: false,
      locked: false,
      backend: 'unavailable',
      reason: 'OS Secret Service default/login collection is inaccessible or missing (fail-closed)',
      diagnostics: {
        executableAvailable: true,
        dbusSessionAvailable: true,
        dbusServiceAvailable: true,
        collectionAccessible: false,
      },
    }
  }

  private assertAvailable(): void {
    const status = this.getStatus()
    if (!status.available) {
      throw new McpCredentialError(
        status.reason ?? 'OS Secret Service is unavailable or locked',
      )
    }
  }

  store(coord: SecretCoordinate, label: string, secretValue: string): void {
    this.assertAvailable()
    const cleanLabel = validateSecretInput(coord, label, secretValue)
    try {
      execFileSync(
        this.secretToolPath!,
        ['store', `--label=${cleanLabel}`, ...this.attrs(coord)],
        {
          input: secretValue,
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 5_000,
        },
      )
    } catch {
      throw new McpCredentialError(
        `Failed to store secret reference "${coord.refId}" in OS Secret Service`,
      )
    }
  }

  replace(coord: SecretCoordinate, label: string, secretValue: string): void {
    this.store(coord, label, secretValue)
  }

  resolve(coord: SecretCoordinate): string {
    this.assertAvailable()
    if (!coord.ownerId || !coord.serverId || !coord.refId) {
      throw new McpCredentialError('Invalid secret coordinate')
    }
    try {
      const value = execFileSync(this.secretToolPath!, ['lookup', ...this.attrs(coord)], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 5_000,
      }).toString('utf8')
      if (value.length === 0) {
        throw new McpCredentialError(
          `MCP secret reference "${coord.refId}" was not found in OS Secret Service`,
        )
      }
      return value
    } catch (err) {
      if (err instanceof McpCredentialError) throw err
      throw new McpCredentialError(
        `MCP secret reference "${coord.refId}" was not found or keyring is locked`,
      )
    }
  }

  exists(coord: SecretCoordinate): boolean {
    const status = this.getStatus()
    if (!status.available) return false
    try {
      const value = execFileSync(this.secretToolPath!, ['lookup', ...this.attrs(coord)], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 5_000,
      }).toString('utf8')
      return value.length > 0
    } catch {
      return false
    }
  }

  delete(coord: SecretCoordinate): boolean {
    this.assertAvailable()
    if (!coord.ownerId || !coord.serverId || !coord.refId) {
      throw new McpCredentialError('Invalid secret coordinate')
    }
    const existed = this.exists(coord)
    try {
      execFileSync(this.secretToolPath!, ['clear', ...this.attrs(coord)], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 5_000,
      })
      return existed
    } catch {
      throw new McpCredentialError(
        `Failed to delete secret reference "${coord.refId}" from OS Secret Service`,
      )
    }
  }
}

/**
 * Explicitly test-only in-memory SecretStore for deterministic offline tests.
 * Never used in production daemon startup.
 */
export class InMemoryTestSecretStore implements SecretStore {
  private readonly items = new Map<string, string>()
  private locked = false
  private available = true

  private key(coord: SecretCoordinate): string {
    return `${coord.ownerId}\0${coord.serverId}\0${coord.refId}`
  }

  setLocked(locked: boolean): void {
    this.locked = locked
  }

  setAvailable(available: boolean): void {
    this.available = available
  }

  getStatus(): SecretStoreStatus {
    if (!this.available) {
      return {
        available: false,
        locked: false,
        backend: 'unavailable',
        reason: 'Test secret store configured unavailable',
      }
    }
    if (this.locked) {
      return {
        available: false,
        locked: true,
        backend: 'memory-test-only',
        reason: 'Test secret store is locked',
      }
    }
    return {
      available: true,
      locked: false,
      backend: 'memory-test-only',
      reason: null,
    }
  }

  private assertAvailable(): void {
    const status = this.getStatus()
    if (!status.available) {
      throw new McpCredentialError(status.reason ?? 'Secret store unavailable')
    }
  }

  store(coord: SecretCoordinate, label: string, secretValue: string): void {
    this.assertAvailable()
    validateSecretInput(coord, label, secretValue)
    this.items.set(this.key(coord), secretValue)
  }

  replace(coord: SecretCoordinate, label: string, secretValue: string): void {
    this.store(coord, label, secretValue)
  }

  resolve(coord: SecretCoordinate): string {
    this.assertAvailable()
    const val = this.items.get(this.key(coord))
    if (val === undefined) {
      throw new McpCredentialError(`MCP secret reference "${coord.refId}" was not found`)
    }
    return val
  }

  exists(coord: SecretCoordinate): boolean {
    if (!this.getStatus().available) return false
    return this.items.has(this.key(coord))
  }

  delete(coord: SecretCoordinate): boolean {
    this.assertAvailable()
    return this.items.delete(this.key(coord))
  }
}

export function createDefaultSecretStore(): SecretStore {
  if (process.env.GHOST_SECRET_STORE_MODE === 'unavailable') {
    return new UnavailableSecretStore('OS Secret Service disabled by environment configuration')
  }
  if (process.platform !== 'linux') {
    return new UnavailableSecretStore(`OS Secret Service is not implemented for ${process.platform}`)
  }
  return new LinuxSecretServiceStore({
    namespace: process.env.GHOST_SECRET_NAMESPACE || 'prod',
  })
}
