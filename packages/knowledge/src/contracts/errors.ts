export type KnowledgeErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNSUPPORTED_FORMAT'
  | 'AUTHORIZATION_ERROR'
  | 'NOT_FOUND'
  | 'DUPLICATE_DOCUMENT'
  | 'CREDENTIAL_DETECTED'
  | 'UNSAFE_PATH'
  | 'STORAGE_CORRUPTION'
  | 'STORAGE_ERROR'

export class KnowledgeError extends Error {
  readonly code: KnowledgeErrorCode

  constructor(code: KnowledgeErrorCode, message: string) {
    super(message)
    this.name = 'KnowledgeError'
    this.code = code
  }
}

export class KnowledgeValidationError extends KnowledgeError {
  constructor(message: string) {
    super('VALIDATION_ERROR', message)
    this.name = 'KnowledgeValidationError'
  }
}

export class KnowledgeUnsupportedFormatError extends KnowledgeError {
  constructor(message: string) {
    super('UNSUPPORTED_FORMAT', message)
    this.name = 'KnowledgeUnsupportedFormatError'
  }
}

export class KnowledgeAuthorizationError extends KnowledgeError {
  constructor(message = 'Knowledge operation is not authorized for the supplied scope') {
    super('AUTHORIZATION_ERROR', message)
    this.name = 'KnowledgeAuthorizationError'
  }
}

export class KnowledgeNotFoundError extends KnowledgeError {
  constructor(message = 'Knowledge resource not found or not accessible') {
    super('NOT_FOUND', message)
    this.name = 'KnowledgeNotFoundError'
  }
}

export class KnowledgeDuplicateError extends KnowledgeError {
  constructor(message = 'An active document with identical content fingerprint already exists in this scope') {
    super('DUPLICATE_DOCUMENT', message)
    this.name = 'KnowledgeDuplicateError'
  }
}

export class KnowledgeCredentialError extends KnowledgeError {
  constructor(message = 'Knowledge input rejected because it matches a recognized credential pattern') {
    super('CREDENTIAL_DETECTED', message)
    this.name = 'KnowledgeCredentialError'
  }
}

export class KnowledgeUnsafePathError extends KnowledgeError {
  constructor(message: string) {
    super('UNSAFE_PATH', message)
    this.name = 'KnowledgeUnsafePathError'
  }
}

export class KnowledgeStorageCorruptionError extends KnowledgeError {
  constructor(message: string) {
    super('STORAGE_CORRUPTION', message)
    this.name = 'KnowledgeStorageCorruptionError'
  }
}

export class KnowledgeStorageError extends KnowledgeError {
  constructor(message: string) {
    super('STORAGE_ERROR', message)
    this.name = 'KnowledgeStorageError'
  }
}
