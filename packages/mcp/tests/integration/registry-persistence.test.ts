import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  McpDuplicateError,
  McpStorageCorruptionError,
  McpStorageError,
  McpUnsafePathError,
  openMcpDatabase,
  SqliteMcpRegistry,
  type McpAuthContext,
} from '../../src/index.ts'

const AUTH: McpAuthContext = {
  host: {
    actorId: 'user-1',
    userId: 'user-1',
    botId: 'bot-1',
    workspaceId: 'ws-1',
    allowUserWideRead: true,
    allowUserWideWrite: true,
  },
  permissions: {
    canReadConfig: true,
    canManageConfig: true,
    canLaunch: true,
    canDiscover: true,
  },
}

test('SQLite registry persistence: permissions, CRUD, reopen, pagination, duplicates, corruption, and close', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ghost-bot-mcp-reg-'))
  const dbDir = join(rootDir, 'store')
  const dbPath = join(dbDir, 'mcp.sqlite')

  try {
    let tick = 0
    const clock = () => new Date(Date.UTC(2026, 10, 26, 1, 0, tick++))

    const h1 = await openMcpDatabase(dbPath)
    const reg1 = new SqliteMcpRegistry(h1, { clock })

    assert.equal(statSync(dbDir).mode & 0o777, 0o700)
    assert.equal(statSync(dbPath).mode & 0o777, 0o600)

    const s1 = reg1.register(AUTH, {
      scope: { kind: 'bot', userId: 'user-1', botId: 'bot-1' },
      displayName: 'Server One',
      transport: { type: 'stdio', executablePath: process.execPath, cwd: rootDir },
    })
    const s2 = reg1.register(AUTH, {
      scope: { kind: 'workspace', userId: 'user-1', workspaceId: 'ws-1' },
      displayName: 'Server Two',
      transport: { type: 'stdio', executablePath: process.execPath, cwd: rootDir },
    })

    // Duplicate displayName in same scope rejected
    assert.throws(
      () =>
        reg1.register(AUTH, {
          scope: { kind: 'bot', userId: 'user-1', botId: 'bot-1' },
          displayName: 'Server One',
          transport: { type: 'stdio', executablePath: process.execPath, cwd: rootDir },
        }),
      McpDuplicateError,
    )

    // Same displayName in different scope allowed
    const s3 = reg1.register(AUTH, {
      scope: { kind: 'user', userId: 'user-1' },
      displayName: 'Server One',
      transport: { type: 'stdio', executablePath: process.execPath, cwd: rootDir },
    })
    assert.notEqual(s3.id, s1.id)

    reg1.approveTrust(AUTH, s1.id)
    reg1.enable(AUTH, s1.id)
    reg1.close()

    // Reopen and verify persistence & pagination
    const h2 = await openMcpDatabase(dbPath)
    const reg2 = new SqliteMcpRegistry(h2, { clock })
    const loaded1 = reg2.getById(AUTH, s1.id)
    assert.ok(loaded1)
    assert.equal(loaded1.enabled, true)
    assert.equal(loaded1.trustState, 'trusted')

    const page1 = reg2.list(AUTH, { includeUserWide: true, limit: 2, offset: 0 })
    const page2 = reg2.list(AUTH, { includeUserWide: true, limit: 2, offset: 2 })
    assert.equal(page1.total, 3)
    assert.equal(page1.items.length, 2)
    assert.equal(page2.items.length, 1)

    // Revoke trust disables server
    const revoked = reg2.revokeTrust(AUTH, s1.id)
    assert.equal(revoked.enabled, false)
    assert.equal(revoked.trustState, 'revoked')

    assert.equal(reg2.delete(AUTH, s2.id), true)
    assert.equal(reg2.getById(AUTH, s2.id), null)

    // Corrupt row fails closed
    h2.sqlite.prepare("UPDATE mcp_servers SET transport_json = '{bad' WHERE id = ?").run(s1.id)
    assert.throws(() => reg2.getById(AUTH, s1.id), McpStorageCorruptionError)

    reg2.close()
    reg2.close()
    assert.throws(() => reg2.list(AUTH), McpStorageError)

    // Symlinked DB rejected
    const symDb = join(dbDir, 'sym.sqlite')
    symlinkSync(dbPath, symDb)
    await assert.rejects(() => openMcpDatabase(symDb), McpUnsafePathError)
  } finally {
    rmSync(rootDir, { recursive: true, force: true })
  }
})
