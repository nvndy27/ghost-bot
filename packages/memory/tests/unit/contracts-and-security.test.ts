import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CreateMemoryInputSchema,
  InMemoryMemoryRepository,
  MemoryCredentialError,
  MemoryUnsupportedOriginError,
  MemoryValidationError,
  containsCredentialPattern,
  redactSecrets,
  sanitizeErrorMessage,
  type MemoryAuthContext,
} from '../../src/index.ts'
import { validateStoragePathInput } from '../../src/security/path-guard.ts'

const FIXED_CLOCK = () => new Date('2026-11-25T10:00:00.000Z')

const AUTH: MemoryAuthContext = {
  actorId: 'user-1',
  userId: 'user-1',
  botId: 'bot-1',
  workspaceId: 'ws-1',
  allowUserWideRead: true,
  allowUserWideWrite: true,
}

test('rejects unexpected fields at contract boundary and invalid identifiers/timestamps', () => {
  const extraField = CreateMemoryInputSchema.safeParse({
    scope: { kind: 'bot', userId: 'user-1', botId: 'bot-1' },
    category: 'preference',
    content: 'Prefers concise TypeScript examples',
    unexpectedField: 'nope',
  })
  assert.equal(extraField.success, false)

  const badId = CreateMemoryInputSchema.safeParse({
    scope: { kind: 'bot', userId: 'user:1', botId: 'bot-1' },
    category: 'preference',
    content: 'Invalid colon in userId',
  })
  assert.equal(badId.success, false)

  const badTimestamp = CreateMemoryInputSchema.safeParse({
    scope: { kind: 'bot', userId: 'user-1', botId: 'bot-1' },
    category: 'preference',
    content: 'Bad expiry',
    expiresAt: '2026-11-25 12:00:00',
  })
  assert.equal(badTimestamp.success, false)
})

test('rejects inferred origin creation in Phase 3A', () => {
  const repo = new InMemoryMemoryRepository({ clock: FIXED_CLOCK })
  assert.throws(
    () =>
      repo.create(AUTH, {
        scope: { kind: 'bot', userId: 'user-1', botId: 'bot-1' },
        origin: 'inferred',
        category: 'fact',
        content: 'Inferred fact should be blocked',
      }),
    MemoryUnsupportedOriginError,
  )
})

test('rejects synthetic credentials on create/update and never leaks them in error messages', () => {
  const repo = new InMemoryMemoryRepository({ clock: FIXED_CLOCK })
  const syntheticSecrets = [
    'Use key sk-test1234567890abcdef1234 for calls',
    'GitHub token ghp_1234567890abcdef1234567890',
    'Header Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def',
    '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA',
    'OPENAI_API_KEY=sk-proj-1234567890abcdef123456',
  ]

  for (const secretText of syntheticSecrets) {
    assert.equal(containsCredentialPattern(secretText), true)
    assert.throws(
      () =>
        repo.create(AUTH, {
          scope: { kind: 'bot', userId: 'user-1', botId: 'bot-1' },
          category: 'other',
          content: secretText,
        }),
      (err: unknown) => {
        assert.ok(err instanceof MemoryCredentialError)
        assert.equal(err.message.includes('1234567890'), false)
        assert.equal(err.message.includes('PRIVATE KEY'), false)
        return true
      },
    )
  }

  const created = repo.create(AUTH, {
    scope: { kind: 'bot', userId: 'user-1', botId: 'bot-1' },
    category: 'other',
    content: 'Safe initial content',
  })

  assert.throws(
    () =>
      repo.update(AUTH, created.id, {
        content: 'Updated with Bearer supersecrettoken123456',
      }),
    MemoryCredentialError,
  )

  const redacted = redactSecrets('Failed with sk-test1234567890abcdef1234 and Bearer abcdef1234567890')
  assert.equal(redacted.includes('1234567890'), false)
  assert.ok(redacted.includes('[REDACTED]'))

  const safeErr = sanitizeErrorMessage(new Error('Token ghp_1234567890abcdef123456 failed'))
  assert.equal(safeErr.includes('ghp_'), false)
})

test('rejects oversized inputs and unsafe storage paths', () => {
  const repo = new InMemoryMemoryRepository({ clock: FIXED_CLOCK })
  assert.throws(
    () =>
      repo.create(AUTH, {
        scope: { kind: 'bot', userId: 'user-1', botId: 'bot-1' },
        category: 'fact',
        content: 'a'.repeat(9000),
      }),
    MemoryValidationError,
  )

  assert.throws(() => validateStoragePathInput('relative/path.sqlite'))
  assert.throws(() => validateStoragePathInput('/tmp/bad\0path.sqlite'))
})
