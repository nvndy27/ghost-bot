import type { ReactNode } from 'react'

type TokenKind = 'plain' | 'comment' | 'string' | 'keyword' | 'number'

const KEYWORDS = new Set([
  'import',
  'export',
  'from',
  'const',
  'let',
  'var',
  'function',
  'return',
  'if',
  'else',
  'for',
  'while',
  'switch',
  'case',
  'break',
  'continue',
  'async',
  'await',
  'try',
  'catch',
  'finally',
  'throw',
  'new',
  'class',
  'interface',
  'type',
  'extends',
  'implements',
  'true',
  'false',
  'null',
  'undefined',
  'def',
  'fn',
  'pub',
  'struct',
  'enum',
  'impl',
  'SELECT',
  'FROM',
  'WHERE',
])

const TOKEN_RE =
  /(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b\d+(?:\.\d+)?\b|\b[A-Za-z_][A-Za-z0-9_]*\b)/g

function classifyToken(token: string, language: string): TokenKind {
  if (token.startsWith('//') || token.startsWith('/*')) return 'comment'
  if (token.startsWith('#') && (language === 'python' || language === 'shell' || language === 'yaml')) {
    return 'comment'
  }
  if (token.startsWith('"') || token.startsWith("'") || token.startsWith('`')) return 'string'
  if (/^\d/.test(token)) return 'number'
  if (KEYWORDS.has(token)) return 'keyword'
  return 'plain'
}

export function highlightCodeLines(content: string, language: string): ReactNode[] {
  if (language === 'plaintext') {
    return [content]
  }
  const nodes: ReactNode[] = []
  let lastIndex = 0
  let key = 0
  TOKEN_RE.lastIndex = 0

  for (const match of content.matchAll(TOKEN_RE)) {
    const idx = match.index ?? 0
    if (idx > lastIndex) {
      nodes.push(content.slice(lastIndex, idx))
    }
    const text = match[0]
    const kind = classifyToken(text, language)
    if (kind === 'plain') {
      nodes.push(text)
    } else {
      nodes.push(
        <span key={key++} className={`gb-tok-${kind}`}>
          {text}
        </span>,
      )
    }
    lastIndex = idx + text.length
  }

  if (lastIndex < content.length) {
    nodes.push(content.slice(lastIndex))
  }
  return nodes
}
