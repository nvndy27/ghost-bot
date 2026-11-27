export type McpErrorCode =
  | 'VALIDATION_ERROR'
  | 'AUTHORIZATION_ERROR'
  | 'TRUST_REQUIRED'
  | 'UNSUPPORTED_TRANSPORT'
  | 'NOT_FOUND'
  | 'DUPLICATE_SERVER'
  | 'CREDENTIAL_DETECTED'
  | 'UNSAFE_PATH'
  | 'TRANSPORT_ERROR'
  | 'PROTOCOL_ERROR'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'TOOL_EXECUTION_ERROR'
  | 'UNSUPPORTED_CAPABILITY'
  | 'STORAGE_CORRUPTION'
  | 'STORAGE_ERROR'

export class McpError extends Error {
  readonly code: McpErrorCode
  readonly uncertainOutcome: boolean

  constructor(code: McpErrorCode, message: string, options?: { uncertainOutcome?: boolean }) {
    super(message)
    this.name = 'McpError'
    this.code = code
    this.uncertainOutcome = options?.uncertainOutcome ?? false
  }
}

export class McpValidationError extends McpError {
  constructor(message: string) {
    super('VALIDATION_ERROR', message)
    this.name = 'McpValidationError'
  }
}

export class McpAuthorizationError extends McpError {
  constructor(message = 'MCP operation is not authorized for the supplied context') {
    super('AUTHORIZATION_ERROR', message)
    this.name = 'McpAuthorizationError'
  }
}

export class McpTrustError extends McpError {
  constructor(message = 'MCP server is disabled or lacks valid trust for current configuration') {
    super('TRUST_REQUIRED', message)
    this.name = 'McpTrustError'
  }
}

export class McpUnsupportedTransportError extends McpError {
  constructor(message = 'Unsupported MCP transport; only local stdio is enabled in Phase 3C') {
    super('UNSUPPORTED_TRANSPORT', message)
    this.name = 'McpUnsupportedTransportError'
  }
}

export class McpNotFoundError extends McpError {
  constructor(message = 'MCP server or capability not found or not accessible') {
    super('NOT_FOUND', message)
    this.name = 'McpNotFoundError'
  }
}

export class McpDuplicateError extends McpError {
  constructor(message = 'An MCP server with this name already exists in the target scope') {
    super('DUPLICATE_SERVER', message)
    this.name = 'McpDuplicateError'
  }
}

export class McpCredentialError extends McpError {
  constructor(message = 'MCP configuration rejected because it contains a recognized credential pattern') {
    super('CREDENTIAL_DETECTED', message)
    this.name = 'McpCredentialError'
  }
}

export class McpUnsafePathError extends McpError {
  constructor(message: string) {
    super('UNSAFE_PATH', message)
    this.name = 'McpUnsafePathError'
  }
}

export class McpTransportError extends McpError {
  constructor(message: string, options?: { uncertainOutcome?: boolean }) {
    super('TRANSPORT_ERROR', message, options)
    this.name = 'McpTransportError'
  }
}

export class McpProtocolError extends McpError {
  constructor(message: string) {
    super('PROTOCOL_ERROR', message)
    this.name = 'McpProtocolError'
  }
}

export class McpTimeoutError extends McpError {
  constructor(message = 'MCP request timed out', options?: { uncertainOutcome?: boolean }) {
    super('TIMEOUT', message, options)
    this.name = 'McpTimeoutError'
  }
}

export class McpCancelledError extends McpError {
  constructor(message = 'MCP request was cancelled', options?: { uncertainOutcome?: boolean }) {
    super('CANCELLED', message, options)
    this.name = 'McpCancelledError'
  }
}

export class McpToolExecutionError extends McpError {
  constructor(message: string) {
    super('TOOL_EXECUTION_ERROR', message)
    this.name = 'McpToolExecutionError'
  }
}

export class McpStorageCorruptionError extends McpError {
  constructor(message: string) {
    super('STORAGE_CORRUPTION', message)
    this.name = 'McpStorageCorruptionError'
  }
}

export class McpStorageError extends McpError {
  constructor(message: string) {
    super('STORAGE_ERROR', message)
    this.name = 'McpStorageError'
  }
}
