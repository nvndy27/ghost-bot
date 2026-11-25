import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { normalizeCodexModel } from '../packages/shared-types/discovery.ts'

const directory = await mkdtemp(join(tmpdir(), 'ghost-bot-codex-'))
const child = spawn('codex', ['app-server', '--listen', 'stdio://'], {
  cwd: directory,
  env: { PATH: process.env.PATH, HOME: directory, CODEX_HOME: directory },
  stdio: ['pipe', 'pipe', 'ignore'],
})
const closed = once(child, 'close').catch(() => null)
const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
const timeout = setTimeout(() => child.kill('SIGKILL'), 15_000)
child.stdin.on('error', () => child.kill('SIGKILL'))
let id = 0

async function request(method, params) {
  const requestId = ++id
  child.stdin.write(JSON.stringify({ id: requestId, method, params }) + '\n')
  for (let entry = await lines.next(); !entry.done; entry = await lines.next()) {
    const message = JSON.parse(entry.value)
    if (message.id !== requestId || message.method) continue
    if (message.error) throw new Error(method + ' failed with RPC code ' + Number(message.error.code))
    if (!message.result || typeof message.result !== 'object') break
    return message.result
  }
  throw new Error(method + ' did not return a valid result')
}

try {
  const server = await request('initialize', {
    clientInfo: { name: 'ghost-bot', version: '0.0.0' },
  })
  child.stdin.write('{"method":"initialized"}\n')
  if (typeof server.userAgent !== "string") throw new Error("Invalid initialize result")
  const account = await request('account/read', { refreshToken: false })
  const models = await request('model/list', { includeHidden: false, limit: 100 })
  if (typeof account.requiresOpenaiAuth !== 'boolean' || !Array.isArray(models.data)) {
    throw new Error('Unexpected account or model response')
  }
  const discovered = models.data.map(normalizeCodexModel)
  if (discovered.some((model) => model === null)) throw new Error("Invalid model catalog entry")
  console.log(JSON.stringify({
    initialized: true,
    accountPresent: account.account != null,
    requiresOpenaiAuth: account.requiresOpenaiAuth,
    modelCount: models.data.length,
    effortOptionCount: discovered.reduce((sum, model) => sum + model.efforts.length, 0),
    hasNextPage: Boolean(models.nextCursor),
  }))
} catch {
  console.error('Codex probe failed. Check the CLI and installed App Server protocol version.')
  process.exitCode = 1
} finally {
  child.kill('SIGKILL')
  await closed
  clearTimeout(timeout)
  await rm(directory, { recursive: true, force: true })
}
