import { computeContentHash, normalizeForDeduplication } from '@ghost-bot/memory'
import { KnowledgeValidationError } from '../contracts/errors.ts'
import { KNOWLEDGE_LIMITS } from '../contracts/limits.ts'
import { ChunkingOptionsSchema } from '../contracts/schemas.ts'
import type { ChunkingOptions, KnowledgeSourceLocation, KnowledgeSourceType } from '../contracts/types.ts'

export interface ProducedChunk {
  readonly chunkIndex: number
  readonly content: string
  readonly normalizedContent: string
  readonly contentHash: string
  readonly location: KnowledgeSourceLocation
}

interface TextSegment {
  readonly text: string
  readonly startLine: number
  readonly endLine: number
  readonly startChar: number
  readonly endChar: number
  readonly sectionPath: readonly string[]
}

const HEADING_REGEX = /^(#{1,6})\s+(.+?)\s*#*$/

function splitByCodePoints(text: string, maxChars: number, overlapChars: number): Array<{ text: string; offset: number }> {
  const codePoints = Array.from(text)
  if (text.length <= maxChars) {
    return [{ text, offset: 0 }]
  }

  const slices: Array<{ text: string; offset: number }> = []
  let cpStart = 0
  let charOffset = 0

  while (cpStart < codePoints.length) {
    let cpEnd = cpStart
    let utf16Len = 0
    while (cpEnd < codePoints.length) {
      const nextLen = codePoints[cpEnd]!.length
      if (utf16Len + nextLen > maxChars && cpEnd > cpStart) {
        break
      }
      utf16Len += nextLen
      cpEnd++
    }

    const sliceText = codePoints.slice(cpStart, cpEnd).join('')
    slices.push({ text: sliceText, offset: charOffset })
    if (cpEnd >= codePoints.length) break

    let stepBackCps = 0
    let overlapUtf16 = 0
    while (cpEnd - stepBackCps > cpStart + 1 && overlapUtf16 < overlapChars) {
      const cp = codePoints[cpEnd - 1 - stepBackCps]!
      if (overlapUtf16 + cp.length > overlapChars) break
      overlapUtf16 += cp.length
      stepBackCps++
    }

    const nextCpStart = cpEnd - stepBackCps
    for (let i = cpStart; i < nextCpStart; i++) {
      charOffset += codePoints[i]!.length
    }
    cpStart = nextCpStart
  }

  return slices
}

function buildLineSegments(normalizedText: string, sourceType: KnowledgeSourceType): TextSegment[] {
  const lines = normalizedText.split('\n')
  const segments: TextSegment[] = []
  const headingStack: Array<{ level: number; title: string }> = []

  let currentLines: string[] = []
  let blockStartLine = 1
  let blockStartChar = 0
  let runningChar = 0

  const flushBlock = (endLine: number) => {
    if (currentLines.length === 0) return
    const blockText = currentLines.join('\n').trim()
    if (blockText.length > 0) {
      const rawBlock = currentLines.join('\n')
      const leadingTrim = rawBlock.length - rawBlock.trimStart().length
      const startChar = blockStartChar + leadingTrim
      const endChar = startChar + blockText.length
      segments.push({
        text: blockText,
        startLine: blockStartLine,
        endLine,
        startChar,
        endChar,
        sectionPath: headingStack.map((h) => h.title),
      })
    }
    currentLines = []
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const lineNum = i + 1
    const trimmed = line.trim()

    if (sourceType === 'markdown') {
      const headingMatch = HEADING_REGEX.exec(trimmed)
      if (headingMatch) {
        flushBlock(lineNum - 1)
        const level = headingMatch[1]!.length
        const headingTitle = headingMatch[2]!.trim().slice(0, KNOWLEDGE_LIMITS.maxTitleLength)
        while (headingStack.length > 0 && headingStack[headingStack.length - 1]!.level >= level) {
          headingStack.pop()
        }
        headingStack.push({ level, title: headingTitle })
        blockStartLine = lineNum
        blockStartChar = runningChar
        currentLines = [line]
        runningChar += line.length + 1
        flushBlock(lineNum)
        blockStartLine = lineNum + 1
        blockStartChar = runningChar
        continue
      }
    }

    if (trimmed.length === 0) {
      flushBlock(lineNum - 1)
      runningChar += line.length + 1
      blockStartLine = lineNum + 1
      blockStartChar = runningChar
      continue
    }

    if (currentLines.length === 0) {
      blockStartLine = lineNum
      blockStartChar = runningChar
    }
    currentLines.push(line)
    runningChar += line.length + 1
  }

  flushBlock(lines.length)
  return segments
}

export function chunkDocumentText(
  normalizedText: string,
  sourceType: KnowledgeSourceType,
  rawOptions?: ChunkingOptions,
): ProducedChunk[] {
  const parsedOpts = ChunkingOptionsSchema.safeParse(rawOptions ?? {})
  if (!parsedOpts.success) {
    throw new KnowledgeValidationError(
      `Invalid chunking options: ${parsedOpts.error.issues[0]?.message ?? 'validation failed'}`,
    )
  }
  const opts = parsedOpts.data
  const segments = buildLineSegments(normalizedText, sourceType)
  if (segments.length === 0) {
    throw new KnowledgeValidationError('Document produced no non-empty text segments')
  }

  const expandedSegments: TextSegment[] = []
  for (const seg of segments) {
    if (seg.text.length <= opts.maxChunkChars) {
      expandedSegments.push(seg)
    } else {
      const parts = splitByCodePoints(seg.text, opts.targetChunkChars, opts.overlapChars)
      for (const part of parts) {
        const trimmed = part.text.trim()
        if (!trimmed) continue
        const lead = part.text.length - part.text.trimStart().length
        const startChar = seg.startChar + part.offset + lead
        expandedSegments.push({
          text: trimmed,
          startLine: seg.startLine,
          endLine: seg.endLine,
          startChar,
          endChar: startChar + trimmed.length,
          sectionPath: seg.sectionPath,
        })
      }
    }
  }

  const chunks: ProducedChunk[] = []
  let buffer: TextSegment[] = []
  let bufferText = ''

  const pushChunk = (text: string, startLine: number, endLine: number, startChar: number, endChar: number, sectionPath: readonly string[]) => {
    const trimmed = text.trim()
    if (!trimmed) return
    if (chunks.length >= KNOWLEDGE_LIMITS.maxChunksPerDocument) {
      throw new KnowledgeValidationError(
        `Document exceeds maximum chunk count (${KNOWLEDGE_LIMITS.maxChunksPerDocument})`,
      )
    }
    const normalizedContent = normalizeForDeduplication(trimmed)
    const contentHash = computeContentHash(normalizedContent)
    chunks.push({
      chunkIndex: chunks.length,
      content: trimmed,
      normalizedContent,
      contentHash,
      location: {
        pageNumber: null,
        startLine,
        endLine,
        startChar,
        endChar,
        sectionPath: [...sectionPath],
      },
    })
  }

  const flushBuffer = () => {
    if (buffer.length === 0) return
    const first = buffer[0]!
    const last = buffer[buffer.length - 1]!
    pushChunk(bufferText, first.startLine, last.endLine, first.startChar, last.endChar, first.sectionPath)
    buffer = []
    bufferText = ''
  }

  for (const seg of expandedSegments) {
    const separator = bufferText.length > 0 ? '\n\n' : ''
    const candidateLen = bufferText.length + separator.length + seg.text.length
    const sectionChanged =
      buffer.length > 0 &&
      buffer[0]!.sectionPath.join('\u0000') !== seg.sectionPath.join('\u0000')

    if (buffer.length > 0 && (sectionChanged || candidateLen > opts.targetChunkChars)) {
      const prevLast = buffer[buffer.length - 1]!
      flushBuffer()

      if (!sectionChanged && opts.overlapChars > 0 && prevLast.text.length <= opts.overlapChars && prevLast.text.length + 2 + seg.text.length <= opts.maxChunkChars) {
        buffer = [prevLast, seg]
        bufferText = `${prevLast.text}\n\n${seg.text}`
        continue
      }
    }

    buffer.push(seg)
    bufferText = bufferText.length > 0 ? `${bufferText}\n\n${seg.text}` : seg.text
  }

  flushBuffer()

  if (chunks.length === 0) {
    throw new KnowledgeValidationError('Chunking produced zero valid chunks')
  }

  return chunks
}
