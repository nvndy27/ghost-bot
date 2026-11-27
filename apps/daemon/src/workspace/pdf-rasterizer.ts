import { spawn } from 'node:child_process'
import { DaemonError } from '../errors.ts'
import { isBoundedRaster } from './raster-bounds.ts'
import { PDF_PREVIEW_LIMITS as limits } from './discovery-contracts.ts'

const sandbox = '/usr/bin/bwrap'
const prlimit = '/usr/bin/prlimit'

function isolatedPoppler(
  binary: '/usr/bin/pdfinfo' | '/usr/bin/pdftoppm',
  args: string[],
  input: Buffer,
  maxOutput: number,
  signal: AbortSignal,
): Promise<Buffer> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn(sandbox, [
      '--unshare-all', '--unshare-user', '--unshare-net', '--disable-userns', '--assert-userns-disabled',
      '--die-with-parent', '--new-session', '--cap-drop', 'ALL', '--clearenv',
      '--ro-bind-try', '/usr/lib', '/usr/lib', '--ro-bind-try', '/usr/lib64', '/usr/lib64',
      '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
      '--ro-bind', prlimit, prlimit, '--ro-bind', binary, binary,
      '--ro-bind-try', '/usr/share/poppler', '/usr/share/poppler',
      '--ro-bind-try', '/usr/share/fonts', '/usr/share/fonts',
      '--ro-bind-try', '/etc/fonts', '/etc/fonts',
      '--dev', '/dev', '--size', '1048576', '--tmpfs', '/tmp',
      '--setenv', 'LC_ALL', 'C', '--setenv', 'HOME', '/tmp', '--setenv', 'TMPDIR', '/tmp',
      '--chdir', '/tmp',
      '--', prlimit, '--as=536870912', '--cpu=2', '--fsize=1048576',
      '--nofile=64', '--core=0', '--', binary, ...args,
    ], { env: {}, stdio: ['pipe', 'pipe', 'ignore'] })

    const chunks: Buffer[] = []
    let total = 0
    let overflow = false
    const abort = () => { child.kill('SIGKILL') }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    child.stdin.on('error', () => { /* Poppler can reject input before consuming it. */ })
    child.stdout.on('data', (chunk: Buffer) => {
      if (overflow) return
      total += chunk.length
      if (total > maxOutput) {
        overflow = true
        abort()
      } else {
        chunks.push(chunk)
      }
    })
    let spawnFailed = false
    child.once('error', () => { spawnFailed = true })
    child.once('close', (code) => {
      signal.removeEventListener('abort', abort)
      if (signal.aborted) reject(signal.reason)
      else if (overflow) reject(new DaemonError('PDF_OUTPUT_LIMIT', 'PDF preview exceeded its output limit', { statusCode: 413 }))
      else if (spawnFailed || code !== 0) reject(new DaemonError(
        'PDF_PREVIEW_UNAVAILABLE',
        'Isolated PDF preview is unavailable or the PDF could not be decoded',
        { statusCode: 503 },
      ))
      else resolve(Buffer.concat(chunks, total))
    })
    child.stdin.end(input)
  })
}

// Keep the slot occupied until Bubblewrap and its pipes have closed, including on cancellation.
let pdfActive = false

export async function rasterizePdfPage(input: Buffer, page: number, signal?: AbortSignal) {
  signal?.throwIfAborted()
  if (process.platform !== 'linux' || process.getuid?.() === 0) {
    throw new DaemonError('PDF_PREVIEW_UNAVAILABLE', 'PDF preview requires a non-root Linux sandbox', { statusCode: 503 })
  }
  if (input.length > limits.maxInputBytes || !input.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
    throw new DaemonError('INVALID_PDF', 'PDF header or input size is invalid', { statusCode: 415 })
  }
  if (!Number.isInteger(page) || page < 1 || page > limits.maxPages) {
    throw new DaemonError('PDF_PAGE_LIMIT', 'Requested page is outside the preview limit', { statusCode: 400 })
  }
  if (pdfActive) throw new DaemonError('PDF_PREVIEW_BUSY', 'Another PDF preview is active', { statusCode: 429 })

  const deadline = AbortSignal.timeout(limits.maxMs)
  const stop = signal ? AbortSignal.any([signal, deadline]) : deadline
  pdfActive = true
  try {
    const info = await isolatedPoppler('/usr/bin/pdfinfo', ['-enc', 'UTF-8', '-'], input, 16_384, stop)
    const pageCount = Number(/^Pages:\s*([0-9]+)\s*$/m.exec(info.toString('utf8'))?.[1])
    if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > limits.maxPages || page > pageCount) {
      throw new DaemonError('PDF_PAGE_LIMIT', 'PDF page count or requested page exceeds the preview limit', { statusCode: 422 })
    }
    const png = await isolatedPoppler('/usr/bin/pdftoppm', [
      '-f', String(page), '-l', String(page), '-singlefile', '-scale-to', String(limits.maxDimension),
      '-hide-annotations', '-png', '-',
    ], input, limits.maxOutputBytes, stop)

    if (!isBoundedRaster(png, 'image/png', limits.maxDimension)) {
      throw new DaemonError('INVALID_PDF_RASTER', 'PDF preview returned an invalid raster', { statusCode: 502 })
    }
    return { page, pageCount, base64: png.toString('base64') }
  } catch (err) {
    if (deadline.aborted && !signal?.aborted) {
      throw new DaemonError('PDF_PREVIEW_TIMEOUT', 'PDF preview exceeded its time limit', { statusCode: 504 })
    }
    throw err
  } finally {
    pdfActive = false
  }
}
