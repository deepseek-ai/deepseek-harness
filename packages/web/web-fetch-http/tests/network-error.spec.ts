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

/** A Node-style system error carrying `code`. */
function systemError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code })
}

/** Undici's generic rejection around a cause. */
function fetchFailed(cause: unknown): TypeError {
  return new TypeError('fetch failed', { cause })
}

async function rejectionFor(error: unknown): Promise<{ code: string; message: string }> {
  failure.value = error
  const rejection = await provider.fetch({ url: 'http://origin.test/' }).then(() => undefined, (thrown: unknown) => thrown)
  expect(rejection).toBeInstanceOf(Error)
  const { code, message } = rejection as Error & { code: string }
  return { code, message }
}

describe('HttpFetchProvider transport failure classes', () => {
  it.each([
    ['getaddrinfo ENOTFOUND origin.test', 'ENOTFOUND', 'WEB_FETCH_DNS_FAILED', 'could not resolve the host name'],
    ['getaddrinfo EAI_AGAIN origin.test', 'EAI_AGAIN', 'WEB_FETCH_DNS_FAILED', 'could not resolve the host name'],
    ['connect ECONNREFUSED 127.0.0.1:8080', 'ECONNREFUSED', 'WEB_FETCH_CONNECTION_REFUSED', 'the server refused the connection'],
    ['Connect Timeout Error', 'UND_ERR_CONNECT_TIMEOUT', 'WEB_FETCH_CONNECTION_TIMEOUT', 'the connection timed out'],
    ['read ETIMEDOUT', 'ETIMEDOUT', 'WEB_FETCH_CONNECTION_TIMEOUT', 'the connection timed out'],
    ['Hostname mismatch', 'HOSTNAME_MISMATCH', 'WEB_FETCH_CERTIFICATE_INVALID', 'the server certificate could not be verified'],
    ['self-signed certificate', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'WEB_FETCH_CERTIFICATE_INVALID', 'the server certificate could not be verified'],
    ['certificate has expired', 'CERT_HAS_EXPIRED', 'WEB_FETCH_CERTIFICATE_INVALID', 'the server certificate could not be verified'],
    ["Hostname/IP does not match certificate's altnames", 'ERR_TLS_CERT_ALTNAME_INVALID', 'WEB_FETCH_CERTIFICATE_INVALID', 'the server certificate could not be verified'],
    ['read ECONNRESET', 'ECONNRESET', 'WEB_FETCH_CONNECTION_INTERRUPTED', 'the connection was interrupted'],
    ['other side closed', 'UND_ERR_SOCKET', 'WEB_FETCH_CONNECTION_INTERRUPTED', 'the connection was interrupted'],
    ['connect ENETUNREACH 10.0.0.1:443', 'ENETUNREACH', 'WEB_FETCH_NETWORK_UNREACHABLE', 'the network or host is unreachable'],
    ['connect EHOSTUNREACH 10.0.0.1:443', 'EHOSTUNREACH', 'WEB_FETCH_NETWORK_UNREACHABLE', 'the network or host is unreachable'],
  ])('classifies %s', async (detail, systemCode, code, summary) => {
    expect(await rejectionFor(fetchFailed(systemError(detail, systemCode)))).toEqual({
      code,
      message: `web fetch failed: ${summary} (${systemCode}): ${detail}`,
    })
  })

  it('reports an unrecognized system code as a generic network failure that keeps the code', async () => {
    expect(await rejectionFor(fetchFailed(systemError('write EPROTO', 'EPROTO')))).toEqual({
      code: 'WEB_FETCH_NETWORK_ERROR',
      message: 'web fetch failed: the network request failed (EPROTO): write EPROTO',
    })
  })

  it('ignores a non-string code', async () => {
    expect(await rejectionFor(fetchFailed(Object.assign(new Error('socket hang up'), { code: -54 })))).toEqual({
      code: 'WEB_FETCH_NETWORK_ERROR',
      message: 'web fetch failed: the network request failed: socket hang up',
    })
  })

  it('reports a failure without a system code as a generic network failure', async () => {
    expect(await rejectionFor(fetchFailed(new Error('bad port')))).toEqual({
      code: 'WEB_FETCH_NETWORK_ERROR',
      message: 'web fetch failed: the network request failed: bad port',
    })
  })
})

