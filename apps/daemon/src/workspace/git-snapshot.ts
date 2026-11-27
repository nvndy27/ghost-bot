import { constants } from 'node:fs'
import { mkdir, open, opendir, readFile, writeFile, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { DaemonError } from '../errors.ts'
import { isSensitiveSegment, walkContainedDirectoryFd } from './containment.ts'
import type { AuthorizedWorkspace } from './files-service.ts'

const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
const FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
const TOP_LEVEL_GIT = new Set(['HEAD', 'index', 'packed-refs', 'shallow', 'refs', 'objects'])
const childPath = (fd: FileHandle, name: string) => `/proc/self/fd/${fd.fd}/${name}`
const mountId = async (handle: FileHandle) => {
  const info = await readFile(`/proc/self/fdinfo/${handle.fd}`, 'utf8')
  const id = /^mnt_id:\s*(\d+)$/m.exec(info)?.[1]
  if (!id) throw new DaemonError('GIT_UNAVAILABLE', 'Cannot establish the workspace mount boundary', { statusCode: 503 })
  return id
}
const unavailable = (message: string) => new DaemonError('GIT_UNAVAILABLE', message, { statusCode: 422 })

/** The subprocess sees a private copy, never the workspace mount or a user-controlled Git configuration. */
export async function snapshotGitWorkspace(workspace: AuthorizedWorkspace, target: string, signal: AbortSignal) {
  const root = await walkContainedDirectoryFd(workspace.canonicalRoot, workspace.rootDev, workspace.rootIno, [])
  const omitted = new Set<string>()
  let bytesRemaining = 48 * 1024 * 1024
  let entriesRemaining = 4000
  try {
    const rootMount = await mountId(root)
    const sameMount = async (handle: FileHandle) =>
      (await handle.stat()).dev === workspace.rootDev && await mountId(handle) === rootMount

    async function copy(directory: FileHandle, parts: string[], metadata: boolean): Promise<void> {
      if (parts.length > 14) throw unavailable('Repository exceeds the inspection depth limit.')
      const dir = await opendir(`/proc/self/fd/${directory.fd}`)
      for await (const entry of dir) {
        signal.throwIfAborted()
        if (--entriesRemaining < 0) throw unavailable('Repository exceeds the inspection entry limit.')
        const name = entry.name
        const path = [...parts, name].join('/')
        if (name.includes('\ufffd') || name.includes('\\') || path.length > 512) {
          throw unavailable('Repository contains paths unsupported by safe inspection.')
        }

        if (metadata) {
          if (parts.length === 1 && !TOP_LEVEL_GIT.has(name)) {
            if (['commondir', 'gitdir', 'reftable', 'config.worktree'].includes(name)) {
              throw unavailable('Redirected or unsupported Git metadata is unavailable.')
            }
            continue
          }
          if (path === '.git/objects/info') {
            // Never import alternates, including an alternate added after this scan.
            continue
          }
          if (path.startsWith('.git/objects/pack/') && name.endsWith('.promisor')) {
            throw unavailable('Partial clone repositories are unavailable.')
          }
          if (path === '.git/refs/replace') continue
        } else if (isSensitiveSegment(name)) {
          omitted.add(path)
          continue
        }

        if (!entry.isFile() && !entry.isDirectory()) {
          if (metadata) throw unavailable('Unsupported Git metadata entry.')
          omitted.add(path)
          continue
        }
        let handle: FileHandle
        try {
          handle = await open(childPath(directory, name), entry.isDirectory() ? DIRECTORY_FLAGS : FILE_FLAGS)
        } catch {
          if (metadata) throw unavailable('Git metadata changed during inspection.')
          omitted.add(path)
          continue
        }
        try {
          const st = await handle.stat()
          if (!await sameMount(handle)) throw unavailable('Repository crosses a filesystem mount boundary.')
          if (entry.isDirectory() && st.isDirectory()) {
            await mkdir(join(target, path))
            await copy(handle, [...parts, name], metadata)
            continue
          }
          if (!st.isFile() || st.nlink !== 1) {
            if (metadata) throw unavailable('Linked or special Git metadata is unavailable.')
            omitted.add(path)
            continue
          }
          if (st.size > bytesRemaining) throw unavailable('Repository exceeds the inspection byte limit.')
          const bytes = Buffer.alloc(st.size)
          let offset = 0
          while (offset < bytes.length) {
            signal.throwIfAborted()
            const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
            if (!bytesRead) break
            offset += bytesRead
          }
          const after = await handle.stat()
          if (offset !== st.size || after.size !== st.size || after.ctimeMs !== st.ctimeMs || after.nlink !== 1) {
            throw unavailable('Repository changed during inspection. Refresh to try again.')
          }
          bytesRemaining -= bytes.length
          await writeFile(join(target, path), bytes, { flag: 'wx', mode: st.mode & 0o111 ? 0o700 : 0o600 })
        } finally {
          await handle.close()
        }
      }
    }

    const gitDir = await open(childPath(root, '.git'), DIRECTORY_FLAGS).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') throw unavailable('No Git repository at the authorized workspace root.')
      throw unavailable('Git worktrees and redirected metadata are unavailable.')
    })
    try {
      if (!await sameMount(gitDir)) throw unavailable('Git metadata is on another mount.')
      await mkdir(join(target, '.git'))
      await copy(gitDir, ['.git'], true)
    } finally {
      await gitDir.close()
    }
    await copy(root, [], false)
    // This file is constructed by the daemon. Repository config and includes are never consumed.
    await writeFile(join(target, '.git', 'config'), '[core]\nrepositoryformatversion = 0\nbare = false\nfilemode = true\n', { flag: 'wx', mode: 0o600 })
    return omitted
  } finally {
    await root.close()
  }
}
