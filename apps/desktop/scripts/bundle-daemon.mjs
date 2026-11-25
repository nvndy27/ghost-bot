import { copyFile, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const requireFromVite = createRequire(import.meta.resolve('vite'))
const { build } = requireFromVite('esbuild')

const __dirname = dirname(fileURLToPath(import.meta.url))
const desktopDir = resolve(__dirname, '..')
const repoRoot = resolve(desktopDir, '..', '..')
const daemonOutDir = join(desktopDir, 'dist-daemon')
await mkdir(daemonOutDir, { recursive: true })

// Copy jsdom's xhr-sync-worker.js next to daemon.mjs so isomorphic-dompurify/jsdom resolves it at runtime.
const requireFromAvatar = createRequire(join(repoRoot, 'packages', 'avatar', 'svg-sanitizer.ts'))
const requireFromDompurify = createRequire(requireFromAvatar.resolve('isomorphic-dompurify'))
const jsdomPkgDir = dirname(requireFromDompurify.resolve('jsdom/package.json'))
await copyFile(
  join(jsdomPkgDir, 'lib', 'jsdom', 'living', 'xhr', 'xhr-sync-worker.js'),
  join(daemonOutDir, 'xhr-sync-worker.js'),
)

await build({
  entryPoints: [join(repoRoot, 'apps', 'daemon', 'src', 'index.ts')],
  outfile: join(daemonOutDir, 'daemon.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  external: ['node:*'],
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  sourcemap: false,
  minify: false,
})

// Bundle Electron main & preload so packaged app.asar does not import raw .ts from node_modules.
await build({
  entryPoints: [join(desktopDir, 'electron', 'main.ts')],
  outfile: join(desktopDir, 'dist-electron', 'main.js'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  external: ['electron', 'node:*'],
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  sourcemap: false,
  minify: false,
})

await build({
  entryPoints: [join(desktopDir, 'electron', 'preload.cts')],
  outfile: join(desktopDir, 'dist-electron', 'preload.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  external: ['electron', 'node:*'],
  sourcemap: false,
  minify: false,
})
