import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseHandle } from '../db/client.ts'
import { DaemonError, redactSecrets } from '../errors.ts'
import { LOCAL_USER_ID } from '../memory/service.ts'

const MAX_MANIFEST_BYTES = 64 * 1024
const MAX_SKILLS_PER_DISCOVERY = 100

export interface LocalSkillDto {
  id: string
  ownerId: string
  sourceRoot: string
  sourcePath: string
  name: string
  description: string
  manifest: { name: string; description: string }
  contentFingerprint: string
  trustedFingerprint: string | null
  trustState: 'untrusted' | 'trusted' | 'revoked' | 'invalid'
  enabled: boolean
  validationError: string | null
  createdAt: string
  updatedAt: string
}

function parseSkillFrontmatter(raw: string): {
  name: string
  description: string
  error: string | null
} {
  if (raw.includes('\0')) {
    return { name: 'invalid-skill', description: '', error: 'Skill manifest contains NUL bytes' }
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)
  if (!match) {
    return {
      name: 'invalid-skill',
      description: '',
      error: 'Missing YAML frontmatter delimited by ---',
    }
  }

  let name = ''
  let description = ''
  for (const line of match[1]!.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const sep = trimmed.indexOf(':')
    if (sep <= 0) continue
    const key = trimmed.slice(0, sep).trim()
    const val = trimmed.slice(sep + 1).trim().replace(/^['"]|['"]$/g, '')
    if (key === 'name') name = val
    if (key === 'description') description = val
  }

  if (!name || name.length > 80 || /[\r\n\0]/.test(name)) {
    return {
      name: name || 'invalid-skill',
      description,
      error: 'Skill manifest requires a valid "name" (1-80 chars)',
    }
  }
  if (!description || description.length > 400 || /\0/.test(description)) {
    return {
      name,
      description,
      error: 'Skill manifest requires a valid "description" (1-400 chars)',
    }
  }

  return { name, description, error: null }
}

export class LocalSkillsService {
  private readonly dbHandle: DatabaseHandle

  constructor(dbHandle: DatabaseHandle) {
    this.dbHandle = dbHandle
  }

  discoverSkills(roots: string[]): LocalSkillDto[] {
    const discovered: LocalSkillDto[] = []
    for (const rawRoot of roots) {
      if (!rawRoot || rawRoot.includes('\0') || rawRoot.includes('..')) {
        throw new DaemonError('VALIDATION_ERROR', 'Invalid skill root path', { statusCode: 400 })
      }
      let canonicalRoot: string
      try {
        const rootStat = fs.lstatSync(rawRoot)
        if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
          throw new Error('Root must be a real directory')
        }
        canonicalRoot = fs.realpathSync(rawRoot)
      } catch {
        throw new DaemonError('SKILL_ROOT_INVALID', `Authorized skill root "${rawRoot}" is invalid`, {
          statusCode: 400,
        })
      }

      const entries = fs.readdirSync(canonicalRoot, { withFileTypes: true })
      for (const entry of entries) {
        if (discovered.length >= MAX_SKILLS_PER_DISCOVERY) break
        if (entry.isSymbolicLink() || !entry.isDirectory()) continue
        const skillDir = path.join(canonicalRoot, entry.name)
        const skillDirStat = fs.lstatSync(skillDir)
        if (skillDirStat.isSymbolicLink()) continue

        const skillFile = path.join(skillDir, 'SKILL.md')
        if (!fs.existsSync(skillFile)) continue
        const fileStat = fs.lstatSync(skillFile)
        if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
          throw new DaemonError(
            'SKILL_SYMLINK_REJECTED',
            `Rejected symlinked skill file "${skillFile}"`,
            { statusCode: 400 },
          )
        }
        const canonicalFile = fs.realpathSync(skillFile)
        if (!canonicalFile.startsWith(canonicalRoot + path.sep)) {
          throw new DaemonError(
            'SKILL_PATH_ESCAPE',
            'Skill file escaped authorized root directory',
            { statusCode: 400 },
          )
        }

        let validationError: string | null = null
        let rawBytes = Buffer.alloc(0)
        if (fileStat.size > MAX_MANIFEST_BYTES) {
          validationError = `SKILL.md exceeds ${MAX_MANIFEST_BYTES} bytes`
        } else {
          rawBytes = fs.readFileSync(canonicalFile)
        }

        const fingerprint = createHash('sha256').update(rawBytes).digest('hex')
        const parsed = validationError
          ? { name: entry.name, description: '', error: validationError }
          : parseSkillFrontmatter(rawBytes.toString('utf8'))

        const nowIso = new Date().toISOString()
        const existing = this.dbHandle.sqlite
          .prepare(`SELECT * FROM local_skills WHERE source_path = ? AND owner_id = ?`)
          .get(canonicalFile, LOCAL_USER_ID) as Record<string, unknown> | undefined

        if (!existing) {
          const id = `skill_${randomUUID()}`
          const trustState = parsed.error ? 'invalid' : 'untrusted'
          this.dbHandle.sqlite
            .prepare(
              `INSERT INTO local_skills (
                id, owner_id, source_root, source_path, name, description,
                manifest_json, content_fingerprint, trusted_fingerprint,
                trust_state, enabled, validation_error, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 0, ?, ?, ?)`,
            )
            .run(
              id,
              LOCAL_USER_ID,
              canonicalRoot,
              canonicalFile,
              parsed.name,
              parsed.description,
              JSON.stringify({ name: parsed.name, description: parsed.description }),
              fingerprint,
              trustState,
              parsed.error,
              nowIso,
              nowIso,
            )
          discovered.push(this.getSkill(id))
        } else {
          const prevTrustedFp = existing.trusted_fingerprint
            ? String(existing.trusted_fingerprint)
            : null
          const prevTrustState = String(existing.trust_state)
          const contentChanged = String(existing.content_fingerprint) !== fingerprint
          let nextTrustState = prevTrustState
          let nextEnabled = Number(existing.enabled) === 1 ? 1 : 0

          if (parsed.error) {
            nextTrustState = 'invalid'
            nextEnabled = 0
          } else if (contentChanged && prevTrustState === 'trusted') {
            nextTrustState = 'revoked'
            nextEnabled = 0
          } else if (!parsed.error && prevTrustState === 'invalid') {
            nextTrustState = prevTrustedFp === fingerprint ? 'trusted' : 'untrusted'
          }

          this.dbHandle.sqlite
            .prepare(
              `UPDATE local_skills
               SET name = ?, description = ?, manifest_json = ?,
                   content_fingerprint = ?, trust_state = ?, enabled = ?,
                   validation_error = ?, updated_at = ?
               WHERE id = ?`,
            )
            .run(
              parsed.name,
              parsed.description,
              JSON.stringify({ name: parsed.name, description: parsed.description }),
              fingerprint,
              nextTrustState,
              nextEnabled,
              parsed.error,
              nowIso,
              String(existing.id),
            )
          discovered.push(this.getSkill(String(existing.id)))
        }
      }
    }
    return discovered
  }

  listSkills(limit = 100): LocalSkillDto[] {
    const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)))
    const rows = this.dbHandle.sqlite
      .prepare(`SELECT * FROM local_skills WHERE owner_id = ? ORDER BY name ASC LIMIT ?`)
      .all(LOCAL_USER_ID, safeLimit) as Record<string, unknown>[]
    return rows.map((r) => this.rowToDto(r))
  }

  getSkill(skillId: string): LocalSkillDto {
    const row = this.dbHandle.sqlite
      .prepare(`SELECT * FROM local_skills WHERE id = ? AND owner_id = ?`)
      .get(skillId, LOCAL_USER_ID) as Record<string, unknown> | undefined
    if (!row) {
      throw new DaemonError('SKILL_NOT_FOUND', `Skill "${skillId}" not found`, { statusCode: 404 })
    }
    return this.rowToDto(row)
  }

  approveTrust(skillId: string): LocalSkillDto {
    const skill = this.getSkill(skillId)
    if (skill.validationError || skill.trustState === 'invalid') {
      throw new DaemonError(
        'SKILL_INVALID',
        `Cannot trust invalid skill "${skill.name}": ${skill.validationError ?? 'validation error'}`,
        { statusCode: 400 },
      )
    }
    const nowIso = new Date().toISOString()
    this.dbHandle.sqlite
      .prepare(
        `UPDATE local_skills
         SET trust_state = 'trusted', trusted_fingerprint = content_fingerprint, updated_at = ?
         WHERE id = ?`,
      )
      .run(nowIso, skillId)
    return this.getSkill(skillId)
  }

  revokeTrust(skillId: string): LocalSkillDto {
    this.getSkill(skillId)
    const nowIso = new Date().toISOString()
    this.dbHandle.sqlite
      .prepare(
        `UPDATE local_skills
         SET trust_state = 'revoked', enabled = 0, updated_at = ?
         WHERE id = ?`,
      )
      .run(nowIso, skillId)
    return this.getSkill(skillId)
  }

  setEnabled(skillId: string, enabled: boolean): LocalSkillDto {
    const skill = this.getSkill(skillId)
    if (enabled) {
      if (
        skill.trustState !== 'trusted' ||
        skill.trustedFingerprint !== skill.contentFingerprint ||
        skill.validationError !== null
      ) {
        throw new DaemonError(
          'SKILL_UNTRUSTED',
          `Skill "${skill.name}" must be trusted with a matching content fingerprint before enabling`,
          { statusCode: 403 },
        )
      }
    }
    const nowIso = new Date().toISOString()
    this.dbHandle.sqlite
      .prepare(`UPDATE local_skills SET enabled = ?, updated_at = ? WHERE id = ?`)
      .run(enabled ? 1 : 0, nowIso, skillId)
    return this.getSkill(skillId)
  }

  private rowToDto(r: Record<string, unknown>): LocalSkillDto {
    return {
      id: String(r.id),
      ownerId: String(r.owner_id),
      sourceRoot: String(r.source_root),
      sourcePath: String(r.source_path),
      name: String(r.name),
      description: String(r.description),
      manifest: JSON.parse(String(r.manifest_json)) as { name: string; description: string },
      contentFingerprint: String(r.content_fingerprint),
      trustedFingerprint:
        r.trusted_fingerprint === null || r.trusted_fingerprint === undefined
          ? null
          : String(r.trusted_fingerprint),
      trustState: r.trust_state as LocalSkillDto['trustState'],
      enabled: Number(r.enabled) === 1,
      validationError:
        r.validation_error === null || r.validation_error === undefined
          ? null
          : redactSecrets(String(r.validation_error)),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    }
  }
}
