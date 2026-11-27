import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createTurnBudgetTracker,
  extractAssistantTextForRun,
  runAlpha0LiveAcceptance,
} from '../scripts/verify-alpha0-live-codex.mjs'

function createSyntheticHarnessDeps(scenario: {
  delayRunCreationPolls?: number
  delayStopMountCalls?: number
  prompt1AssistantText?: string
  prompt2FinalStatus?: 'completed' | 'cancelled'
  prompt3FinalStatus?: 'completed' | 'interrupted'
  prompt3AssistantText?: string
  restartDropsThread?: boolean
}) {
  const operations: string[] = []
  let launchCount = 0
  let promptIndex = 0
  const sessionId = 'sess_synth_1'
  let externalSessionId: string | null = null
  const accountId = 'chatgpt:plus'
  const runs = new Map<string, { id: string; status: string; permission_mode: string }>()
  const messages: Array<{ id: string; role: string; text: string; runId: string }> = []
  const runEvents = new Map<string, Array<{ type: string; payload: unknown }>>()
  const emittedEvidence: Array<Record<string, unknown>> = []
  const deletedDirs: string[] = []
  const createdFiles = new Map<string, string>()

  const fsApi = {
    async mkdtemp(prefix: string) {
      return `${prefix}synth-${Math.random().toString(36).slice(2, 7)}`
    },
    async writeFile(p: string, data: string) {
      createdFiles.set(p, data)
    },
    async readdir() {
      return ['sentinel.txt']
    },
    async readFile(p: string) {
      return createdFiles.get(p) ?? ''
    },
    async rm(p: string) {
      operations.push(`rm:${p}`)
      deletedDirs.push(p)
    },
  }

  const openDb = () => ({
    prepare(sql: string) {
      return {
        get() {
          if (sql.includes('FROM sessions')) {
            return { external_session_id: externalSessionId, account_id: accountId, runtime_id: 'codex' }
          }
          return undefined
        },
        all() {
          if (sql.includes('FROM runs')) {
            return Array.from(runs.values())
          }
          return []
        },
      }
    },
    close() {},
  })

  const launchDesktop = async () => {
    launchCount += 1
    const currentLaunch = launchCount
    let listMessagesPollCount = 0
    let stopCheckCount = 0
    let pendingPromptRunId: string | null = null

    const page = {
      async waitForSelector(selector: string) {
        if (selector.includes('Stop generation')) {
          const needed = scenario.delayStopMountCalls ?? 0
          stopCheckCount += 1
          if (stopCheckCount <= needed) {
            await new Promise((r) => setTimeout(r, 15))
          }
          if (scenario.prompt2FinalStatus === 'completed') {
            throw new Error('Timeout waiting for Stop generation')
          }
        }
      },
      locator() {
        return {
          async isVisible() {
            return scenario.prompt2FinalStatus !== 'completed'
          },
          async click() {
            if (pendingPromptRunId) {
              const r = runs.get(pendingPromptRunId)
              if (r && r.status === 'running') {
                r.status = 'cancelled'
              }
            }
          },
        }
      },
      getByLabel() {
        return {
          async fill() {},
        }
      },
      getByRole() {
        return {
          async click() {
            promptIndex += 1
            const idx = promptIndex
            const runId = `run_synth_${idx}`
            pendingPromptRunId = runId
            listMessagesPollCount = 0

            const finalStatus =
              idx === 1
                ? 'completed'
                : idx === 2
                  ? (scenario.prompt2FinalStatus ?? 'cancelled')
                  : (scenario.prompt3FinalStatus ?? 'completed')

            runs.set(runId, {
              id: runId,
              status: idx === 2 && finalStatus === 'cancelled' ? 'running' : finalStatus,
              permission_mode: 'read-only',
            })

            const userText =
              idx === 1
                ? 'Reply with exactly ALPHA0_OK.'
                : idx === 2
                  ? 'Write 40 primes.'
                  : 'Repeat token.'
            const assistantText =
              idx === 1
                ? (scenario.prompt1AssistantText ?? 'ALPHA0_OK')
                : idx === 2
                  ? 'Partial prime 2'
                  : (scenario.prompt3AssistantText ?? 'ALPHA0_OK')

            if (idx === 1) {
              externalSessionId = 'thr_synth_123'
            }

            const delayPolls = scenario.delayRunCreationPolls ?? 0
            setTimeout(() => {
              messages.push({ id: `m_u_${idx}`, role: 'user', text: userText, runId })
              messages.push({ id: `m_a_${idx}`, role: 'assistant', text: assistantText, runId })
              runEvents.set(runId, [
                { type: 'usage.updated', payload: { inputTokens: 10, outputTokens: 5, isMock: false } },
              ])
            }, delayPolls * 10)
          },
        }
      },
      async reload() {},
      async evaluate(fn: (...args: unknown[]) => unknown, arg?: unknown) {
        const src = fn.toString()
        if (src.includes('getRuntimeSnapshot')) {
          return {
            status: 'available',
            authMethod: 'chatgpt',
            codexVersion: '0.172.0',
            models: [{ id: 'gpt-5-codex', efforts: ['medium'] }],
            usageStatus: 'available',
            usageWindows: [{ label: '5h', usedPercent: 1, resetAt: null }],
          }
        }
        if (src.includes('listBots')) {
          return { bots: [{ id: 'bot-chief' }] }
        }
        if (src.includes('updateBot')) {
          return { id: 'bot-chief' }
        }
        if (src.includes('createSession')) {
          return { id: sessionId }
        }
        if (src.includes('listMessages')) {
          listMessagesPollCount += 1
          if (listMessagesPollCount <= (scenario.delayRunCreationPolls ?? 0)) {
            return { messages: messages.slice(0, Math.max(0, messages.length - 2)) }
          }
          return { messages }
        }
        if (src.includes('getRunEvents')) {
          return { events: runEvents.get(String(arg)) ?? [] }
        }
        if (src.includes('getRun')) {
          return runs.get(String(arg)) ?? null
        }
        if (src.includes('inspectSession')) {
          return {
            sessionId,
            externalSessionId:
              currentLaunch === 2 && scenario.restartDropsThread ? 'thr_different' : externalSessionId,
            accountId,
          }
        }
        return null
      },
    }

    return {
      async firstWindow() {
        return page
      },
      async close() {},
    }
  }

  return {
    deps: {
      env: { GHOST_BOT_RUN_LIVE_CODEX: '1' },
      pollIntervalMs: 5,
      runDetectTimeoutMs: 1000,
      runTerminalTimeoutMs: 1000,
      stopMountTimeoutMs: 100,
      fsApi,
      openDb,
      launchDesktop,
      emitLog(payload: Record<string, unknown>) {
        operations.push('emitLog')
        emittedEvidence.push(payload)
      },
    },
    emittedEvidence,
    deletedDirs,
    operations,
  }
}

