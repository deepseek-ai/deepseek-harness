import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountClientMetadata } from '@deepseek-ai/dsh-deepseek-account/types'
import { DesktopMandatoryUpdatePolicy, desktopPolicyPage, resolveDesktopPolicyConfig, type DesktopPolicyState } from '../src/mandatory-update-policy.ts'

const identity = { platform: 'win32', arch: 'x64', bundledDshVersion: '0.1.5-rc.1' } as const
const client: AccountClientMetadata = { version: '1.2.3', locale: 'zh-CN', timezoneOffsetSeconds: 28_800 }
const force = { code: 40005, data: { show_content: { title: '<b>Update</b>', detail: 'Required upgrade' },
  desktop_app_link: 'https://downloads.example.com/desktop?os=win' } }
const clear = { code: 0, msg: '', data: { biz_code: 0, biz_msg: '', biz_data: null } }
const deployment = { origin: 'https://policy.example.com', allowedPageOrigins: ['https://downloads.example.com'],
  intervalMs: 10_000, timeoutMs: 1_000, maxBackoffMs: 80_000, jitter: 0 }
const instances: DesktopMandatoryUpdatePolicy[] = []

function fixture(authentication: 'anonymous' | 'feishu-test' = 'anonymous',
  clientSource: () => AccountClientMetadata = () => client) {
  const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json(clear))
  const publish = vi.fn<(state: DesktopPolicyState) => void>()
  const policy = new DesktopMandatoryUpdatePolicy(resolveDesktopPolicyConfig({ ...deployment, authentication, ...(authentication === 'feishu-test' ? { allowedAuthOrigins: ['https://login.example.com'] } : {}) })!,
    identity, publish, request, clientSource)
  instances.push(policy)
  return { policy, request, publish }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(async () => {
  await Promise.all(instances.splice(0).map(policy => policy.dispose()))
  vi.useRealTimers()
})

describe('mandatory update policy', () => {
  it('retains a known block through test authentication expiry and rejects 422 as a policy decision', async () => {
    const { policy, request } = fixture('feishu-test')
    request.mockResolvedValueOnce(Response.json(force)).mockResolvedValueOnce(Response.json({
      error: { code: 'UNAUTHENTICATED', login_url: 'https://untrusted.example/' },
    }, { status: 401 })).mockResolvedValueOnce(Response.json({ detail: [] }, { status: 422 }))
    await policy.check('launch')
    expect(await policy.check('manual', true)).toMatchObject({ blocking: true, error: 'authentication-required' })
    expect(request.mock.calls[1]![1]).toMatchObject({ credentials: 'include', redirect: 'error' })
    expect(await policy.check('manual', true)).toMatchObject({ blocking: true, error: 'unavailable' })
    expect(await policy.check('manual', true)).toEqual({ blocking: false, checking: false })
  })

  it.each(['anonymous', 'feishu-test'] as const)('does not infer login from HTML or unrelated 401 in %s mode', async (authentication) => {
    const { policy, request } = fixture(authentication)
    request.mockResolvedValueOnce(Response.json({ error: { code: 'OTHER' } }, { status: 401 }))
      .mockResolvedValueOnce(new Response('<html>login</html>', { status: 200 }))
    expect(await policy.check('launch')).toMatchObject({ error: 'unavailable' })
    expect(await policy.check('manual', true)).toMatchObject({ error: 'unavailable' })
  })

  it('does not enable authentication from a gateway response in anonymous mode', async () => {
    const { policy, request } = fixture()
    request.mockResolvedValueOnce(Response.json({ error: { code: 'UNAUTHENTICATED' } }, { status: 401 }))
    expect(await policy.check('launch')).toMatchObject({ error: 'unavailable' })
  })
  it('sends an anonymous independent request with installed release headers and fixed Nightly', async () => {
    const { policy, request } = fixture()
    await expect(policy.check('launch')).resolves.toEqual({ blocking: false, checking: false })
    const [url, options] = request.mock.calls[0]!
    expect(url).toBeInstanceOf(URL)
    expect((url as URL).href).toBe('https://policy.example.com/api/v0/check_client_update?scenario=launch')
    expect(options).toMatchObject({ credentials: 'omit', cache: 'no-store', redirect: 'error', headers: {
      'x-client-platform': 'desktop-win', 'x-client-version': '1.2.3', 'x-client-bundle-id': '',
      'x-client-locale': 'zh_CN', 'x-client-timezone-offset': '28800', 'x-client-arch': 'x64', 'x-client-update-channel': 'nightly',
      'x-client-bundled-dsh-version': '0.1.5-rc.1',
    } })
  })

  it('sends the language and UTC offset sampled for each check', async () => {
    let current = { ...client, locale: 'en', timezoneOffsetSeconds: -18_000 }
    const { policy, request } = fixture('anonymous', () => current)
    await policy.check('launch')
    current = { ...client, locale: 'zh-CN', timezoneOffsetSeconds: 28_800 }
    await policy.check('manual', true)
    const headers = request.mock.calls.map(call => (call[1]?.headers ?? {}) as Record<string, string>)
    expect(headers[0]).toMatchObject({ 'x-client-locale': 'en_US', 'x-client-timezone-offset': '-18000' })
    expect(headers[1]).toMatchObject({ 'x-client-locale': 'zh_CN', 'x-client-timezone-offset': '28800' })
  })

  it('coalesces manual checks and honors the interval on foreground/resume', async () => {
    const { policy, request } = fixture()
    const pending = Promise.withResolvers<Response>()
    request.mockReturnValueOnce(pending.promise)
    const first = policy.check('launch')
    const second = policy.check('manual', true)
    expect(first).toBe(second)
    await Promise.resolve()
    expect(request).toHaveBeenCalledTimes(1)
    pending.resolve(Response.json(clear))
    await first
    await policy.check('foreground')
    await policy.check('resume')
    expect(request).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(request).toHaveBeenCalledTimes(2)
    await policy.check('manual', true)
    expect(request).toHaveBeenCalledTimes(3)
  })

  it('accepts flattened 40005 on an HTTP error and keeps server content as plain text', async () => {
    const { policy, request } = fixture()
    request.mockResolvedValueOnce(Response.json(force, { status: 403 }))
    await expect(policy.check('launch')).resolves.toEqual({ blocking: true, checking: false,
      title: '<b>Update</b>', detail: 'Required upgrade', page: force.data.desktop_app_link })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(request).toHaveBeenCalledTimes(2)
    expect(policy.state.blocking).toBe(false)
  })

  it.each([
    { code: 0, data: { biz_code: 1, biz_data: null } },
    { code: 0, data: {} },
    { code: 500 },
  ])('does not treat an invalid no-force decision as permission to unblock: %j', async (body) => {
    const { policy, request } = fixture()
    request.mockResolvedValueOnce(Response.json(force)).mockResolvedValueOnce(Response.json(body))
    await policy.check('launch')
    expect((await policy.check('manual', true))).toMatchObject({ blocking: true, error: 'unavailable' })
    request.mockResolvedValueOnce(Response.json(clear))
    expect((await policy.check('manual', true)).blocking).toBe(false)
  })

  it('keeps a recognized block when optional copy and navigation are absent', async () => {
    const { policy, request } = fixture()
    request.mockResolvedValueOnce(Response.json({ code: 40005, data: { alt_app: force.data } }))
    expect(await policy.check('launch')).toEqual({ blocking: true, checking: false })
  })

  it('does not clear a block on HTTP 500 carrying a nominal success body', async () => {
    const { policy, request } = fixture()
    request.mockResolvedValueOnce(Response.json(force)).mockResolvedValueOnce(Response.json(clear, { status: 500 }))
    await policy.check('launch')
    expect(await policy.check('manual', true)).toMatchObject({ blocking: true, error: 'unavailable' })
  })

  it('aborts a stalled request at its own deadline and retries with bounded backoff', async () => {
    const { policy, request } = fixture()
    request.mockImplementationOnce(async (_url, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
    }))
    const pending = policy.check('launch')
    await vi.advanceTimersByTimeAsync(1000)
    expect(await pending).toEqual({ blocking: false, checking: false, error: 'unavailable' })
    await vi.advanceTimersByTimeAsync(19_999)
    expect(request).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('awaits cancellation and suppresses late publications during dispose', async () => {
    const { policy, request, publish } = fixture()
    const entered = Promise.withResolvers<undefined>()
    request.mockImplementationOnce(async (_url, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
      entered.resolve(undefined)
    }))
    const pending = policy.check('launch')
    await entered.promise
    const count = publish.mock.calls.length
    await policy.dispose()
    await pending
    expect(publish).toHaveBeenCalledTimes(count)
    await vi.advanceTimersByTimeAsync(1_000_000)
    expect(request).toHaveBeenCalledTimes(1)
    await expect(policy.check('manual', true)).rejects.toThrow('disposed')
  })

  it('does not start network work if disposed before the request microtask', async () => {
    const { policy, request } = fixture()
    const pending = policy.check('launch')
    await policy.dispose()
    await pending
    expect(request).not.toHaveBeenCalled()
  })
})

