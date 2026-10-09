/**
 * Session-query service error containment and model-safe translation.
 *
 * @module @deepseek-ai/dsh-tool-session-query/service-boundary
 */

import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import {
  SessionQueryError,
  type SessionQueryErrorCode,
} from '@deepseek-ai/dsh-session-query'

interface ModelSafeServiceFailure {
  readonly code: SessionQueryErrorCode | 'SESSION_QUERY_TOOL_FAILED'
  readonly message: string
}

const UNPRINTABLE_SERVICE_ERROR = '[unprintable session query failure]'

const SAFE_SESSION_QUERY_FAILURES = {
  SESSION_QUERY_ABORTED: {
    code: 'SESSION_QUERY_ABORTED',
    message: 'session query was cancelled',
  },
  SESSION_QUERY_CORRUPT_SESSION: {
    code: 'SESSION_QUERY_CORRUPT_SESSION',
    message: 'session event history is corrupt',
  },
  SESSION_QUERY_EVENT_NOT_FOUND: {
    code: 'SESSION_QUERY_EVENT_NOT_FOUND',
    message: 'session event was not found',
  },
  SESSION_QUERY_INDEX_FAILED: {
    code: 'SESSION_QUERY_INDEX_FAILED',
    message: 'session search index is unavailable',
  },
  SESSION_QUERY_INVALID_CONFIG: {
    code: 'SESSION_QUERY_TOOL_FAILED',
    message: 'session query operation failed',
  },
  SESSION_QUERY_INVALID_CURSOR: {
    code: 'SESSION_QUERY_INVALID_CURSOR',
    message: 'session search continuation is invalid',
  },
  SESSION_QUERY_INVALID_FILTER: {
    code: 'SESSION_QUERY_INVALID_FILTER',
    message: 'session query filters were rejected',
  },
  SESSION_QUERY_INVALID_LIMIT: {
    code: 'SESSION_QUERY_INVALID_LIMIT',
    message: 'session query result limit was rejected',
  },
  SESSION_QUERY_INVALID_QUERY: {
    code: 'SESSION_QUERY_INVALID_QUERY',
    message: 'session query was rejected',
  },
  SESSION_QUERY_INVALID_LINEAGE: {
    code: 'SESSION_QUERY_INVALID_LINEAGE',
    message: 'session lineage is invalid',
  },
  SESSION_QUERY_INVALID_SURFACE: {
    code: 'SESSION_QUERY_INVALID_SURFACE',
    message: 'session event history is invalid',
  },
  SESSION_QUERY_INVALID_WINDOW: {
    code: 'SESSION_QUERY_INVALID_WINDOW',
    message: 'session event window is invalid',
  },
  SESSION_QUERY_PERSISTENCE_FAILED: {
    code: 'SESSION_QUERY_PERSISTENCE_FAILED',
    message: 'session history storage is unavailable',
  },
  SESSION_QUERY_SEARCH_DISABLED: {
    code: 'SESSION_QUERY_SEARCH_DISABLED',
    message: 'session search is disabled in this deployment',
  },
  SESSION_QUERY_SESSION_NOT_FOUND: {
    code: 'SESSION_QUERY_SESSION_NOT_FOUND',
    message: 'session was not found',
  },
  SESSION_QUERY_STALE_CURSOR: {
    code: 'SESSION_QUERY_STALE_CURSOR',
    message: 'session history changed while paging; retry the complete search call',
  },
  SESSION_QUERY_SOURCE_CONFLICT: {
    code: 'SESSION_QUERY_TOOL_FAILED',
    message: 'session query operation failed',
  },
} satisfies Record<SessionQueryErrorCode, ModelSafeServiceFailure>

function unauthorizedTarget(): HarnessError {
  return new HarnessError(
    'session target is outside the caller workspace',
    'SESSION_QUERY_TOOL_UNAUTHORIZED',
  )
}

async function call<Value>(
  ctx: Context,
  signal: AbortSignal,
  operation: string,
  invoke: () => Promise<Value>,
): Promise<Value> {
  signal.throwIfAborted()
  try {
    const value = await invoke()
    signal.throwIfAborted()
    return value
  } catch (error: unknown) {
    signal.throwIfAborted()
    throw sanitizeError(ctx, operation, error)
  }
}

function sanitizeError(
  ctx: Context,
  operation: string,
  error: unknown,
): HarnessError {
  const generic = genericFailure()
  const diagnostic = fullError(error)
  try {
    ctx.logger.warn(`tool-session-query: ${operation} failed: ${diagnostic}`)
    if (error instanceof SessionQueryError) {
      const code: unknown = error.code
      const failure = typeof code === 'string' && Object.hasOwn(SAFE_SESSION_QUERY_FAILURES, code)
        ? SAFE_SESSION_QUERY_FAILURES[code as SessionQueryErrorCode]
        : undefined
      if (failure !== undefined && failure.code !== 'SESSION_QUERY_TOOL_FAILED') {
        return new SessionQueryError(failure.message, failure.code)
      }
    }
    if (error instanceof HarnessError && error.code === 'SESSION_QUERY_TOOL_UNAUTHORIZED') {
      return unauthorizedTarget()
    }
  } catch {
    return generic
  }
  return generic
}

function genericFailure(): HarnessError {
  return new HarnessError(
    'session query operation failed',
    'SESSION_QUERY_TOOL_FAILED',
  )
}

function fullError(error: unknown): string {
  try {
    return renderFullError(error)
  } catch {
    return UNPRINTABLE_SERVICE_ERROR
  }
}

function renderFullError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const diagnostics: string[] = []
  const seen = new Set<Error>()
  let current: unknown = error
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current)
    diagnostics.push(current.stack ?? String(current))
    current = current.cause
  }
  /* v8 ignore next -- defensive containment for a cyclic Error.cause graph */
  if (current instanceof Error) diagnostics.push('[circular error cause]')
  else if (current !== undefined) diagnostics.push(renderFullError(current))
  return diagnostics.join('\nCaused by: ')
}

/** Model-safe session-query invocation and error translation boundary. */
export const serviceBoundary = {
  unauthorizedTarget,
  call,
  sanitizeError,
}
