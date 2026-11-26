import assert from 'node:assert/strict'
import test from 'node:test'
import { AnthropicClaudeApiAdapter } from '../packages/runtime-adapters/claude/anthropic-claude-api.ts'
import { GoogleGeminiApiAdapter } from '../packages/runtime-adapters/gemini/google-gemini-api.ts'
import type { AgentEvent } from '@ghost-bot/shared-types/runtime'

test('Shared provider security: stalled stream cancellation and proactive abort on credential rotation', async () => {
  const claude = new AnthropicClaudeApiAdapter({
    resolveApiKey: () => 'sk-ant-api03-test-1234',
    isExecutionAuthorized: () => true,
    getCredentialGeneration: () => 1,
    transport: async () => {
      // Stream that never pushes chunks and never listens to abort signal (stalled stream)
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Stalled"}}\n\n',
            ),
          )
        },
      })
      return new Response(stream, { status: 200 })
    },
  })

  const cSess = await claude.createSession({
    agentId: 'b1',
    accountId: 'default',
    modelId: 'claude-sonnet-5-5',
    permission: 'read-only',
    workspace: '/tmp',
    instructions: '',
  })
  const cEvents: AgentEvent[] = []
  for await (const e of claude.run({ runId: 'c-stall', session: cSess, text: 'hi' })) {
    cEvents.push(e)
    if (e.type === 'message.delta') {
      await claude.cancel('c-stall')
    }
  }
  assert.equal(cEvents.at(-1)?.type, 'run.cancelled')

  const gemini = new GoogleGeminiApiAdapter({
    resolveApiKey: () => 'AIzaSyTest1234567890',
    isExecutionAuthorized: () => true,
    getCredentialGeneration: () => 1,
    getAccountRef: () => 'default',
    transport: async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"candidates":[{"content":{"parts":[{"text":"Stalled"}]}}]}\n\n',
            ),
          )
        },
      })
      return new Response(stream, { status: 200 })
    },
  })

  const gSess = await gemini.createSession({
    agentId: 'b2',
    accountId: 'default',
    modelId: 'gemini-2.5-flash',
    permission: 'read-only',
    workspace: '/tmp',
    instructions: '',
  })
  const gEvents: AgentEvent[] = []
  for await (const e of gemini.run({ runId: 'g-stall', session: gSess, text: 'hi' })) {
    gEvents.push(e)
    if (e.type === 'message.delta') {
      gemini.abortActiveRuns()
    }
  }
  assert.equal(gEvents.at(-1)?.type, 'run.cancelled')
})
