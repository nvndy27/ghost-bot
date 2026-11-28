import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { WorkspaceOutputEntry } from '@ghost-bot/shared-types/ipc'
import {
  cancellationTargetKey,
  createWorkspaceOutputCancelInput,
  selectCancellationActionEntries,
} from '../apps/desktop/src/components/workspace/workspace-output-cancellation.ts'

function entry(overrides: Partial<WorkspaceOutputEntry> = {}): WorkspaceOutputEntry {
  return {
    id: 'event:run-1:1',
    runId: 'run-1',
    sessionId: 'session-1',
    taskId: null,
    source: 'run',
    severity: 'info',
    status: 'running',
    timestamp: '2026-11-28T00:00:00.000Z',
    title: 'Run event',
    message: 'Synthetic event',
    exitCode: null,
    durationMs: null,
    cancellable: true,
    ...overrides,
  }
}

test('taskless terminal/build entries expose no action and cannot form a run-cancel request', () => {
  for (const source of ['terminal', 'build'] as const) {
    for (const taskId of [null, ''] as const) {
      const commandEntry = entry({ source, taskId })
      assert.equal(cancellationTargetKey(commandEntry), null)
      assert.deepEqual(selectCancellationActionEntries([commandEntry], 'bot'), new Map())
      assert.equal(createWorkspaceOutputCancelInput(commandEntry, 'bot', 'bot-1'), null)
    }
  }
})

test('distinct valid terminal/build command IDs remain separate and dispatch their own IDs', () => {
  const terminal = entry({ id: 'term:cmd-1', source: 'terminal', taskId: 'cmd-1' })
  const build = entry({ id: 'build:cmd-2', source: 'build', taskId: 'cmd-2' })
  const actions = selectCancellationActionEntries([terminal, build], 'bot')

  assert.equal(actions.size, 2)
  assert.equal(actions.get(cancellationTargetKey(terminal)!), terminal.id)
  assert.equal(actions.get(cancellationTargetKey(build)!), build.id)
  assert.equal(
    createWorkspaceOutputCancelInput(terminal, 'bot', 'bot-1')?.terminalCommandId,
    'cmd-1',
  )
  assert.equal(
    createWorkspaceOutputCancelInput(build, 'bot', 'bot-1')?.terminalCommandId,
    'cmd-2',
  )
})

test('multiple events for one command expose one cancellation action', () => {
  const earlier = entry({ id: 'term:cmd-1:started', source: 'terminal', taskId: 'cmd-1' })
  const later = entry({ id: 'term:cmd-1:output', source: 'terminal', taskId: 'cmd-1' })
  const actions = selectCancellationActionEntries([earlier, later], 'bot')

  assert.equal(actions.size, 1)
  assert.equal(actions.get(cancellationTargetKey(earlier)!), earlier.id)
})

test('run summary is preferred, with filtered event fallback and team isolation', () => {
  const summary = entry({ id: 'run-summary:run-1', taskId: null, source: 'run' })
  const runEvent = entry({ id: 'event:run-1:1', taskId: null, source: 'tool' })
  const summaryTarget = cancellationTargetKey(summary)!
  assert.equal(selectCancellationActionEntries([runEvent, summary], 'bot').get(summaryTarget), summary.id)

  const filteredActions = selectCancellationActionEntries([runEvent], 'bot')
  assert.equal(filteredActions.get(cancellationTargetKey(runEvent)!), runEvent.id)
  assert.equal(
    createWorkspaceOutputCancelInput(runEvent, 'bot', 'bot-1')?.terminalCommandId,
    undefined,
  )

  assert.deepEqual(selectCancellationActionEntries([runEvent], 'team'), new Map())
  assert.equal(createWorkspaceOutputCancelInput(runEvent, 'team', 'bot-1'), null)
})
