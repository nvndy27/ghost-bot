import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { WorkspaceFilesTransport } from '../apps/desktop/src/components/workspace/workspaceFilesClient.ts'
import { WorkspaceFilesStore } from '../apps/desktop/src/components/workspace/workspaceFilesStore.ts'

test('Workspace editor snapshots an in-flight save and rejects duplicate concurrent saves', async () => {
  const store = new WorkspaceFilesStore()
  const state = store.setContextResolution('bot:bot-1', {
    authorized: true,
    workspaceId: 'workspace-1',
    canonicalRoot: '/synthetic/workspace',
    ownerKind: 'bot',
    ownerId: 'bot-1',
    ownerName: 'Synthetic bot',
    canWrite: true,
    permissionMode: 'workspace',
    authGeneration: 'generation-1',
    reason: null,
  })
  assert.ok(state)

  store.openOrUpdateTab(state.storageKey, {
    relativePath: 'notes.txt',
    name: 'notes.txt',
    savedContent: 'original\n',
    draftContent: 'first draft\n',
    revision: 'revision-1',
    readOnly: false,
    language: 'text',
    saving: false,
    conflictMessage: null,
    errorMessage: null,
  })

  const requests: Array<{ content: string; expectedRevision: string }> = []
  let resolveFirst!: (result: {
    workspaceId: string
    relativePath: string
    revision: string
    sizeBytes: number
    savedAt: string
  }) => void
  const transport: WorkspaceFilesTransport = {
    resolveContext: async () => state.contextInfo,
    listDirectory: async () => { throw new Error('unused') },
    readFile: async () => { throw new Error('unused') },
    saveFile: (input) => {
      requests.push({ content: input.content, expectedRevision: input.expectedRevision })
      if (requests.length === 1) {
        return new Promise((resolve) => { resolveFirst = resolve })
      }
      return Promise.resolve({
        workspaceId: input.workspaceId,
        relativePath: input.relativePath,
        revision: 'revision-3',
        sizeBytes: input.content.length,
        savedAt: new Date().toISOString(),
      })
    },
  }

  const firstSave = store.saveTab(transport, { botId: 'bot-1' }, state.storageKey, 'notes.txt')
  store.updateWorkspace(state.storageKey, (current) => ({
    ...current,
    tabs: current.tabs.map((tab) => ({ ...tab, draftContent: 'second draft\n' })),
  }))

  await store.saveTab(transport, { botId: 'bot-1' }, state.storageKey, 'notes.txt')
  assert.equal(requests.length, 1, 'A second save cannot dispatch while the first is pending')

  resolveFirst({
    workspaceId: 'workspace-1',
    relativePath: 'notes.txt',
    revision: 'revision-2',
    sizeBytes: 'first draft\n'.length,
    savedAt: new Date().toISOString(),
  })
  await firstSave

  let current = store.getActiveWorkspaceState('bot:bot-1')?.tabs[0]
  assert.equal(current?.saving, false)
  assert.equal(current?.savedContent, 'first draft\n')
  assert.equal(current?.draftContent, 'second draft\n', 'Edits made during a save remain unsaved')
  assert.equal(current?.revision, 'revision-2')

  await store.saveTab(transport, { botId: 'bot-1' }, state.storageKey, 'notes.txt')
  assert.deepEqual(requests, [
    { content: 'first draft\n', expectedRevision: 'revision-1' },
    { content: 'second draft\n', expectedRevision: 'revision-2' },
  ])
  current = store.getActiveWorkspaceState('bot:bot-1')?.tabs[0]
  assert.equal(current?.savedContent, 'second draft\n')
  assert.equal(current?.draftContent, 'second draft\n')
  assert.equal(current?.revision, 'revision-3')
  assert.equal(current?.saving, false)
})
