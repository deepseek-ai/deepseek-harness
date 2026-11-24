/**
 * Error taxonomy of the Lark adapter: the code table, the HTTP-status fallbacks and the `published` verdict
 * dsh-im receipts depend on. Pure unit tests — nothing here touches the network.
 */
import { describe, expect, it } from 'vitest'
import { Http } from '@deepseek-ai/cordis-plugin-http'
import { PlatformError } from '@deepseek-ai/cordis-plugin-im-core'
import { classify, EXPIRED_EDIT_WINDOW, LARK_ERRORS, LarkApiError, ruleFor } from '@deepseek-ai/cordis-plugin-im-adapter-lark'

describe('Lark error table', () => {
  it('maps the frequency limits to rate-limit', () => {
    expect(classify(new LarkApiError('limited', { code: 230020, status: 400 }))).toMatchObject({
      kind: 'rate-limit',
      code: 230020,
      published: 'no',
    })
    expect(classify(new LarkApiError('limited', { code: 11232 })).kind).toBe('rate-limit')
  })

  it('maps the two card-size codes to limit', () => {
    expect(classify(new LarkApiError('big', { code: 230025 })).kind).toBe('limit')
    expect(classify(new LarkApiError('big', { code: 300305 })).kind).toBe('limit')
  })

  it('maps the generic invalid-parameter code to invalid', () => {
    expect(classify(new LarkApiError('bad', { code: 230001, status: 400 })).kind).toBe('invalid')
  })

  it('keeps the platform text of a code the table does not know', () => {
    const error = classify(new LarkApiError('Failed to create card content, ext=ErrCode: 11310; ErrMsg: element exceeds the limit',
      { code: 230099, status: 400 }))
    expect(error).toMatchObject({ kind: 'invalid', published: 'no' })
    expect(error.message).toContain('(230099)')
    expect(error.message).toContain('element exceeds the limit')
  })

  it('maps the mute codes to permission', () => {
    for (const code of [230035, 230018]) {
      expect(classify(new LarkApiError('muted', { code, status: 400 })).kind).toBe('permission')
    }
  })

  it('maps the thread-refusal codes to invalid', () => {
    for (const code of [230054, 230071]) {
      expect(classify(new LarkApiError('no thread', { code, status: 400 })).kind).toBe('invalid')
    }
  })

  it('reads 230075 as an expired edit window', () => {
    const error = classify(new LarkApiError('too late', { code: 230075, status: 400 }))
    // `limit` is what the stream scheduler resolves by recall-and-resend; `invalid` would fail the stream.
    expect(error.kind).toBe('limit')
    expect(error.message).toContain('can no longer be edited')
    expect(error.published).toBe('no')
    expect(EXPIRED_EDIT_WINDOW).toBe(230075)
    expect(ruleFor(EXPIRED_EDIT_WINDOW)?.kind).toBe('limit')
  })

  it('classifies a missing scope as permission', () => {
    const error = classify(new LarkApiError('scope', { code: 99991672, status: 403 }))
    expect(error.kind).toBe('permission')
  })

  it('treats an unknown code as invalid but keeps the code', () => {
    const error = classify(new LarkApiError('odd', { code: 123456, status: 400 }))
    expect(error.kind).toBe('invalid')
    expect(error.code).toBe(123456)
  })

  it('publishes the whole rule table consistently', () => {
    for (const [code, rule] of Object.entries(LARK_ERRORS)) {
      expect(ruleFor(Number(code)), `ruleFor(${code})`).toBe(rule)
      expect(rule.message.length).toBeGreaterThan(0)
      expect(classify(new LarkApiError(rule.message, { code: Number(code) })).kind).toBe(rule.kind)
    }
    expect(ruleFor(0)).toBeUndefined()
  })
})

