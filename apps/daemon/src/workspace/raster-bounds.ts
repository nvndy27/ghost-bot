const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const STATIC_PNG_CHUNKS = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'sRGB', 'gAMA', 'cHRM', 'pHYs'])

function fits(width: number, height: number, max: number): boolean {
  return width > 0 && height > 0 && width <= max && height <= max && width * height <= 4_000_000
}

function boundedPng(bytes: Buffer, max: number): boolean {
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) ||
      bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR' ||
      !fits(bytes.readUInt32BE(16), bytes.readUInt32BE(20), max)) return false
  let data = false
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.toString('latin1', offset + 4, offset + 8)
    const end = offset + 12 + length
    if (end > bytes.length || !STATIC_PNG_CHUNKS.has(type) || (type === 'IHDR' && offset !== 8)) return false
    if (type === 'IDAT') data = true
    if (type === 'IEND') return data && length === 0 && end === bytes.length
    offset = end
  }
  return false
}

function skipBlocks(bytes: Buffer, offset: number): number {
  while (offset < bytes.length) {
    const length = bytes[offset++]
    if (!length) return offset
    offset += length
  }
  return -1
}

function boundedGif(bytes: Buffer, max: number): boolean {
  if (bytes.length < 14 || !['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return false
  const width = bytes.readUInt16LE(6)
  const height = bytes.readUInt16LE(8)
  if (!fits(width, height, max)) return false
  const colorTable = (flags: number) => flags & 0x80 ? 3 * 2 ** ((flags & 7) + 1) : 0
  let offset = 13 + colorTable(bytes[10])
  let frame = false
  while (offset >= 0 && offset < bytes.length) {
    const marker = bytes[offset++]
    if (marker === 0x3b) return frame && offset === bytes.length
    if (marker === 0x21) {
      const extension = bytes[offset++]
      if (extension !== 0xf9 && extension !== 0xfe) return false
      offset = skipBlocks(bytes, offset)
      continue
    }
    if (marker !== 0x2c || frame || offset + 9 > bytes.length) return false
    const x = bytes.readUInt16LE(offset)
    const y = bytes.readUInt16LE(offset + 2)
    const frameWidth = bytes.readUInt16LE(offset + 4)
    const frameHeight = bytes.readUInt16LE(offset + 6)
    if (!fits(frameWidth, frameHeight, max) || x + frameWidth > width || y + frameHeight > height) return false
    offset += 9 + colorTable(bytes[offset + 8])
    if (bytes[offset] < 2 || bytes[offset] > 8 || offset >= bytes.length) return false
    offset = skipBlocks(bytes, offset + 1)
    frame = true
  }
  return false
}

export function isBoundedRaster(bytes: Buffer, mime: 'image/png' | 'image/gif', max = 2048): boolean {
  return mime === 'image/png' ? boundedPng(bytes, max) : boundedGif(bytes, max)
}
