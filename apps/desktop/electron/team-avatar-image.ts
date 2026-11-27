import { constants, open } from 'node:fs/promises'

const MAX_BYTES = 4 * 1024 * 1024
const MAX_EDGE = 3072

type ImageInfo = { mime: 'image/png' | 'image/jpeg' | 'image/webp'; width: number; height: number }

function invalid(): never {
  throw new Error('Choose a valid, non-animated PNG, JPEG or WebP image within the size limits')
}

function inspect(bytes: Buffer): ImageInfo {
  if (bytes.length < 24) return invalid()
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    if (bytes.toString('ascii', 12, 16) !== 'IHDR' || bytes.readUInt32BE(8) !== 13) return invalid()
    for (let offset = 8; offset <= bytes.length - 12;) {
      const size = bytes.readUInt32BE(offset)
      const tag = bytes.toString('ascii', offset + 4, offset + 8)
      if (size > bytes.length - offset - 12 || ['acTL', 'fcTL', 'fdAT'].includes(tag)) return invalid()
      offset += size + 12
      if (tag === 'IEND') {
        if (size || offset !== bytes.length) return invalid()
        return { mime: 'image/png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
      }
    }
  }
  if (bytes.readUInt16BE(0) === 0xffd8 && bytes.readUInt16BE(bytes.length - 2) === 0xffd9) {
    let dimensions: ImageInfo | undefined
    for (let offset = 2; offset < bytes.length - 4;) {
      if (bytes[offset++] !== 0xff) return invalid()
      while (bytes[offset] === 0xff) offset++
      const marker = bytes[offset++]
      if (marker === 0xda && dimensions) return dimensions
      if (offset + 2 > bytes.length) return invalid()
      const size = bytes.readUInt16BE(offset)
      if (size < 2 || offset + size > bytes.length) return invalid()
      if (marker === 0xe2 && bytes.toString('ascii', offset + 2, offset + 6) === 'MPF\0') return invalid()
      if ([0xc0, 0xc1, 0xc2].includes(marker) && size >= 8) {
        dimensions = { mime: 'image/jpeg', width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) }
      }
      offset += size
    }
  }
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' &&
      bytes.readUInt32LE(4) + 8 === bytes.length) {
    let dimensions: ImageInfo | undefined
    let foundImage = false
    for (let offset = 12; offset <= bytes.length - 8;) {
      const tag = bytes.toString('ascii', offset, offset + 4)
      const size = bytes.readUInt32LE(offset + 4)
      const start = offset + 8
      if (start + size > bytes.length || tag === 'ANIM' || tag === 'ANMF') return invalid()
      if (tag === 'VP8X') {
        if (size !== 10 || (bytes[start] & 2)) return invalid()
        dimensions = { mime: 'image/webp', width: bytes.readUIntLE(start + 4, 3) + 1, height: bytes.readUIntLE(start + 7, 3) + 1 }
      } else if (tag === 'VP8 ' || tag === 'VP8L') {
        if (foundImage) return invalid()
        foundImage = true
        let width: number
        let height: number
        if (tag === 'VP8 ' && size >= 10 && bytes.subarray(start + 3, start + 6).equals(Buffer.from([0x9d, 1, 0x2a]))) {
          width = bytes.readUInt16LE(start + 6) & 0x3fff
          height = bytes.readUInt16LE(start + 8) & 0x3fff
        } else if (tag === 'VP8L' && size >= 5 && bytes[start] === 0x2f) {
          const packed = bytes.readUInt32LE(start + 1)
          width = (packed & 0x3fff) + 1
          height = ((packed >>> 14) & 0x3fff) + 1
        } else return invalid()
        if (dimensions && (dimensions.width !== width || dimensions.height !== height)) return invalid()
        dimensions = { mime: 'image/webp', width, height }
      }
      offset = start + size + (size % 2)
    }
    if (foundImage && dimensions) return dimensions
  }
  return invalid()
}

export async function readTeamAvatarImage(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_BYTES) return invalid()
    const bytes = Buffer.alloc(stat.size)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (bytesRead === 0) return invalid()
      offset += bytesRead
    }
    if ((await handle.stat()).size !== stat.size) return invalid()
    const image = inspect(bytes)
    if (image.width < 1 || image.height < 1 || image.width > MAX_EDGE || image.height > MAX_EDGE ||
        image.width * image.height > 4000000) return invalid()
    return `data:${image.mime};base64,${bytes.toString('base64')}`
  } finally {
    await handle.close()
  }
}
