import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const desktopDir = resolve(import.meta.dirname, '..')
const unpackedDir = join(desktopDir, 'release', 'linux-unpacked')
const iconPath = join(desktopDir, 'build', 'icon.svg')
const outRpmPath = join(desktopDir, 'release', 'ghost-bot-0.1.0-1.x86_64.rpm')

const topdir = await mkdtemp(join(tmpdir(), 'ghost-bot-rpmbuild-'))
try {
  for (const sub of ['BUILD', 'RPMS', 'SOURCES', 'SPECS', 'SRPMS', 'BUILDROOT']) {
    await mkdir(join(topdir, sub), { recursive: true })
  }

  const stageDir = join(topdir, 'SOURCES', 'payload')
  await mkdir(join(stageDir, 'opt', 'GhostBot'), { recursive: true })
  await mkdir(join(stageDir, 'usr', 'bin'), { recursive: true })
  await mkdir(join(stageDir, 'usr', 'share', 'applications'), { recursive: true })
  await mkdir(join(stageDir, 'usr', 'share', 'icons', 'hicolor', 'scalable', 'apps'), {
    recursive: true,
  })

  await cp(unpackedDir, join(stageDir, 'opt', 'GhostBot'), { recursive: true })
  await cp(
    iconPath,
    join(stageDir, 'usr', 'share', 'icons', 'hicolor', 'scalable', 'apps', 'ghost-bot.svg'),
  )
  await writeFile(
    join(stageDir, 'usr', 'bin', 'ghost-bot'),
    '#!/usr/bin/sh\nexec /opt/GhostBot/@ghost-botdesktop "$@"\n',
    { mode: 0o755 },
  )
  await writeFile(
    join(stageDir, 'usr', 'share', 'applications', 'ghost-bot.desktop'),
    [
      '[Desktop Entry]',
      'Name=Ghost Bot',
      'Comment=Local-first multi-agent AI desktop workspace',
      'Exec=/usr/bin/ghost-bot %U',
      'Terminal=false',
      'Type=Application',
      'Icon=ghost-bot',
      'Categories=Development;Utility;',
      'StartupWMClass=Ghost Bot',
      '',
    ].join('\n'),
    'utf8',
  )

  const specPath = join(topdir, 'SPECS', 'ghost-bot.spec')
  const spec = [
    '%global _binary_payload w2.xzdio',
    '%global debug_package %{nil}',
    '%global __strip /bin/true',
    '%global __objdump /bin/true',
    'AutoReqProv: no',
    'Name: ghost-bot',
    'Version: 0.1.0',
    'Release: 1',
    'Summary: Ghost Bot local-first multi-agent desktop workspace',
    'License: Proprietary',
    'BuildArch: x86_64',
    'Requires: gtk3, nss, alsa-lib, libXScrnSaver, libXtst',
    '',
    '%description',
    'Ghost Bot is a local-first multi-agent AI desktop workspace.',
    '',
    '%install',
    'rm -rf %{buildroot}',
    `cp -a "${stageDir}/." %{buildroot}/`,
    '',
    '%files',
    '%defattr(-,root,root,-)',
    '/opt/GhostBot',
    '/usr/bin/ghost-bot',
    '/usr/share/applications/ghost-bot.desktop',
    '/usr/share/icons/hicolor/scalable/apps/ghost-bot.svg',
    '',
  ].join('\n')
  await writeFile(specPath, spec, 'utf8')

  await execFileAsync('rpmbuild', ['-bb', '--define', `_topdir ${topdir}`, specPath], {
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
  })

  const builtRpm = join(topdir, 'RPMS', 'x86_64', 'ghost-bot-0.1.0-1.x86_64.rpm')
  await cp(builtRpm, outRpmPath)
  process.stdout.write(`Built native RPM: ${outRpmPath}\n`)
} finally {
  await rm(topdir, { recursive: true, force: true })
}
