#!/usr/bin/env node
import { access, readFile, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

const run = promisify(execFile)
const argv = process.argv.slice(2)
let rpmArtifact = null
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] !== '--rpm-artifact' || rpmArtifact || !argv[i + 1] || argv[i + 1].startsWith('--')) {
    console.error('Usage: node scripts/check-linux-release-prerequisites.mjs [--rpm-artifact <existing-rpm-file>]')
    process.exit(2)
  }
  rpmArtifact = resolve(argv[++i])
}
const pathList = (process.env.PATH ?? '').split(':').filter(Boolean)
async function executable(name) {
  for (const dir of pathList) {
    const path = `${dir}/${name}`
    try { await access(path, constants.X_OK); return path } catch {}
  }
  return null
}
async function checkCommand(name, args = ['--version']) {
  const path = await executable(name)
  if (!path) return { status: 'missing', action: `Provide ${name} on PATH on the acceptance host.` }
  try {
    const { stdout, stderr } = await run(path, args, { timeout: 5000, maxBuffer: 128 * 1024, env: { ...process.env, LC_ALL: 'C' } })
    return { status: 'available', path, output: `${stdout}${stderr}`.trim().split('\n').slice(0, 3).join('\n') }
  } catch (error) {
    return { status: 'present-but-failed', path, detail: String(error.stderr || error.message).trim().slice(0, 600) }
  }
}

let osRelease = ''
try { osRelease = await readFile('/etc/os-release', 'utf8') } catch {}
const osValue = (key) => new RegExp(`^${key}=(.*)$`, 'm').exec(osRelease)?.[1]?.replace(/^"|"$/g, '') ?? null
const id = osValue('ID')
const version = osValue('VERSION_ID')
const commandChecks = {}
for (const [name, argv] of [
  ['git', ['--version']], ['bwrap', ['--version']], ['prlimit', ['--version']],
  ['pdfinfo', ['-v']], ['pdftoppm', ['-v']], ['desktop-file-validate', ['--version']],
  ['rpm', ['--version']], ['dpkg-query', ['--version']],
]) commandChecks[name] = await checkCommand(name, argv)

const required = {}
for (const path of ['/usr/bin/git', '/usr/bin/bwrap', '/usr/bin/prlimit', '/usr/bin/pdfinfo', '/usr/bin/pdftoppm']) {
  try { await access(path, constants.X_OK); required[path] = { status: 'available' } }
  catch { required[path] = { status: 'missing', action: `Provide ${path} on the target host.` } }
}
let bubblewrapNamespace = { status: 'unavailable', action: 'Install/configure nothing through this checker; use a provisioned acceptance host and preserve the mandatory sandbox.' }
if (required['/usr/bin/bwrap'].status === 'available') {
  try {
    await run('/usr/bin/bwrap', ['--unshare-user', '--ro-bind', '/', '/', '--', '/usr/bin/true'], { timeout: 5000, maxBuffer: 32 * 1024, env: { ...process.env, LC_ALL: 'C' } })
    bubblewrapNamespace = { status: 'passed', detail: 'A read-only root namespace probe completed with an unprivileged user namespace.' }
  } catch (error) {
    bubblewrapNamespace = { status: 'failed', detail: String(error.stderr || error.message).trim().slice(0, 800), action: 'Check target distribution user-namespace policy, Bubblewrap ownership/mode, and AppArmor policy. Do not disable sandboxing.' }
  }
}

let fuseDevice = false
try { await access('/dev/fuse', constants.R_OK | constants.W_OK); fuseDevice = true } catch {}
const fuseMount = (await executable('fusermount3')) ?? (await executable('fusermount'))
const chromeCandidates = ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser']
let chrome = null
for (const name of chromeCandidates) { const found = await executable(name); if (found) { chrome = { name, path: found }; break } }
const chromeHelperCandidates = ['/opt/google/chrome/chrome-sandbox', '/usr/lib/chromium/chrome-sandbox', '/usr/lib/chromium-browser/chrome-sandbox']
let chromeHelper = { status: 'missing', action: 'Install the supported browser package on the acceptance host; do not use --no-sandbox.' }
for (const path of chromeHelperCandidates) {
  try {
    const info = await stat(path)
    chromeHelper = { status: info.uid === 0 && (info.mode & 0o4777) === 0o4755 ? 'valid-root-owned-suid' : 'invalid-mode-or-owner', path, uid: info.uid, mode: `0${(info.mode & 0o7777).toString(8)}`, action: 'Verify the browser package installation owns and configures its sandbox helper. Preserve Chromium sandboxing.' }
    break
  } catch {}
}

