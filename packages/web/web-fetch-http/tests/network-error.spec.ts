import { describe, expect, it, vi } from 'vitest'
import { HttpFetchProvider } from '@deepseek-ai/dsh-web-fetch-http'

const failure = vi.hoisted((): { value: unknown } => ({ value: undefined }))

vi.mock('undici', () => ({
  fetch: async () => { throw failure.value },
}))

const provider = new HttpFetchProvider({
  maxResponseBytes: 1_000,
  maxBodyChars: 1_000,
  timeoutMs: 5_000,
  maxRedirects: 0,
  userAgent: 'test-agent/1.0',
})

async function messageFor(error: unknown): Promise<string> {
  failure.value = error
  const rejection = await provider.fetch({ url: 'http://origin.test/' }).then(() => undefined, (thrown: unknown) => thrown)
  expect(rejection).toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
  return (rejection as Error).message
}

describe('HttpFetchProvider transport failure text', () => {
  it('names every address of a multi-address connection failure', async () => {
    const attempts = new AggregateError([
      new Error('connect ECONNREFUSED ::1:8080'),
      new Error('connect ECONNREFUSED 127.0.0.1:8080'),
    ])
    expect(await messageFor(new TypeError('fetch failed', { cause: attempts })))
      .toBe('web fetch failed: connect ECONNREFUSED ::1:8080; connect ECONNREFUSED 127.0.0.1:8080')
  })

  it('names a DNS failure', async () => {
    const dns = new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND origin.test') })
    expect(await messageFor(dns)).toBe('web fetch failed: getaddrinfo ENOTFOUND origin.test')
  })

  it('stringifies a non-Error rejection', async () => {
    expect(await messageFor('socket closed')).toBe('web fetch failed: socket closed')
  })

  it('stringifies a non-Error innermost cause', async () => {
    expect(await messageFor(new TypeError('fetch failed', { cause: 'socket closed' }))).toBe('web fetch failed: socket closed')
  })

  it('cuts a cyclic cause chain', async () => {
    const first = new Error('first')
    const second = new Error('second', { cause: first })
    first.cause = second
    expect(await messageFor(first)).toBe('web fetch failed: first')
  })

  it('names exactly four attempts without a count', async () => {
    const attempts = new AggregateError([1, 2, 3, 4].map(n => new Error(`attempt ${n}`)))
    expect(await messageFor(new TypeError('fetch failed', { cause: attempts })))
      .toBe('web fetch failed: attempt 1; attempt 2; attempt 3; attempt 4')
  })

  it('names four of five attempts and counts the rest', async () => {
    const attempts = new AggregateError([1, 2, 3, 4, 5].map(n => new Error(`attempt ${n}`)))
    expect(await messageFor(new TypeError('fetch failed', { cause: attempts })))
      .toBe('web fetch failed: attempt 1; attempt 2; attempt 3; attempt 4; 1 more')
  })

  it('follows four cause hops', async () => {
    let chain = new Error('hop 0')
    for (let hop = 1; hop <= 5; hop++) chain = new Error(`hop ${hop}`, { cause: chain })
    expect(await messageFor(chain)).toBe('web fetch failed: hop 1')
  })

  it('keeps 500 characters of a long reason', async () => {
    expect(await messageFor(new Error('x'.repeat(500)))).toBe(`web fetch failed: ${'x'.repeat(500)}`)
    expect(await messageFor(new Error('x'.repeat(501)))).toBe(`web fetch failed: ${'x'.repeat(500)}…`)
  })

  it('does not expand an AggregateError nested in an attempt', async () => {
    const inner = new AggregateError([new Error('deep')], 'inner attempts')
    expect(await messageFor(new AggregateError([inner]))).toBe('web fetch failed: inner attempts')
  })

  it('falls back to the rejection when the innermost message is empty', async () => {
    expect(await messageFor(new TypeError('fetch failed', { cause: new AggregateError([]) })))
      .toBe('web fetch failed: TypeError: fetch failed')
  })
})
