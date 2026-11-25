export type MemoryErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNSUPPORTED_ORIGIN'
  | 'AUTHORIZATION_ERROR'
  | 'NOT_FOUND'
  | 'DUPLICATE_MEMORY'
  | 'CREDENTIAL_DETECTED'
  | 'UNSAFE_STORAGE_PATH'
  | 'STORAGE_CORRUPTION'
  | 'STORAGE_ERROR'

export class MemoryError extends Error {
  readonly code: MemoryErrorCode

  constructor(code: MemoryErrorCode, message: string) {
    super(message)
    this.name = 'MemoryError'
    this.code = code
  }
}

export class MemoryValidationError extends MemoryError {
  constructor(message: string) {
    super('VALIDATION_ERROR', message)
    this.name = 'MemoryValidationError'
  }
}

export class MemoryUnsupportedOriginError extends MemoryError {
  constructor(message = 'Automatic or inferred memory creation is disabled in Phase 3A') {
    super('UNSUPPORTED_ORIGIN', message)
    this.name = 'MemoryUnsupportedOriginError'
  }
}

export class MemoryAuthorizationError extends MemoryError {
  constructor(message = 'Memory operation is not authorized for the supplied scope') {
    super('AUTHORIZATION_ERROR', message)
    this.name = 'MemoryAuthorizationError'
  }
}

export class MemoryNotFoundError extends MemoryError {
  constructor(message = 'Memory record not found or not accessible') {
    super('NOT_FOUND', message)
    this.name = 'MemoryNotFoundError'
  }
}

export class MemoryDuplicateError extends MemoryError {
  constructor(message = 'An active memory with identical normalized content already exists in this scope') {
    super('DUPLICATE_MEMORY', message)
    this.name = 'MemoryDuplicateError'
  }
}

export class MemoryCredentialError extends MemoryError {
  constructor(message = 'Memory content rejected because it matches a recognized credential pattern') {
    super('CREDENTIAL_DETECTED', message)
    this.name = 'MemoryCredentialError'
  }
}

export class MemoryUnsafePathError extends MemoryError {
  constructor(message: string) {
    super('UNSAFE_STORAGE_PATH', message)
    this.name = 'MemoryUnsafePathError'
  }
}

export class MemoryStorageCorruptionError extends MemoryError {
  constructor(message: string) {
    super('STORAGE_CORRUPTION', message)
    this.name = 'MemoryStorageCorruptionError'
  }
}

export class MemoryStorageError extends MemoryError {
  constructor(message: string) {
    super('STORAGE_ERROR', message)
    this.name = 'MemoryStorageError'
  }
}
