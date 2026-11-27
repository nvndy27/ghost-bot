#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const [artifact] = process.argv.slice(2)
if (!artifact || process.argv.length !== 3 || process.platform !== 'linux' || process.getuid() === 0) {
  console.error('Usage for a normal Linux user: node scripts/verify-alpha3-workspace.mjs <AppImage or packaged Electron executable>')
  process.exit(2)
}
const executable = resolve(artifact)
await access(executable, constants.X_OK)
const repo = fileURLToPath(new URL('../', import.meta.url))
const prerequisites = [
  ['/usr/bin/git', '--version'],
  ['/usr/bin/bwrap', '--version'],
  ['/usr/bin/pdfinfo', '-v'],
  ['/usr/bin/pdftoppm', '-v'],
  ['/usr/bin/prlimit', '--version'],
]
for (const [path, arg] of prerequisites) {
  execFileSync(path, [arg], { stdio: 'inherit', timeout: 5000, env: { LC_ALL: 'C' } })
}

const hash = createHash('sha256').update(await readFile(executable)).digest('hex')
console.log(JSON.stringify({ artifact: executable, sha256: hash, runtime: 'offline mock' }))
const isolatedHome = await mkdtemp(join(tmpdir(), 'ghost-alpha3-home-'))
try {
  const report = spawnSync(process.execPath, [
    '--test', '--test-timeout=120000', '--test-concurrency=1', '--test-reporter=tap',
    '--test-name-pattern=Electron',
    'tests/alpha2a-workspace-panel-shell.test.ts',
    'tests/alpha2c2-safe-file-operations.test.ts',
    'tests/alpha2cd-discovery-electron.test.ts',
    'tests/alpha2d1-git-changes.test.ts',
    'tests/alpha2e1-workspace-browser.test.ts',
    'tests/alpha2f-execution-output.test.ts',
  ], {
    cwd: repo,
    env: {
      PATH: '/usr/bin:/bin',
      HOME: isolatedHome,
      XDG_CONFIG_HOME: join(isolatedHome, 'config'),
      XDG_DATA_HOME: join(isolatedHome, 'data'),
      XDG_CACHE_HOME: join(isolatedHome, 'cache'),
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
      DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
      DISPLAY: process.env.DISPLAY,
      WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY,
      XAUTHORITY: process.env.XAUTHORITY,
      LANG: process.env.LANG,
      GHOST_BOT_WORKSPACE_TEST_BINARY: executable,
      GHOST_BOT_REQUIRE_GIT_SANDBOX: '1',
      GHOST_BOT_REQUIRE_PDF_SANDBOX: '1',
    },
    stdio: 'inherit',
    timeout: 10 * 60_000,
  })
  if (report.error) throw report.error
  process.exitCode = report.status ?? 1
} finally {
  await rm(isolatedHome, { recursive: true, force: true })
}
