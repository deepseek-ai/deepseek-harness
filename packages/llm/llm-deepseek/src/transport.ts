/** Normalize HTTP and in-band Messages errors into provider-neutral failures. */

import { isContextWindowExceededError, isQuotaExceededError, LlmError, ProviderRequestId } from '@deepseek-ai/dsh-llm'

/** Read only provider error fields used by bounded Files recovery.
 * @param raw - decoded HTTP error response.
 * @returns code, type, and message text, without unrelated response fields.
 */
export function providerErrorDetail(raw: unknown): string {
  const error = typeof raw === 'object' && raw !== null && 'error' in raw ? raw.error : undefined
  if (typeof error !== 'object' || error === null) return ''
  const fields = error as Record<string, unknown>
  return [fields.code, fields.type, fields.message].filter((value): value is string => typeof value === 'string').join(' ')
}

/** Classify a provider error without trusting arbitrary response fields.
 * @param raw - decoded response or in-band error event.
 * @param status - HTTP status when the error preceded streaming.
 * @param headers - response headers for retry delay and request identity.
 * @returns a stable error consumed by LlmRuntime and llm-retry.
 */
export function providerError(raw: unknown, status: number | undefined, headers?: Headers): LlmError {
  const envelope = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
  const error = typeof envelope.error === 'object' && envelope.error !== null ? envelope.error as Record<string, unknown> : {}
  const message = typeof error.message === 'string' ? error.message : `DeepSeek Messages request failed (${status ?? 'stream error'})`
  const type = typeof error.type === 'string' ? error.type : ''
  const detail = `${type} ${typeof error.code === 'string' ? error.code : ''} ${message}`
  let code: string
  if (status === 401 || status === 403 || ['authentication_error', 'permission_error'].includes(type)) code = 'AUTH'
  else if (isQuotaExceededError(detail) || status === 402) code = 'QUOTA'
  else if (status === 429 || type === 'rate_limit_error') code = 'RATE_LIMIT'
  else if (isContextWindowExceededError(detail)) code = 'CONTEXT_WINDOW_EXCEEDED'
  else if (status === 400 || status === 413 || type === 'invalid_request_error') code = 'INVALID_REQUEST'
  else if ((status !== undefined && status >= 500) || ['api_error', 'overloaded_error'].includes(type)) code = 'SERVER'
  else code = status === undefined ? 'SERVER' : `HTTP_${status}`
  const retry = headers?.get('retry-after')
  const delay = retry == null ? NaN : /^\d+(?:\.\d+)?$/u.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now()
  const id = headers?.get('request-id') ?? headers?.get('x-request-id') ?? headers?.get('x-deepseek-request-id')
  return new LlmError(message, code, {
    ...status === undefined ? {} : { status },
    ...id ? { requestId: ProviderRequestId(id) } : {},
    ...Number.isFinite(delay) && delay > 0 ? { providerRetryAfterMs: delay } : {},
  })
}
