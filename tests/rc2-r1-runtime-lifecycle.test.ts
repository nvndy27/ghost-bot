import assert from 'node:assert/strict'
import test from 'node:test'
import { RuntimeRegistry } from '../apps/daemon/src/runtime/registry.ts'
import type { CodexMetadataClient } from '../apps/daemon/src/runtime/registry.ts'

test('RuntimeRegistry stop reports failed Codex termination and retains owned client identity', async () => {
  let closeAttempts = 0
  const client: CodexMetadataClient = {
    async getAccountSummary() {
      return {
        accountPresent: true,
        accountType: 'chatgpt',
        email: null,
        planType: 'plus',
        workspaceName: null,
        requiresOpenaiAuth: true,
      }
    },
    async listModels() {
      return []
    },
    async getUsage() {
      return null
    },
    async close() {
      closeAttempts += 1
      if (closeAttempts === 1) throw new Error('injected process termination failure')
    },
  }
  const registry = new RuntimeRegistry({
    runtimeMode: 'codex',
    codexVersionOverride: '0.172.0',
    codexClientFactory: () => client,
  })

  await registry.getSnapshot(true)
  await registry.stop()
  assert.equal(closeAttempts, 1)
  assert.equal(registry.getLifecycleState(), 'failed')

  // A second explicit close must still address the same owned client, proving
  // the failed first attempt did not discard the handle or claim disconnection.
  await registry.closeOwnedClient()
  assert.equal(closeAttempts, 2)
  assert.equal(registry.getLifecycleState(), 'disconnected')
})