test('Alpha.0 harness enforces opt-in guard and 3-prompt maximum budget', async () => {
  let launched = false
  const skipped = await runAlpha0LiveAcceptance({
    env: {},
    launchDesktop: async () => {
      launched = true
      throw new Error('Should not launch')
    },
  })
  assert.equal(skipped.skipped, true)
  assert.equal(launched, false)

  const budget = createTurnBudgetTracker(3)
  assert.equal(budget.consume('t1'), 1)
  assert.equal(budget.consume('t2'), 2)
  assert.equal(budget.consume('t3'), 3)
  assert.throws(() => budget.consume('t4'), /Budget exceeded \(3\)/)
})

test('Alpha.0 harness succeeds with delayed run creation, delayed stop mount, fast completion, cancellation, and restart thread continuity', async () => {
  const { deps, emittedEvidence, deletedDirs } = createSyntheticHarnessDeps({
    delayRunCreationPolls: 2,
    delayStopMountCalls: 1,
    prompt2FinalStatus: 'cancelled',
    prompt3FinalStatus: 'completed',
  })

  const result = await runAlpha0LiveAcceptance(deps)
  assert.equal(result.alpha0LiveAcceptance, 'passed')
  assert.equal(result.attemptedTurns, 3)
  assert.equal(result.runs.length, 3)
  assert.equal(result.runs[0].status, 'completed')
  assert.equal(result.runs[1].status, 'cancelled')
  assert.equal(result.runs[2].status, 'completed')
  assert.equal(emittedEvidence.length, 1)
  assert.equal(deletedDirs.length, 2)
})

test('Alpha.0 harness rejects cancellation-before-stop, interrupted restart, and user-prompt text spoofing while preserving sanitized evidence before cleanup', async () => {
  // 1. Prompt 2 completes before cancellation -> must fail as cancellation not verified
  const cancelFail = createSyntheticHarnessDeps({
    prompt2FinalStatus: 'completed',
  })
  await assert.rejects(() => runAlpha0LiveAcceptance(cancelFail.deps), /Cancellation not verified/i)
  assert.equal(cancelFail.emittedEvidence.length, 1)
  assert.equal(cancelFail.emittedEvidence[0].alpha0LiveAcceptance, 'failed')
  assert.equal(cancelFail.emittedEvidence[0].attemptedTurns, 2)
  assert.equal(cancelFail.operations.indexOf('emitLog') < cancelFail.operations.findIndex((o) => o.startsWith('rm:')), true)

  // 2. Prompt 3 interrupted on restart -> must fail & emit evidence before cleanup
  const restartFail = createSyntheticHarnessDeps({
    prompt2FinalStatus: 'cancelled',
    prompt3FinalStatus: 'interrupted',
  })
  await assert.rejects(() => runAlpha0LiveAcceptance(restartFail.deps), /Prompt 3 expected completed, got interrupted/)
  assert.equal(restartFail.emittedEvidence.length, 1)
  assert.equal(restartFail.emittedEvidence[0].attemptedTurns, 3)

  // 3. Prompt 1 assistant text does not contain ALPHA0_OK (even though user prompt does) -> must fail
  const spoofFail = createSyntheticHarnessDeps({
    prompt1AssistantText: 'I cannot comply',
  })
  await assert.rejects(() => runAlpha0LiveAcceptance(spoofFail.deps), /Prompt 1 assistant message must contain ALPHA0_OK/)
  assert.equal(extractAssistantTextForRun([{ role: 'user', text: 'ALPHA0_OK', runId: 'r1' }], 'r1'), '')
})
