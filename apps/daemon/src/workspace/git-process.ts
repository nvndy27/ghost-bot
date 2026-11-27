import { spawn } from 'node:child_process'
import { DaemonError } from '../errors.ts'

const MAX_OUTPUT = 128 * 1024
const git = '/usr/bin/git'
const prlimit = '/usr/bin/prlimit'

export function runGit(snapshot: string, args: readonly string[], signal: AbortSignal) {
  signal.throwIfAborted()
  return new Promise<{ output: string; truncated: boolean }>((resolve, reject) => {
    const process = spawn('/usr/bin/bwrap', [
      '--unshare-all', '--unshare-user', '--unshare-net', '--disable-userns', '--assert-userns-disabled',
      '--die-with-parent', '--new-session', '--cap-drop', 'ALL', '--clearenv',
      '--ro-bind-try', '/usr/lib', '/usr/lib', '--ro-bind-try', '/usr/lib64', '/usr/lib64',
      '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
      '--ro-bind', git, git, '--ro-bind', prlimit, prlimit, '--dev', '/dev',
      '--ro-bind', snapshot, '/workspace', '--chdir', '/workspace',
      ...Object.entries({
        HOME: '/empty', XDG_CONFIG_HOME: '/empty', LC_ALL: 'C.UTF-8',
        GIT_DIR: '/workspace/.git', GIT_WORK_TREE: '/workspace',
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1',
        GIT_ATTR_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: '',
        GIT_EXEC_PATH: '/no-helpers',
      }).flatMap(([key, value]) => ['--setenv', key, value]),
      '--', prlimit, '--as=536870912', '--cpu=2', '--fsize=0', '--nofile=64', '--core=0', '--',
      git, '--no-pager', '--no-optional-locks', '--literal-pathspecs',
      '-c', 'core.hooksPath=/no-hooks', '-c', 'core.fsmonitor=false',
      '-c', 'core.attributesFile=/dev/null', '-c', 'protocol.allow=never',
      ...args,
    ], { env: {}, stdio: ['ignore', 'pipe', 'ignore'] })

    const chunks: Buffer[] = []
    let remaining = MAX_OUTPUT
    let truncated = false
    let spawnFailed = false
    const abort = () => { process.kill('SIGKILL') }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    process.stdout.on('data', (chunk: Buffer) => {
      if (truncated) return
      chunks.push(chunk.subarray(0, remaining))
      if (chunk.length > remaining) {
        truncated = true
        abort()
      }
      remaining -= chunk.length
    })
    process.once('error', () => { spawnFailed = true })
    process.once('close', (code) => {
      signal.removeEventListener('abort', abort)
      if (signal.aborted) reject(signal.reason)
      else if (!spawnFailed && (truncated || code === 0 || (code === 1 && args.includes('--no-index')))) {
        resolve({ output: Buffer.concat(chunks).toString('utf8'), truncated })
      } else {
        reject(new DaemonError('GIT_UNAVAILABLE', 'Git inspection needs a supported local repository and isolated Git runtime.', { statusCode: 503 }))
      }
    })
  })
}
