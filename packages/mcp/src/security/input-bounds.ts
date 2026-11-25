import { McpValidationError } from '../contracts/errors.ts'

export interface InputShapeBounds {
  readonly maxNodes: number
  readonly maxDepth: number
  readonly maxArrayLength: number
  readonly maxStringLength: number
}

export const DEFAULT_INPUT_SHAPE_BOUNDS: InputShapeBounds = {
  maxNodes: 2048,
  maxDepth: 16,
  maxArrayLength: 500,
  maxStringLength: 65_536,
}

export function assertBoundedInputShape(
  value: unknown,
  bounds: InputShapeBounds = DEFAULT_INPUT_SHAPE_BOUNDS,
): void {
  let nodeCount = 0

  function walk(node: unknown, depth: number): void {
    if (depth > bounds.maxDepth) {
      throw new McpValidationError(`Input exceeds maximum nesting depth (${bounds.maxDepth})`)
    }
    nodeCount++
    if (nodeCount > bounds.maxNodes) {
      throw new McpValidationError(`Input exceeds maximum node count (${bounds.maxNodes})`)
    }

    if (typeof node === 'string') {
      if (node.length > bounds.maxStringLength) {
        throw new McpValidationError(`Input string exceeds maximum length (${bounds.maxStringLength})`)
      }
      return
    }

    if (Array.isArray(node)) {
      if (node.length > bounds.maxArrayLength) {
        throw new McpValidationError(`Input array exceeds maximum length (${bounds.maxArrayLength})`)
      }
      for (let i = 0; i < node.length; i++) {
        walk(node[i], depth + 1)
      }
      return
    }

    if (node !== null && typeof node === 'object') {
      const entries = Object.entries(node as Record<string, unknown>)
      if (entries.length > bounds.maxArrayLength) {
        throw new McpValidationError(`Input object property count exceeds maximum (${bounds.maxArrayLength})`)
      }
      for (const [, v] of entries) {
        walk(v, depth + 1)
      }
    }
  }

  walk(value, 0)
}