describe('policy deployment and page validation', () => {
  it('requires validated login origins only for test authentication', () => {
    expect(() => resolveDesktopPolicyConfig({ ...deployment, authentication: 'feishu-test' })).toThrow('allowedAuthOrigins')
    expect(() => resolveDesktopPolicyConfig({ ...deployment, allowedAuthOrigins: ['https://login.example.com'] })).toThrow('anonymous')
    expect(() => resolveDesktopPolicyConfig({ ...deployment, authentication: 'feishu-test',
      allowedAuthOrigins: ['https://login.example.com/path'] })).toThrow('HTTPS origin')
    expect(resolveDesktopPolicyConfig({ ...deployment, authentication: 'feishu-test',
      allowedAuthOrigins: ['https://login.example.com'] })?.allowedAuthOrigins).toEqual(['https://login.example.com'])
  })

  it('requires explicit production origins and confines HTTP to an explicit local policy fixture', () => {
    expect(resolveDesktopPolicyConfig(undefined)).toBeUndefined()
    expect(() => resolveDesktopPolicyConfig({ ...deployment, origin: 'http://127.0.0.1:19001' })).toThrow('HTTPS')
    expect(resolveDesktopPolicyConfig({ ...deployment, origin: 'http://127.0.0.1:19001' }, true)!.origin).toBe('http://127.0.0.1:19001')
    expect(() => resolveDesktopPolicyConfig({ ...deployment, origin: 'http://example.com' }, true)).toThrow('HTTPS')
  })

  it.each(['https://user:pass@downloads.example.com/x', 'https://downloads.example.com.evil.test', 'file:///a.exe',
    'javascript:alert(1)', 'http://downloads.example.com', 'https://downloads.example.com:9443'])('rejects a disallowed page: %s', (url) => {
    expect(desktopPolicyPage(url, deployment.allowedPageOrigins)).toBeUndefined()
  })

  it.each([{ intervalMs: 0 }, { timeoutMs: 1.5 }, { maxBackoffMs: 1000 }, { jitter: 2 }, { allowedPageOrigins: [] },
    { origin: 'https://example.com/path' }, { authentication: 'feishu' },
    { authentication: 'feishu-test', origin: 'http://127.0.0.1:9000' }])('rejects invalid deployment input: %j', (change) => {
    expect(() => resolveDesktopPolicyConfig({ ...deployment, ...change })).toThrow()
  })
})
