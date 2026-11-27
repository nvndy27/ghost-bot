import { extname } from 'node:path'
import { DaemonError } from '../errors.ts'
import {
  assertValidUtf8Text,
  isBlockedBinaryExtension,
  listContainedDirectory,
  normalizeWorkspaceRelativePath,
  readContainedFileBytes,
  readContainedTextFile,
} from './containment.ts'
import { DISCOVERY_LIMITS, type WorkspacePreviewPayload, type WorkspaceSearchHit } from './discovery-contracts.ts'
import { rasterizePdfPage } from './pdf-rasterizer.ts'
import { isBoundedRaster } from './raster-bounds.ts'
import type { AuthorizedWorkspace } from './files-service.ts'

const SKIPPED_ENTRY_ERRORS = new Set([
  'INVALID_PATH', 'SENSITIVE_FILE_BLOCKED', 'SYMLINK_REJECTED', 'MOUNT_BOUNDARY_REJECTED',
  'FILE_NOT_FOUND', 'FILE_OPEN_FAILED', 'FILE_TOO_LARGE', 'UNSUPPORTED_BINARY_FILE',
  'PATH_NOT_FOUND', 'NOT_A_DIRECTORY', 'WORKSPACE_OPEN_FAILED', 'HARDLINK_REJECTED',
  'UNSUPPORTED_SPECIAL_FILE', 'NOT_A_FILE',
])

export async function searchAuthorizedWorkspace(
  workspace: AuthorizedWorkspace,
  mode: 'filename' | 'content',
  query: string,
  signal?: AbortSignal,
) {
  const { canonicalRoot, rootDev, rootIno } = workspace
  const limits = DISCOVERY_LIMITS
  const deadline = performance.now() + limits.maxSearchMs
  const needle = query.toLowerCase()
  const directories = [{ path: '', depth: 0 }]
  const results: WorkspaceSearchHit[] = []
  let scannedFiles = 0
  let scannedEntries = 0
  let truncated = false
  const shouldStop = () => {
    signal?.throwIfAborted()
    return performance.now() >= deadline
  }

  for (const { path, depth } of directories) {
    if (shouldStop() || scannedEntries >= limits.maxEntries || scannedFiles >= limits.maxFiles) {
      truncated = true
      break
    }

    let listing
    try {
      listing = await listContainedDirectory(canonicalRoot, rootDev, rootIno, path, {
        maxScan: limits.maxEntries - scannedEntries,
        shouldStop,
      })
    } catch (err) {
      if (path && err instanceof DaemonError && SKIPPED_ENTRY_ERRORS.has(err.code)) continue
      throw err
    }
    scannedEntries += listing.totalScanned
    truncated ||= listing.truncated

    for (const entry of listing.entries) {
      if (shouldStop() || scannedFiles >= limits.maxFiles || results.length >= limits.maxResults) {
        return { results, scannedFiles, truncated: true }
      }
      if (entry.relativePath.length > 512 || entry.relativePath.includes('\\')) {
        truncated = true
        continue
      }
      if (entry.kind === 'directory') {
        if (depth < limits.maxDepth && directories.length < limits.maxDirectories) {
          directories.push({ path: entry.relativePath, depth: depth + 1 })
        } else {
          truncated = true
        }
        continue
      }

      scannedFiles += 1
      if (mode === 'filename') {
        if (entry.name.toLowerCase().includes(needle)) {
          results.push({ relativePath: entry.relativePath, lineNumber: null, line: null })
        }
        continue
      }
      if (isBlockedBinaryExtension(entry.name)) continue
      if ((entry.sizeBytes ?? 0) > limits.maxTextBytes) {
        truncated = true
        continue
      }
      try {
        const { content } = await readContainedTextFile(
          canonicalRoot, rootDev, rootIno, entry.relativePath, limits.maxTextBytes,
        )
        const lines = content.split('\n')
        for (let index = 0; index < lines.length; index++) {
          if (shouldStop() || results.length >= limits.maxResults) {
            return { results, scannedFiles, truncated: true }
          }
          const line = lines[index].replace(/\r$/, '')
          const match = line.toLowerCase().indexOf(needle)
          if (match < 0) continue
          const start = Math.max(0, match - 80)
          results.push({
            relativePath: entry.relativePath,
            lineNumber: index + 1,
            line: line.slice(start, start + limits.maxLineLength),
          })
        }
      } catch (err) {
        if (!(err instanceof DaemonError) || !SKIPPED_ENTRY_ERRORS.has(err.code)) throw err
        truncated ||= err.code === 'FILE_TOO_LARGE'
      }
    }
  }

  signal?.throwIfAborted()
  return { results, scannedFiles, truncated }
}

export async function previewAuthorizedWorkspaceFile(
  workspace: AuthorizedWorkspace,
  relativePath: string,
  page: number,
  signal?: AbortSignal,
): Promise<WorkspacePreviewPayload> {
  signal?.throwIfAborted()
  normalizeWorkspaceRelativePath(relativePath, false)
  const extension = extname(relativePath).toLowerCase()
  if (!['.md', '.markdown', '.svg', '.png', '.gif', '.pdf'].includes(extension)) {
    return { kind: 'unavailable', reason: 'Preview is unavailable for this file type.' }
  }

  const { bytes } = await readContainedFileBytes(
    workspace.canonicalRoot, workspace.rootDev, workspace.rootIno, relativePath,
    extension === '.svg' ? DISCOVERY_LIMITS.maxTextBytes : DISCOVERY_LIMITS.maxPreviewBytes,
  )
  signal?.throwIfAborted()
  if (extension === '.pdf') {
    try {
      return { kind: 'pdf', ...await rasterizePdfPage(bytes, page, signal) }
    } catch (err) {
      if (err instanceof DaemonError && err.code === 'PDF_PREVIEW_UNAVAILABLE') {
        return { kind: 'unavailable', reason: err.message }
      }
      throw err
    }
  }
  if (extension === '.svg' || extension === '.md' || extension === '.markdown') {
    return {
      kind: extension === '.svg' ? 'svg' : 'markdown',
      text: assertValidUtf8Text(bytes, relativePath),
    }
  }

  const mime = extension === '.png' ? 'image/png' : 'image/gif'
  return isBoundedRaster(bytes, mime)
    ? { kind: 'image', mime, base64: bytes.toString('base64') }
    : { kind: 'unavailable', reason: 'Unsupported or oversized image.' }
}
