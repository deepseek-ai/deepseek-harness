/** Safe failure details shared by publication diagnostics and durable journals. */
import { ZodError } from 'zod'
import { DesktopPublishError } from './desktop-publish.ts'

const publicCodes = new Set(['AccessDenied', 'InternalError', 'NoSuchBucket', 'BadDigest', 'SignatureDoesNotMatch',
  'RequestTimeout', 'TimeoutError', 'AbortError', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ENOSPC', 'EACCES', 'EPERM', 'ENOENT'])

/** COS operation failure retaining its cause for safe diagnostics; a failed write may have an unknown remote outcome. */
export class DesktopCosOperationError extends Error {
  constructor(readonly operation: 'GetObject' | 'PutObject', cause: unknown) {
    const failure = desktopPublicationFailure(cause, operation)
    const message = failure.code === 'AccessDenied'
      ? `AccessDenied. Check name/cos:${operation} permission and explicit deny rules for the selected bucket/object. Publication stopped; reconcile remote state before retrying.`
      : failure.message
    super(`COS ${operation}: ${message}`, { cause })
    this.name = 'DesktopCosOperationError'
  }
}

/**
 * Keep actionable local validation details without recording SDK response bodies or credentials.
 * @param error Failure from validation, filesystem, subprocess or remote transport.
 * @param phase Operation stage known by the entrypoint.
 * @returns Credential-free diagnostic suitable for stderr and an audit event.
 */
export function desktopPublicationFailure(error: unknown, phase: string): {
  phase: string
  code: string
  message: string
  operation?: 'GetObject' | 'PutObject'
  requestId?: string
  httpStatus?: number
} {
  if (error instanceof DesktopCosOperationError) {
    const cause = typeof error.cause === 'object' && error.cause !== null ? error.cause : {}
    const requestId = 'RequestId' in cause ? cause.RequestId : undefined
    const status = 'statusCode' in cause ? cause.statusCode : undefined
    return { ...desktopPublicationFailure(error.cause, phase), operation: error.operation, message: error.message,
      ...(typeof requestId === 'string' && /^[\w+/=.-]{1,256}$/u.test(requestId) ? { requestId } : {}),
      ...(typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? { httpStatus: status } : {}) }
  }
  if (error instanceof DesktopPublishError) return { phase, code: error.code, message: error.message }
  if (error instanceof ZodError) return { phase, code: 'invalid-data',
    message: `Invalid fields: ${error.issues.map(issue => `${issue.path.join('.') || '(root)'} (${issue.code})`).join(', ')}` }
  if (error instanceof SyntaxError) return { phase, code: 'invalid-json', message: 'Invalid JSON; check the configuration or retained record for this stage.' }
  const ownedMessage = /^(desktop (?:publish|release store|retention|rollback|tag|upload|auto-update|macOS signing|build)[^\n]*:|Usage:)/u
  if (error instanceof Error && ownedMessage.test(error.message)) {
    return { phase, code: 'validation', message: error.message }
  }
  const record = typeof error === 'object' && error !== null ? error : {}
  const candidate = 'code' in record ? record.code : 'name' in record ? record.name : undefined
  const code = typeof candidate === 'string' && publicCodes.has(candidate) ? candidate : 'operation-failed'
  const status = 'statusCode' in record && typeof record.statusCode === 'number' ? ` (HTTP ${record.statusCode})` : ''
  const path = ['ENOENT', 'EACCES', 'EPERM', 'ENOSPC'].includes(code) && 'path' in record && typeof record.path === 'string'
    ? `: ${record.path}` : ''
  return { phase, code, message: `${code}${status}${path}. Check this stage's local files, signature verification or service permissions; raw provider output is omitted.` }
}
