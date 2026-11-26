import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { DelegationEngine } from '../src/engine/delegation-engine.ts'
import { openTeamDatabase } from '../src/repository/sqlite-store.ts'
import { TeamRepository } from '../src/repository/team-repository.ts'
import { TeamError } from '../src/security/validation.ts'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-teams-repo-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
})

describe('TeamRepository & SQLite Store', () => {
  it('enforces 0700 directory and 0600 database permissions and rejects symlinks', () => {
    const dir = makeTempDir()
    const subDir = path.join(dir, 'secure-data')
    const handle = openTeamDatabase(subDir)
    handle.close()

    const dirMode = fs.statSync(subDir).mode & 0o777
    const dbMode = fs.statSync(path.join(subDir, 'teams.sqlite')).mode & 0o777
    assert.equal(dirMode, 0o700)
    assert.equal(dbMode, 0o600)

    const linkDir = path.join(dir, 'symlink-data')
    fs.symlinkSync(subDir, linkDir)
    assert.throws(
      () => openTeamDatabase(linkDir),
      (err: unknown) => err instanceof TeamError && err.code === 'INVALID_STORAGE'
    )

    const linkDbDir = path.join(dir, 'link-db-dir')
    fs.mkdirSync(linkDbDir, { mode: 0o700 })
    fs.symlinkSync(path.join(subDir, 'teams.sqlite'), path.join(linkDbDir, 'teams.sqlite'))
    assert.throws(
      () => openTeamDatabase(linkDbDir),
      (err: unknown) => err instanceof TeamError && err.code === 'INVALID_STORAGE'
    )
  })

  it('creates, reads, lists, and archives teams with explicit-only memory sharing and owner isolation', () => {
    const dir = makeTempDir()
    const handle = openTeamDatabase(dir)
    const repo = new TeamRepository(handle)

    const created = repo.createTeam(
      {
        name: 'Research Crew',
        description: 'Coordinates research and synthesis',
        ownerId: 'owner-1',
        leadBotId: 'chief-bot',
        memberBotIds: ['chief-bot', 'worker-a', 'worker-b'],
      },
      1_700_000_000_000
    )

    assert.equal(created.memorySharingPolicy, 'explicit-only')
    assert.equal(created.leadBotId, 'chief-bot')
    assert.deepEqual(created.memberBotIds, ['chief-bot', 'worker-a', 'worker-b'])
    assert.equal(created.archivedAt, null)

    const fetched = repo.getTeam(created.id, 'owner-1')
    assert.equal(fetched.id, created.id)

    assert.throws(
      () => repo.getTeam(created.id, 'owner-2'),
      (err: unknown) => err instanceof TeamError && err.code === 'SCOPE_FORBIDDEN'
    )

    const list = repo.listTeams('owner-1')
    assert.equal(list.total, 1)
    assert.equal(list.teams[0]?.id, created.id)

    const archived = repo.archiveTeam(created.id, 'owner-1', 1_700_000_005_000)
    assert.ok(archived.archivedAt !== null)

    const activeList = repo.listTeams('owner-1')
    assert.equal(activeList.total, 0)
    const allList = repo.listTeams('owner-1', { includeArchived: true })
    assert.equal(allList.total, 1)

    handle.close()
  })

  it('rejects invalid execution bounds and non-member bot posting, and redacts secrets in messages', () => {
    const dir = makeTempDir()
    const handle = openTeamDatabase(dir)
    const repo = new TeamRepository(handle)

    assert.throws(
      () =>
        repo.createTeam({
          name: 'Bad Bounds',
          ownerId: 'owner-1',
          leadBotId: 'chief-bot',
          memberBotIds: ['chief-bot'],
          bounds: { maxDepth: 99 },
        }),
      (err: unknown) => err instanceof TeamError && err.code === 'INVALID_BOUNDS'
    )

    const team = repo.createTeam({
      name: 'Ops Team',
      ownerId: 'owner-1',
      leadBotId: 'chief-bot',
      memberBotIds: ['chief-bot', 'worker-a'],
    })

    const engine = new DelegationEngine(repo)
    const { task } = engine.createRootTask({
      teamId: team.id,
      ownerId: 'owner-1',
      prompt: 'coordinate',
      idempotencyKey: 'key-1',
    })

    assert.throws(
      () =>
        repo.postMessage({
          teamId: team.id,
          ownerId: 'owner-1',
          authorBotId: 'outsider-bot',
          originatingTaskId: task.id,
          content: 'hello',
        }),
      (err: unknown) => err instanceof TeamError && err.code === 'NON_MEMBER_BOT'
    )

    const msg1 = repo.postMessage({
      teamId: team.id,
      ownerId: 'owner-1',
      authorBotId: 'chief-bot',
      targetBotId: 'worker-a',
      originatingTaskId: task.id,
      content: 'Use token=supersecret123 and Bearer abcdefg and sk-1234567890abcdef',
    })

    assert.equal(msg1.authorBotId, 'chief-bot')
    assert.equal(msg1.targetBotId, 'worker-a')
    assert.equal(msg1.originatingTaskId, task.id)
    assert.equal(msg1.seq, 1)
    assert.ok(!msg1.content.includes('supersecret123'))
    assert.ok(!msg1.content.includes('abcdefg'))
    assert.ok(!msg1.content.includes('sk-1234567890abcdef'))

    const messages = repo.listMessages(team.id, 'owner-1')
    assert.equal(messages.length, 1)
    assert.equal(messages[0]?.seq, 1)

    handle.close()
  })
})
