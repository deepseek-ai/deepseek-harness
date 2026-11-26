/**
 * Error classification of : the platform code table, the `304…` quota family, HTTP-status fallbacks and the
 * `published` verdict that dsh-im receipts depend on.
 */
import { describe, expect, it } from 'vitest'
import { PlatformError } from '@deepseek-ai/cordis-plugin-im-core'
import { classify, ruleFor, QQ_ERRORS, QqApiError } from '@deepseek-ai/cordis-plugin-im-adapter-qq'

/** A QqApiError as the REST client raises one. */
function apiError(code: number | undefined, status: number | undefined = 400) {
  return new QqApiError(`code ${code}`, { code, status, body: { code, message: 'platform message' } })
}

/** A transport failure shaped like the HTTP plugin's (`HttpError` carries `response`). */
function transportError(status: number, headers: Record<string, string> = {}) {
  const error = new Error(`HTTP ${status}`) as Error & { response?: Response }
  error.response = new Response(null, { status, headers })
  return error
}

describe('QQ error table', () => {
  const table: [number, string][] = [
    [40054005, 'invalid'],
    [40054010, 'invalid'],
    [40034029, 'invalid'],
    [40054002, 'permission'],
    [40054004, 'permission'],
    [40054013, 'permission'],
    [11253, 'permission'],
    [40054007, 'limit'],
    [40054018, 'limit'],
    [304103, 'invalid'],
    [40034005, 'invalid'],
    [304023, 'invalid'],
    [304004, 'invalid'],
    [22009, 'rate-limit'],
    [40034100, 'rate-limit'],
    [40034105, 'permission'],
    [40034128, 'invalid'],
    [40034025, 'invalid'],
  ]

  it.each(table)('classifies %i as %s', (code, kind) => {
    const error = classify(apiError(code))
    expect(error).toBeInstanceOf(PlatformError)
    expect(error.kind).toBe(kind)
    expect(error.code).toBe(code)
    expect(error.published).toBe('no')
    expect(error.message.length).toBeGreaterThan(0)
  })

  it('treats the 304… quota family as rate-limit', () => {
    expect(ruleFor(304500)?.kind).toBe('rate-limit')
    expect(classify(apiError(304500)).kind).toBe('rate-limit')
    // The explicit entries inside that range keep their own rule.
    expect(ruleFor(304103)?.kind).toBe('invalid')
  })

  it('knows no rule for codes outside the table and the quota range', () => {
    expect(ruleFor(12345)).toBeUndefined()
    const error = classify(apiError(12345))
    expect(error.kind).toBe('invalid')
    expect(error.code).toBe(12345)
    expect(error.published).toBe('no')
  })

  it('keeps the platform sentence for a code the table does not list', () => {
    // The client put the platform's code and text into the error; an unlisted code must reach the operator with them
    // instead of behind the anonymous status rule.
    const sentence = 'POST /v2/groups/G/messages answered 400 (code 40034111: 主动消息失败, 无权限)'
    const error = classify(new QqApiError(sentence, {
      code: 40034111,
      status: 400,
      body: { code: 40034111, message: '主动消息失败, 无权限' },
    }))
    expect(error.kind).toBe('invalid')
    expect(error.code).toBe(40034111)
    expect(error.message).toBe(sentence)
    // A status-only refusal keeps the status rule's own sentence.
    expect(classify(apiError(undefined, 400)).message).toBe('the platform rejected the request')
  })

  it('covers every documented code with a non-empty message', () => {
    for (const [code, rule] of Object.entries(QQ_ERRORS)) {
      expect(rule.message, code).not.toHaveLength(0)
    }
  })
})

describe('classify fallbacks', () => {
  it('maps a status-only answer', () => {
    expect(classify(apiError(undefined, 401)).kind).toBe('permission')
    expect(classify(apiError(undefined, 403)).kind).toBe('permission')
    expect(classify(apiError(undefined, 404)).kind).toBe('not-found')
    expect(classify(apiError(undefined, 429)).kind).toBe('rate-limit')
    expect(classify(apiError(undefined, 400)).kind).toBe('invalid')
  })

  it('leaves publication unknown for a 5xx and never retries a rejection', () => {
    const error = classify(apiError(undefined, 502))
    expect(error.kind).toBe('retryable')
    expect(error.published).toBe('unknown')
  })

  it('maps a transport-level HTTP failure through its response', () => {
    const throttled = classify(transportError(429, { 'retry-after': '2' }))
    expect(throttled.kind).toBe('rate-limit')
    expect(throttled.retryAfterMs).toBe(2000)
    expect(throttled.published).toBe('no')

    expect(classify(transportError(500)).kind).toBe('retryable')
    expect(classify(transportError(500)).published).toBe('unknown')
    expect(classify(transportError(401)).kind).toBe('permission')
  })

  it('treats a network failure as a retryable, possibly published request', () => {
    const error = classify(new Error('socket hang up'))
    expect(error.kind).toBe('retryable')
    expect(error.published).toBe('unknown')
    expect(error.message).toBe('socket hang up')
  })

  it('treats a failure without a message or response as retryable', () => {
    const error = classify('boom')
    expect(error.kind).toBe('retryable')
    expect(error.message).toBe('QQ request failed')
  })

  it('keeps a transport failure retryable even when the client wrapped it', () => {
    const wrapped = new QqApiError('POST /v2/groups/G/messages failed: socket hang up', { cause: new Error('socket hang up') })
    const error = classify(wrapped)
    expect(error.kind).toBe('retryable')
    expect(error.published).toBe('unknown')
    expect(error.message).toMatch(/socket hang up/)
  })

  it('never retries a cancellation, and leaves its publication unknown', () => {
    const abort = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
    expect(classify(abort).kind).toBe('fatal')
    // Nothing in this path proves the request never left: it may have been written and answered before the cancel.
    expect(classify(abort).published).toBe('unknown')
    expect(classify(new QqApiError('wrapped', { cause: abort }))).toMatchObject({
      kind: 'fatal', published: 'unknown',
    })
    // Only a verdict the thrown error carries itself is kept.
    expect(classify(new QqApiError('wrapped', { published: 'no', cause: abort }))).toMatchObject({
      kind: 'fatal', published: 'no',
    })
  })

  it('passes an already classified PlatformError through unchanged', () => {
    const original = new PlatformError('rate-limit', 'slow down', { code: 22009 })
    expect(classify(original)).toBe(original)
    expect(classify(original)).toBeInstanceOf(PlatformError)
  })

  it('honours an explicit publication verdict over the derived one', () => {
    const error = classify(new QqApiError('no id', { status: 200, published: 'unknown' }))
    expect(error.kind).toBe('invalid')
    expect(error.published).toBe('unknown')
  })
})
