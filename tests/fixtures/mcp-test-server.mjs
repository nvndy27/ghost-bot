import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const counterIdx = process.argv.indexOf('--counter')
const COUNTER_FILE = counterIdx >= 0 ? process.argv[counterIdx + 1] : null

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`)
}

rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let req
  try {
    req = JSON.parse(trimmed)
  } catch {
    return
  }
  if (!req || typeof req !== 'object' || req.id === undefined) {
    return
  }

  const { id, method, params } = req
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2025-11-25',
        capabilities: {
          tools: { listChanged: false },
          resources: { listChanged: false },
          prompts: { listChanged: false },
        },
        serverInfo: {
          name: 'ghost-bot-mcp-test-fixture',
          version: '1.0.0',
        },
      },
    })
    return
  }

  if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} })
    return
  }

  if (method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        tools: [
          {
            name: 'echo_tool',
            description: 'Echoes text back with optional secret env check',
            inputSchema: {
              type: 'object',
              properties: {
                text: { type: 'string' },
              },
              required: ['text'],
              additionalProperties: false,
            },
          },
          {
            name: 'slow_tool',
            description: 'Waits before responding for timeout/responsiveness tests',
            inputSchema: {
              type: 'object',
              properties: {
                delayMs: { type: 'number' },
              },
              required: ['delayMs'],
              additionalProperties: false,
            },
          },
          {
            name: 'error_tool',
            description: 'Returns a tool error result',
            inputSchema: {
              type: 'object',
              properties: {
                message: { type: 'string' },
              },
              additionalProperties: false,
            },
          },
        ],
      },
    })
    return
  }

  if (method === 'tools/call') {
    const name = params?.name
    const args = params?.arguments ?? {}
    if (COUNTER_FILE) {
      appendFileSync(COUNTER_FILE, `${String(name)}\n`, 'utf8')
    }
    if (name === 'echo_tool') {
      const secretSuffix = process.env.TEST_SECRET ? ` [secret:${process.env.TEST_SECRET}]` : ''
      send({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: `echo:${String(args.text ?? '')}${secretSuffix}` }],
          isError: false,
        },
      })
      return
    }
    if (name === 'slow_tool') {
      const delayMs = Math.min(Number(args.delayMs ?? 100), 10_000)
      setTimeout(() => {
        send({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: `slow_done:${delayMs}` }],
            isError: false,
          },
        })
      }, delayMs)
      return
    }
    if (name === 'error_tool') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: `tool_err:${String(args.message ?? 'boom')}` }],
          isError: true,
        },
      })
      return
    }
    send({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Unknown tool: ${String(name)}` },
    })
    return
  }

  if (method === 'resources/list') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        resources: [
          {
            uri: 'ghost://fixture/info',
            name: 'Fixture Info',
            description: 'Read-only fixture metadata',
            mimeType: 'text/plain',
          },
        ],
      },
    })
    return
  }

  if (method === 'resources/read') {
    const uri = params?.uri
    if (uri === 'ghost://fixture/info') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          contents: [
            {
              uri: 'ghost://fixture/info',
              mimeType: 'text/plain',
              text: 'fixture-resource-content-v1',
            },
          ],
        },
      })
      return
    }
    send({
      jsonrpc: '2.0',
      id,
      error: { code: -32602, message: `Unknown resource: ${String(uri)}` },
    })
    return
  }

  if (method === 'prompts/list') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        prompts: [
          {
            name: 'greeting',
            description: 'Returns a fixture greeting prompt',
            arguments: [{ name: 'target', description: 'Who to greet', required: false }],
          },
        ],
      },
    })
    return
  }

  if (method === 'prompts/get') {
    const name = params?.name
    if (name === 'greeting') {
      const target = params?.arguments?.target ?? 'world'
      send({
        jsonrpc: '2.0',
        id,
        result: {
          description: 'Fixture greeting',
          messages: [
            {
              role: 'user',
              content: { type: 'text', text: `Hello, ${String(target)}!` },
            },
          ],
        },
      })
      return
    }
    send({
      jsonrpc: '2.0',
      id,
      error: { code: -32602, message: `Unknown prompt: ${String(name)}` },
    })
    return
  }

  send({
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `Unsupported method: ${String(method)}` },
  })
})