describe('HttpFetchProvider multi-address transport failures', () => {
  it('classifies attempts that share one class and names each address', async () => {
    const attempts = new AggregateError([
      systemError('connect ECONNREFUSED ::1:8080', 'ECONNREFUSED'),
      systemError('connect ECONNREFUSED 127.0.0.1:8080', 'ECONNREFUSED'),
    ])
    expect(await rejectionFor(fetchFailed(attempts))).toEqual({
      code: 'WEB_FETCH_CONNECTION_REFUSED',
      message: 'web fetch failed: the server refused the connection (ECONNREFUSED): connect ECONNREFUSED ::1:8080; connect ECONNREFUSED 127.0.0.1:8080',
    })
  })

  it('classifies an unreachable address family attempt by the other attempts', async () => {
    const attempts = new AggregateError([
      systemError('connect ENETUNREACH 2001:db8::1:443', 'ENETUNREACH'),
      systemError('connect ECONNREFUSED 192.0.2.1:443', 'ECONNREFUSED'),
    ])
    expect(await rejectionFor(fetchFailed(attempts))).toEqual({
      code: 'WEB_FETCH_CONNECTION_REFUSED',
      message: 'web fetch failed: the server refused the connection: connect ENETUNREACH 2001:db8::1:443; connect ECONNREFUSED 192.0.2.1:443',
    })
  })

  it('does not classify attempts of two other classes', async () => {
    const attempts = new AggregateError([
      systemError('connect ETIMEDOUT 2001:db8::1:443', 'ETIMEDOUT'),
      systemError('connect ECONNREFUSED 192.0.2.1:443', 'ECONNREFUSED'),
    ])
    expect(await rejectionFor(fetchFailed(attempts))).toEqual({
      code: 'WEB_FETCH_NETWORK_ERROR',
      message: 'web fetch failed: the network request failed: connect ETIMEDOUT 2001:db8::1:443; connect ECONNREFUSED 192.0.2.1:443',
    })
  })

  it('names exactly four attempts without a count', async () => {
    const attempts = new AggregateError([1, 2, 3, 4].map(n => new Error(`attempt ${n}`)))
    expect((await rejectionFor(fetchFailed(attempts))).message)
      .toBe('web fetch failed: the network request failed: attempt 1; attempt 2; attempt 3; attempt 4')
  })

  it('names four of five attempts and counts the rest', async () => {
    const attempts = new AggregateError([1, 2, 3, 4, 5].map(n => new Error(`attempt ${n}`)))
    expect((await rejectionFor(fetchFailed(attempts))).message)
      .toBe('web fetch failed: the network request failed: attempt 1; attempt 2; attempt 3; attempt 4; 1 more')
  })

  it('does not expand an AggregateError nested in an attempt', async () => {
    const inner = new AggregateError([new Error('deep')], 'inner attempts')
    expect((await rejectionFor(new AggregateError([inner]))).message).toBe('web fetch failed: the network request failed: inner attempts')
  })
})

describe('HttpFetchProvider transport failure detail', () => {
  it('stringifies a non-Error rejection', async () => {
    expect((await rejectionFor('socket closed')).message).toBe('web fetch failed: the network request failed: socket closed')
  })

  it('stringifies a non-Error innermost cause', async () => {
    expect((await rejectionFor(fetchFailed('socket closed'))).message).toBe('web fetch failed: the network request failed: socket closed')
  })

  it('cuts a cyclic cause chain', async () => {
    const first = new Error('first')
    const second = new Error('second', { cause: first })
    first.cause = second
    expect((await rejectionFor(first)).message).toBe('web fetch failed: the network request failed: first')
  })

  it('follows four cause hops', async () => {
    let chain = new Error('hop 0')
    for (let hop = 1; hop <= 5; hop++) chain = new Error(`hop ${hop}`, { cause: chain })
    expect((await rejectionFor(chain)).message).toBe('web fetch failed: the network request failed: hop 1')
  })

  it('falls back to the rejection when the innermost message is empty', async () => {
    expect((await rejectionFor(fetchFailed(new AggregateError([])))).message)
      .toBe('web fetch failed: the network request failed: TypeError: fetch failed')
  })

  it('keeps the full summary and 500 characters of the detail', async () => {
    const long = (length: number) => fetchFailed(systemError('x'.repeat(length), 'ERR_TLS_CERT_ALTNAME_INVALID'))
    const prefix = 'web fetch failed: the server certificate could not be verified (ERR_TLS_CERT_ALTNAME_INVALID): '
    expect((await rejectionFor(long(500))).message).toBe(`${prefix}${'x'.repeat(500)}`)
    expect((await rejectionFor(long(501))).message).toBe(`${prefix}${'x'.repeat(500)}…`)
  })
})
