import { crc32, inflateSync } from 'node:zlib'
import { sanitizeCustomSvg } from '@ghost-bot/avatar/svg-sanitizer'
import { TeamAppearanceSchema, type TeamAppearance } from '@ghost-bot/shared-types/ipc'
import type { DatabaseHandle } from '../db/client.ts'
import { DaemonError } from '../errors.ts'

const prefix = 'teams.appearance:'
const auto = { mode: 'auto' } as const

function validateRaster(dataUrl: string): void {
  const bytes = Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64')
  const reject = () => { throw new DaemonError('INVALID_TEAM_AVATAR', 'Invalid normalized group avatar', { statusCode: 400 }) }
  if (bytes.length < 45 || bytes.length > 80000 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return reject()
  let stride = 0
  let ended = false
  const payload: Buffer[] = []
  for (let offset = 8; offset < bytes.length;) {
    if (offset + 12 > bytes.length) return reject()
    const size = bytes.readUInt32BE(offset)
    const end = offset + size + 12
    if (end > bytes.length) return reject()
    const tag = bytes.toString('ascii', offset + 4, offset + 8)
    const data = bytes.subarray(offset + 8, end - 4)
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) return reject()
    if (offset === 8) {
      if (tag !== 'IHDR' || size !== 13 || data.readUInt32BE(0) !== 128 || data.readUInt32BE(4) !== 128 ||
          data[8] !== 8 || ![2, 6].includes(data[9]) || data[10] || data[11] || data[12]) return reject()
      stride = 1 + 128 * (data[9] === 2 ? 3 : 4)
    } else if (tag === 'IDAT') payload.push(data)
    else if (tag === 'IEND') {
      if (size || end !== bytes.length) return reject()
      ended = true
    } else if (!['sRGB', 'pHYs', 'gAMA', 'cHRM'].includes(tag)) return reject()
    offset = end
  }
  if (!ended || !payload.length) return reject()
  try {
    const pixels = inflateSync(Buffer.concat(payload), { maxOutputLength: 128 * stride })
    if (pixels.length !== 128 * stride) return reject()
    for (let row = 0; row < 128; row++) if (pixels[row * stride] > 4) return reject()
  } catch {
    return reject()
  }
}

export function readTeamAppearance(db: DatabaseHandle, teamId: string): TeamAppearance {
  const row = db.sqlite.prepare('SELECT value_json FROM settings WHERE key = ?').get(prefix + teamId) as { value_json: string } | undefined
  try {
    return row ? TeamAppearanceSchema.parse(JSON.parse(row.value_json)) : auto
  } catch {
    return auto
  }
}

export function writeTeamAppearance(db: DatabaseHandle, teamId: string, appearance: TeamAppearance): void {
  let value = appearance
  if (appearance.mode === 'upload') validateRaster(appearance.dataUrl)
  if (appearance.mode === 'bot' && appearance.avatar.kind === 'custom') {
    const raw = Buffer.from(appearance.avatar.svgDataUrl.slice('data:image/svg+xml;base64,'.length), 'base64').toString('utf8')
    const sanitized = sanitizeCustomSvg(raw)
    if (!sanitized.ok) throw new DaemonError('INVALID_TEAM_AVATAR', 'Invalid bot avatar snapshot', { statusCode: 400 })
    value = { mode: 'bot', avatar: { ...appearance.avatar, svgDataUrl: sanitized.dataUrl } }
  }
  db.sqlite.prepare(`INSERT INTO settings(key, value_json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`)
    .run(prefix + teamId, JSON.stringify(value), new Date().toISOString())
}
