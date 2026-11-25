import { spawnSync } from 'node:child_process'

const result = spawnSync('openclaw', [
  'gateway', 'call', 'health', '--expect-url', 'ws://127.0.0.1:18789',
  '--timeout', '5000', '--json',
], { encoding: 'utf8', timeout: 15_000 })

if (result.status !== 0) {
  console.error('OpenClaw health RPC failed. Check CLI availability, local gateway URL, and configured auth.')
  process.exitCode = 1
} else {
  try {
    const health = JSON.parse(result.stdout)
    if (typeof health?.ok !== 'boolean') throw new Error()
    console.log(JSON.stringify({ rpc: 'health', ok: health.ok }))
    if (!health.ok) process.exitCode = 1
  } catch {
    console.error('OpenClaw returned an unexpected health response.')
    process.exitCode = 1
  }
}