describe('Lark error classification', () => {
  it('keeps a non-2xx answer published=no and reads Retry-After', () => {
    const error = classify(new LarkApiError('nope', {
      status: 429,
      retryAfterMs: 2000,
      body: { code: 230020 },
    }))
    expect(error.kind).toBe('rate-limit')
    expect(error.retryAfterMs).toBe(2000)
    expect(error.published).toBe('no')
  })

  it('leaves a 5xx answer retryable and publication unknown', () => {
    const error = classify(new LarkApiError('down', { status: 503 }))
    expect(error.kind).toBe('retryable')
    expect(error.published).toBe('unknown')
  })

  it('treats a transport failure as retryable with unknown publication', () => {
    const error = classify(new LarkApiError('GET /im/v1/messages failed: fetch failed', { cause: new Error('fetch failed') }))
    expect(error.kind).toBe('retryable')
    expect(error.published).toBe('unknown')
  })

  it('classifies an HTTP answer that carried no platform code by its status', () => {
    const response = new Response('teapot', { status: 404 })
    const error = classify(Object.assign(new Error('not found'), { response }))
    expect(error.kind).toBe('not-found')
    expect(error.published).toBe('no')

    const prohibited = classify(Object.assign(new Error('nope'), { response: new Response(null, { status: 403 }) }))
    expect(prohibited.kind).toBe('permission')

    const broken = classify(Object.assign(new Error('boom'), { response: new Response(null, { status: 502 }) }))
    expect(broken.kind).toBe('retryable')
    expect(broken.published).toBe('unknown')

    const throttled = classify(Object.assign(new Error('slow down'), {
      response: new Response(null, { status: 429, headers: { 'retry-after': '3' } }),
    }))
    expect(throttled.kind).toBe('rate-limit')
    expect(throttled.retryAfterMs).toBe(3000)

    const rejected = classify(Object.assign(new Error('bad'), { response: new Response(null, { status: 400 }) }))
    expect(rejected.kind).toBe('invalid')
    expect(rejected.published).toBe('no')
  })

  it('classifies anything without an answer as retryable', () => {
    const error = classify(new Error('socket hang up'))
    expect(error.kind).toBe('retryable')
    expect(error.published).toBe('unknown')
    expect(error.message).toBe('socket hang up')
    expect(classify(undefined).message).toBe('Lark request failed')
  })

  it('never turns a cancellation into a retry and leaves its publication unknown', () => {
    const abort = new DOMException('The operation was aborted', 'AbortError')
    // Nothing in this path proves the request never left: it may have been written and answered before the cancel.
    expect(classify(abort)).toMatchObject({ kind: 'fatal', published: 'unknown' })
    // A cancellation wrapped by the transport is still a cancellation, with the same unknown publication.
    expect(classify(new LarkApiError('wrapped', { cause: abort }))).toMatchObject({
      kind: 'fatal', published: 'unknown',
    })
    // Only a verdict the thrown error carries itself is kept.
    expect(classify(new LarkApiError('wrapped', { published: 'no', cause: abort }))).toMatchObject({
      kind: 'fatal', published: 'no',
    })
  })

  it('passes an already classified error through', () => {
    const original = new PlatformError('limit', 'too big')
    expect(classify(original)).toBe(original)
  })

  it('keeps the platform message and cause for diagnostics', () => {
    const cause = new Error('underlying')
    const error = classify(new LarkApiError('answer', { code: 230017, status: 400, cause }))
    expect(error.message).toMatch(/uploaded by another application/)
    expect(error.cause).toBeInstanceOf(LarkApiError)
    expect((error.cause as LarkApiError).cause).toBe(cause)
  })

  it('recognises the transport error the HTTP plugin raises for a bad status', () => {
    // `Http.Error` carries the response and its status; classification must not depend on the class identity.
    const error = new Http.Error('Unauthorized', 'STATUS_ERROR', new Response(null, { status: 401 }))
    expect(classify(error).kind).toBe('permission')
  })

  it('classifies a non-global ResponseLike (undici) response with its status and Retry-After', () => {
    const classified = classify({
      response: {
        status: 429,
        headers: { get: (name: string) => name.toLowerCase() === 'retry-after' ? '4' : null },
      },
    })
    expect(classified).toMatchObject({ kind: 'rate-limit', published: 'no', retryAfterMs: 4000 })
  })
})
