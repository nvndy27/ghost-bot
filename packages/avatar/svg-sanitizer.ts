import DOMPurify from 'isomorphic-dompurify'

export const MAX_SVG_BYTES = 32 * 1024
export const MAX_SVG_ELEMENTS = 150
export const MAX_SVG_DEPTH = 32
export const MAX_SVG_ATTR_LENGTH = 8192

const ALLOWED_SVG_TAGS = new Set([
  'svg',
  'g',
  'path',
  'circle',
  'ellipse',
  'rect',
  'polygon',
  'polyline',
  'line',
  'defs',
  'lineargradient',
  'radialgradient',
  'stop',
  'title',
])

const FORBIDDEN_SVG_TAGS = [
  'script',
  'foreignobject',
  'iframe',
  'object',
  'embed',
  'audio',
  'video',
  'image',
  'use',
  'animate',
  'animatemotion',
  'animatetransform',
  'set',
  'mpath',
  'style',
  'link',
  'meta',
]

const FORBIDDEN_ATTR_NAMES = [
  'href',
  'xlink:href',
  'style',
  'formaction',
  'action',
  'src',
  'data',
]

const UNSAFE_VALUE_PATTERN =
  /(javascript:|vbscript:|data:|http:|https:|\/\/|url\s*\(|@import|expression\s*\()/i

export type SvgSanitizeResult =
  | { ok: true; sanitizedSvg: string; dataUrl: string }
  | { ok: false; reason: string }

function validateSanitizedSvgTree(sanitizedSvg: string): string | null {
  const trimmed = sanitizedSvg.trim()
  if (!trimmed || !trimmed.toLowerCase().startsWith('<svg')) {
    return 'Sanitized output does not contain a root <svg> element'
  }

  // Parse tags and attributes deterministically on the already-DOMPurify-sanitized output.
  const tagPattern = /<\s*(\/?)\s*([a-zA-Z0-9:_-]+)([^>]*)>/g
  let elementCount = 0
  let rootChecked = false
  const tagStack: string[] = []
  let match: RegExpExecArray | null

  while ((match = tagPattern.exec(trimmed)) !== null) {
    const isClosing = match[1] === '/'
    const tagName = match[2].toLowerCase()
    const rawAttrs = match[3] ?? ''
    const isSelfClosing = !isClosing && /\/\s*$/.test(rawAttrs)

    if (!ALLOWED_SVG_TAGS.has(tagName)) {
      return `Disallowed SVG element: <${tagName}>`
    }

    if (isClosing) {
      const expected = tagStack.pop()
      if (expected !== tagName) {
        return `Malformed SVG closing tag </${tagName}>`
      }
      continue
    }

    elementCount += 1
    if (elementCount > MAX_SVG_ELEMENTS) {
      return `SVG exceeds maximum element count (${MAX_SVG_ELEMENTS})`
    }
    if (!rootChecked) {
      rootChecked = true
      if (tagName !== 'svg') {
        return 'Root element must be <svg>'
      }
    }
    if (!isSelfClosing) {
      tagStack.push(tagName)
      if (tagStack.length > MAX_SVG_DEPTH) {
        return `SVG exceeds maximum nesting depth (${MAX_SVG_DEPTH})`
      }
    }

    const seenAttrs = new Set<string>()
    const attrPattern = /([a-zA-Z0-9:_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
    let attrMatch: RegExpExecArray | null
    while ((attrMatch = attrPattern.exec(rawAttrs)) !== null) {
      const attrName = attrMatch[1].toLowerCase()
      const attrVal = attrMatch[2] ?? attrMatch[3] ?? ''
      if (seenAttrs.has(attrName)) {
        return `Duplicate SVG attribute: ${attrName}`
      }
      seenAttrs.add(attrName)
      if (attrVal.length > MAX_SVG_ATTR_LENGTH) {
        return `SVG attribute ${attrName} exceeds maximum length (${MAX_SVG_ATTR_LENGTH})`
      }
      if (attrName.startsWith('on') || FORBIDDEN_ATTR_NAMES.includes(attrName)) {
        return `Disallowed SVG attribute: ${attrName}`
      }
      if (attrName === 'xmlns' && attrVal === 'http://www.w3.org/2000/svg') {
        continue
      }
      if (UNSAFE_VALUE_PATTERN.test(attrVal)) {
        return `Disallowed external or scriptable value in attribute ${attrName}`
      }
      if (attrName === 'width' || attrName === 'height') {
        const num = Number.parseFloat(attrVal)
        if (Number.isFinite(num) && (num <= 0 || num > 2048)) {
          return `SVG ${attrName} out of allowed bounds (1..2048)`
        }
      }
    }
  }

  if (tagStack.length > 0) {
    return `Malformed SVG: unclosed <${tagStack[tagStack.length - 1]}> element`
  }

  return null
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

function toBase64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

/**
 * Strictly validates and sanitizes untrusted SVG markup into an inert
 * `data:image/svg+xml;base64,...` URL suitable for `<img>` rendering only.
 */
export function sanitizeCustomSvg(rawInput: string): SvgSanitizeResult {
  if (typeof rawInput !== 'string' || !rawInput.trim()) {
    return { ok: false, reason: 'SVG input is empty' }
  }
  const byteLength = utf8ByteLength(rawInput)
  if (byteLength > MAX_SVG_BYTES) {
    return { ok: false, reason: `SVG exceeds ${MAX_SVG_BYTES} byte limit` }
  }

  // Reject XML DTD/entity/comment/CDATA/processing-instruction constructs before DOMPurify parsing.
  if (/<!DOCTYPE|<!ENTITY|<!ATTLIST|<!\[CDATA\[|<!--|<\?xml-stylesheet/i.test(rawInput)) {
    return { ok: false, reason: 'XML DTD, ENTITY, comment, CDATA, or stylesheet declarations are not allowed' }
  }

  // Reject explicitly forbidden elements up front so adversarial inputs fail closed rather than silently mutating.
  for (const tag of FORBIDDEN_SVG_TAGS) {
    if (new RegExp(`<\\s*${tag}\\b`, 'i').test(rawInput)) {
      return { ok: false, reason: `Forbidden SVG element: <${tag}>` }
    }
  }
  if (/\son[a-z]+\s*=/i.test(rawInput)) {
    return { ok: false, reason: 'Event handler attributes are not allowed' }
  }
  const withoutSvgNs = rawInput.replace(/xmlns\s*=\s*["']http:\/\/www\.w3\.org\/2000\/svg["']/gi, '')
  if (UNSAFE_VALUE_PATTERN.test(withoutSvgNs)) {
    return { ok: false, reason: 'External URLs, data URIs, or scriptable CSS are not allowed' }
  }

  // Reject duplicate attributes on rawInput to prevent parser-differential tricks.
  const rawTagPattern = /<\s*[a-zA-Z0-9:_-]+([^>]*)>/g
  let rawTagMatch: RegExpExecArray | null
  while ((rawTagMatch = rawTagPattern.exec(rawInput)) !== null) {
    const rawAttrs = rawTagMatch[1] ?? ''
    const seen = new Set<string>()
    const rawAttrPattern = /\s([a-zA-Z0-9:_-]+)\s*=/g
    let m: RegExpExecArray | null
    while ((m = rawAttrPattern.exec(rawAttrs)) !== null) {
      const attr = m[1].toLowerCase()
      if (seen.has(attr)) {
        return { ok: false, reason: `Duplicate SVG attribute: ${attr}` }
      }
      seen.add(attr)
    }
  }

  const sanitized = DOMPurify.sanitize(rawInput, {
    USE_PROFILES: { svg: true },
    FORBID_TAGS: FORBIDDEN_SVG_TAGS,
    FORBID_ATTR: FORBIDDEN_ATTR_NAMES,
    ALLOW_DATA_ATTR: false,
  })

  const validationError = validateSanitizedSvgTree(sanitized)
  if (validationError) {
    return { ok: false, reason: validationError }
  }

  const trimmed = sanitized.trim()
  const base64 = toBase64Utf8(trimmed)
  return {
    ok: true,
    sanitizedSvg: trimmed,
    dataUrl: `data:image/svg+xml;base64,${base64}`,
  }
}
