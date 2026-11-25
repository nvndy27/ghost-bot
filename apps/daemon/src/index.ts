import { GhostBotDaemon } from './server.ts'

const authToken = process.env.GHOST_BOT_DAEMON_TOKEN ?? ''
const socketPath = process.env.GHOST_BOT_DAEMON_SOCKET || undefined
const portEnv = process.env.GHOST_BOT_DAEMON_PORT
const port = portEnv ? Number(portEnv) : undefined
const runtimeMode = process.env.GHOST_BOT_RUNTIME_MODE === 'mock' ? 'mock' : 'codex'

const daemon = new GhostBotDaemon({ authToken, socketPath, port, runtimeMode })

let shuttingDown = false
const shutdown = async () => {
  if (shuttingDown) return
  shuttingDown = true
  await daemon.stop()
  process.exit(0)
}

process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
process.stdin.on('end', () => void shutdown())
process.stdin.on('close', () => void shutdown())
process.stdin.resume()

const { address } = await daemon.start()
// Never log authToken; emit only listening address for parent process handshake.
console.log(JSON.stringify({ event: 'daemon.ready', address }))
