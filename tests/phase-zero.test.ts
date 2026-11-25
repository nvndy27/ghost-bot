import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { normalizeCodexModel } from '../packages/shared-types/discovery.ts'
import { canEnablePermission } from '../packages/shared-types/permissions.ts'

test('normalizes observed model metadata only and deduplicates efforts', () => {
  assert.deepEqual(normalizeCodexModel({
    id: 'fixture', displayName: 'Fixture',
    supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'low' }],
    irrelevant: 'discarded',
  }), { id: 'fixture', label: 'Fixture', efforts: ['low'] })
})

test('rejects malformed discovery payloads', () => {
  for (const value of [null, {}, { id: 'fixture', displayName: 'Fixture', supportedReasoningEfforts: [null] }]) {
    assert.equal(normalizeCodexModel(value), null)
  }
})

const verified = {
  sandboxEnforced: true,
  approvalEnforced: true,
  sensitiveActionsEnforced: true,
  verifiedModes: ['read-only', 'ask-approval', 'workspace', 'full-access'],
} as const

test('permission preflight denies missing enforcement or an unverified mode', () => {
  assert.equal(canEnablePermission('read-only', null), false)
  assert.equal(canEnablePermission('read-only', { ...verified, verifiedModes: [] }), false)
  assert.equal(canEnablePermission('read-only', { ...verified, sandboxEnforced: false }), false)
  assert.equal(canEnablePermission('ask-approval', { ...verified, approvalEnforced: false }), false)
  assert.equal(canEnablePermission('workspace', { ...verified, approvalEnforced: false }), false)
  assert.equal(canEnablePermission('read-only', verified), true)
})

test('full access requires opt-in and separate sensitive-action enforcement', () => {
  assert.equal(canEnablePermission('full-access', verified), false)
  assert.equal(canEnablePermission('full-access', { ...verified, sensitiveActionsEnforced: false }, true), false)
  assert.equal(canEnablePermission('full-access', verified, true), true)
})