const rpmNames = ['gtk3', 'nss', 'alsa-lib', 'libXScrnSaver', 'libXtst']
let rpmDependencies = { status: 'not-applicable', note: 'Only assessed on Fedora/RPM hosts.' }
if (id === 'fedora' || id === 'rhel' || id === 'centos') {
  if (commandChecks.rpm.status === 'available') {
    try {
      const { stdout } = await run('rpm', ['-q', ...rpmNames], { timeout: 5000, maxBuffer: 32 * 1024 })
      rpmDependencies = { status: 'available', packages: stdout.trim().split('\n') }
    } catch (error) {
      rpmDependencies = { status: 'incomplete', detail: String(error.stdout || error.stderr || error.message).trim(), packages: rpmNames, action: 'Have the host administrator provision declared RPM runtime dependencies before acceptance.' }
    }
  } else rpmDependencies = { status: 'cannot-check', action: 'Run on the Fedora/RPM target with rpm-query available.' }
}

const launcherPaths = ['/usr/bin/ghost-bot', '/usr/share/applications/ghost-bot.desktop']
const launcher = {}
for (const path of launcherPaths) {
  try { await access(path); launcher[path] = { status: 'present', content: await readFile(path, 'utf8').catch(() => null) } }
  catch { launcher[path] = { status: 'not-installed', action: 'Install the candidate RPM on a disposable Fedora host, then inspect launcher Exec/Icon/StartupWMClass and run desktop-file-validate.' } }
}

let rpmArtifactInspection = null
if (rpmArtifact) {
  if (commandChecks.rpm.status !== 'available') {
    rpmArtifactInspection = { status: 'cannot-inspect', path: rpmArtifact, action: 'Use this optional inspection on a host with rpm available.' }
  } else {
    const artifactHash = createHash('sha256').update(await readFile(rpmArtifact)).digest('hex')
    const [requires, files] = await Promise.all([
      run('rpm', ['-qp', '--requires', rpmArtifact], { timeout: 5000, maxBuffer: 128 * 1024 }),
      run('rpm', ['-qpl', rpmArtifact], { timeout: 5000, maxBuffer: 512 * 1024 }),
    ])
    const fileList = files.stdout.split('\n').filter(Boolean)
    rpmArtifactInspection = {
      status: 'metadata-inspected-not-installed', path: rpmArtifact, sha256: artifactHash,
      requires: requires.stdout.split('\n').filter((value) => value && !value.startsWith('rpmlib(')),
      launcherFiles: fileList.filter((path) => ['/usr/bin/ghost-bot', '/usr/share/applications/ghost-bot.desktop', '/opt/GhostBot/@ghost-botdesktop'].includes(path)),
      action: 'Install on a disposable Fedora target and launch through the desktop entry to verify runtime behavior.',
    }
  }
}

const report = {
  timestamp: new Date().toISOString(), platform: process.platform, architecture: process.arch,
  distribution: { id, version, name: osValue('NAME') }, desktop: {
    sessionType: process.env.XDG_SESSION_TYPE ?? null,
    desktopNames: process.env.XDG_CURRENT_DESKTOP ?? null,
    displayAvailable: Boolean(process.env.DISPLAY), waylandAvailable: Boolean(process.env.WAYLAND_DISPLAY),
  },
  requiredHostTools: required,
  bubblewrapUserNamespaceProbe: bubblewrapNamespace,
  chromium: { browser: chrome ?? { status: 'missing', action: 'Install the supported Chrome/Chromium package on the target host.' }, sandboxHelper: chromeHelper },
  appImageFuse: {
    devFuseReadableWritable: fuseDevice,
    mountHelper: fuseMount,
    status: fuseDevice && fuseMount ? 'prerequisites-present-native-launch-unverified' : 'incomplete',
    action: 'Launch the exact AppImage natively on a disposable target profile. This check never mounts or changes the host.',
  },
  fedoraRpmDependencies: rpmDependencies,
  rpmArtifact: rpmArtifactInspection,
  fedoraDesktopLauncher: launcher,
  ubuntuDesktop: {
    status: id === 'ubuntu' ? 'ubuntu-host-detected' : 'not-ubuntu-host',
    action: 'On Ubuntu, repeat AppImage native-FUSE and extracted-run acceptance on claimed GNOME Wayland and X11 sessions. Confirm Bubblewrap user namespaces under the host AppArmor policy. Ubuntu-native packaging is not declared.',
  },
  constraints: ['Read-only inspection; no host package installation or downloads.', 'Chromium sandbox remains enabled.', 'Presence checks do not replace packaged application launch tests.'],
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
