import { expect, it, vi } from 'vitest'
import { browserUrl, logoutAccount, requestAccount, requestBonusNotified, requestPlatform, requestUnnotifiedBonuses } from '../src/protocol.ts'
import type { AccountBonusOrderId } from '@deepseek-ai/dsh-deepseek-account/types'
import { readAccountDetail, readUnnotifiedBonuses } from '../src/details.ts'

it.each(['/dsh/authorize', '/dsh/authorized'])('maps %s to the configured development origin and preserves query bytes', (path) => {
  const origin = 'http://localhost:8081'
  const query = '?authorize_id=fixture&value=a%2Fb&value=two+words&empty='
  const url = `https://platform.deepseek.com${path}${query}`
  expect(() => browserUrl(url, origin, path)).toThrow()
  expect(browserUrl(url, origin, path, true)).toBe(`${origin}${path}${query}`)
  expect(browserUrl(`${origin}${path}${query}`, origin, path, true)).toBe(`${origin}${path}${query}`)
  for (const invalid of [
    `http://other.example${path}`,
    'javascript:alert(1)',
    'https://platform.deepseek.com/other',
    `https://user:password@platform.deepseek.com${path}`,
    `https://platform.deepseek.com${path}#fragment`,
  ]) expect(() => browserUrl(invalid, origin, path, true)).toThrow()
})

it('reports business failure codes without credentials or response messages', async () => {
  const output = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
    code: 0, data: { biz_code: 40123, biz_data: { token: 'response-secret' } }, message: 'private-message',
  })))
  try {
    await expect(requestPlatform('https://platform.deepseek.com', 'auth_init',
      { code_verifier: 'request-secret' }, new AbortController().signal,
      { Cookie: 'cookie-secret' })).rejects.toThrow('account: protocol')
    expect(output).toHaveBeenCalledOnce()
    const logged = JSON.stringify(output.mock.calls)
    expect(logged).toContain('/auth-api/v0/dsh/auth_init')
    expect(logged).toContain('40123')
    expect(logged).toContain('200')
    for (const secret of ['response-secret', 'private-message', 'request-secret', 'cookie-secret']) {
      expect(logged).not.toContain(secret)
    }
  } finally {
    fetcher.mockRestore()
    output.mockRestore()
  }
})

it('reports transport failure without exposing the thrown error', async () => {
  const output = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('private-network-detail'))
  try {
    await expect(requestPlatform('https://platform.deepseek.com', 'auth_init', {},
      new AbortController().signal, {})).rejects.toThrow('account: no-response')
    const logged = JSON.stringify(output.mock.calls)
    expect(logged).toContain('no-response')
    expect(logged).not.toContain('private-network-detail')
  } finally {
    fetcher.mockRestore()
    output.mockRestore()
  }
})


it('identifies invalid envelope fields without logging response values', async () => {
  const output = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
    code: 0, data: { biz_code: 'private-code', biz_data: { token: 'private-token' } },
  })))
  try {
    await expect(requestPlatform('https://platform.deepseek.com', 'auth_init', {},
      new AbortController().signal, {})).rejects.toThrow('account: protocol')
    const logged = JSON.stringify(output.mock.calls)
    expect(logged).toContain('envelope')
    expect(logged).toContain('biz_code')
    expect(logged).toContain('invalid_type')
    expect(logged).not.toContain('private-code')
    expect(logged).not.toContain('private-token')
  } finally {
    fetcher.mockRestore()
    output.mockRestore()
  }
})

it('reports browser URL rejection rules without exposing the destination', () => {
  const output = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  try {
    expect(() => browserUrl('https://private.example/wrong?code=private-code',
      'https://platform.deepseek.com', '/dsh/authorize')).toThrow('account: protocol')
    expect(output).toHaveBeenCalledWith('[deepseek-account] browser URL rejected', {
      path: '/dsh/authorize', originMismatch: true, pathMismatch: true,
      hasCredentials: false, hasFragment: false,
    })
    expect(() => browserUrl('private-invalid-url', 'https://platform.deepseek.com',
      '/dsh/authorize')).toThrow('account: protocol')
    expect(JSON.stringify(output.mock.calls)).not.toContain('private-')
  } finally {
    output.mockRestore()
  }
})

it.each([
  { name: 'HTTP failure', response: () => new Response('private-error', { status: 503 }), code: 'network' },
  { name: 'missing body', response: () => new Response(null), code: 'network' },
  { name: 'oversized body', response: () => new Response('x'.repeat(65_537)), code: 'protocol' },
  { name: 'invalid JSON', response: () => new Response('{private-invalid'), code: 'protocol' },
  { name: 'missing envelope data', response: () => new Response('{"code":0}'), code: 'protocol' },
  { name: 'broken response stream', response: () => new Response(new ReadableStream({
    start(controller) { controller.error(new Error('private-stream-error')) },
  })), code: 'protocol' },
])('rejects $name without exposing response data', async ({ response, code }) => {
  const output = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response())
  try {
    await expect(requestPlatform('https://platform.deepseek.com', 'auth_init', {},
      new AbortController().signal, {})).rejects.toThrow(`account: ${code}`)
    expect(output).toHaveBeenCalled()
    expect(JSON.stringify(output.mock.calls)).not.toContain('private-')
  } finally {
    fetcher.mockRestore()
    output.mockRestore()
  }
})

it('keeps successful authorization, account, bonus and logout requests silent', async () => {
  const output = ['log', 'info', 'error'] as const
  const spies = output.map(method => vi.spyOn(console, method).mockImplementation(() => undefined))
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
    code: 0, data: { biz_code: 0, biz_data: null },
  })))
  try {
    const origin = 'https://platform.deepseek.com'
    const signal = new AbortController().signal
    for (const method of ['auth_init', 'auth_exchange', 'auth_cancel']) {
      await requestPlatform(origin, method, {}, signal, {})
    }
    for (const path of ['/auth-api/v0/users/current', '/api/v0/users/get_user_summary'] as const) {
      await requestAccount(origin, path, 'private-token', signal, {})
    }
    await requestUnnotifiedBonuses(origin, 'private-token', signal, {})
    await requestBonusNotified(origin, 'private-token', 'fixture-order' as AccountBonusOrderId, signal, {})
    await logoutAccount(origin, 'private-token', signal, {})
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({
      code: 0, data: { biz_code: 0, biz_data: { email: 'private-email' } },
    })))
    expect(await readAccountDetail('profile', origin, 'private-token', signal, {})).toMatchObject({ status: 'ready' })
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({
      code: 0, data: { biz_code: 0, biz_data: { normal_wallets: [], bonus_wallets: [] } },
    })))
    expect(await readAccountDetail('balance', origin, 'private-token', signal, {})).toMatchObject({ status: 'ready' })
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
  } finally {
    fetcher.mockRestore()
    for (const spy of spies) spy.mockRestore()
  }
})

it.each([
  { name: 'HTTP rejection', status: 401, payload: 'private-body' },
  { name: 'authorization code rejection', status: 200, payload: JSON.stringify({ code: 40003 }) },
])('reports $name on the error console without the credential or body', async ({ status, payload }) => {
  const output = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(payload, { status }))
  try {
    await expect(requestAccount('https://platform.deepseek.com', '/auth-api/v0/users/current',
      'private-token', new AbortController().signal, {})).rejects.toThrow('account: expired')
    expect(output).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      path: '/auth-api/v0/users/current', status,
    }))
    expect(JSON.stringify(output.mock.calls)).not.toContain('private-')
    expect(info).not.toHaveBeenCalled()
  } finally {
    fetcher.mockRestore()
    info.mockRestore()
    output.mockRestore()
  }
})


it('reports invalid bonus fields without logging bonus data', async () => {
  const output = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
    code: 0, data: { biz_code: 0, biz_data: [{ order_id: 42, msg: 'private-message' }] },
  })))
  try {
    await expect(readUnnotifiedBonuses('https://platform.deepseek.com', 'private-token',
      new AbortController().signal, {})).rejects.toThrow('account: protocol')
    expect(output.mock.calls[0]?.[0]).toBe('[deepseek-account] bonus schema rejected')
    expect(JSON.stringify(output.mock.calls)).toContain('order_id')
    expect(JSON.stringify(output.mock.calls)).not.toContain('private-')
  } finally {
    fetcher.mockRestore()
    output.mockRestore()
  }
})


it.each([
  { stage: 'fetch', code: 'no-response' },
  { stage: 'unauthorized', code: 'expired' },
  { stage: 'http', code: 'network' },
  { stage: 'body', code: 'protocol' },
])('keeps caller cancellation silent during $stage', async ({ stage, code }) => {
  const output = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const fetcher = vi.spyOn(globalThis, 'fetch')
  const cancellation = new AbortController()
  const reading = Promise.withResolvers<undefined>()
  let body: ReadableStreamDefaultController<Uint8Array> | undefined
  try {
    if (stage === 'body') {
      fetcher.mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
        start(controller) { body = controller },
        pull() { reading.resolve(undefined) },
      })))
    } else if (stage === 'fetch') {
      cancellation.abort()
      fetcher.mockRejectedValue(cancellation.signal.reason)
    } else {
      fetcher.mockImplementation(async () => {
        cancellation.abort()
        return new Response('private-response', { status: stage === 'unauthorized' ? 401 : 503 })
      })
    }
    const request = requestAccount('https://platform.deepseek.com', '/auth-api/v0/users/current',
      'private-token', cancellation.signal, {})
    if (stage === 'body') {
      await reading.promise
      cancellation.abort()
      body!.error(cancellation.signal.reason)
    }
    await expect(request).rejects.toThrow(`account: ${code}`)
    expect(output).not.toHaveBeenCalled()
  } finally {
    body?.error()
    fetcher.mockRestore()
    output.mockRestore()
  }
})

it('keeps cancellation with a non-error reason silent', async () => {
  const output = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('private-network-error'))
  const cancellation = new AbortController()
  cancellation.abort('private-cancel-reason')
  try {
    expect(await readAccountDetail('profile', 'https://platform.deepseek.com', 'private-token',
      cancellation.signal, {})).toEqual({ status: 'failed' })
    expect(output).not.toHaveBeenCalled()
  } finally {
    fetcher.mockRestore()
    output.mockRestore()
  }
})

it.each(['fetch', 'body'] as const)('reports request timeouts during %s once without raw exceptions', async (stage) => {
  const output = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const fetcher = vi.spyOn(globalThis, 'fetch')
  const timeout = new AbortController()
  const reading = Promise.withResolvers<undefined>()
  let body: ReadableStreamDefaultController<Uint8Array> | undefined
  try {
    if (stage === 'body') {
      fetcher.mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
        start(controller) { body = controller },
        pull() { reading.resolve(undefined) },
      })))
    } else {
      timeout.abort(new DOMException('private-timeout-message', 'TimeoutError'))
      fetcher.mockRejectedValue(timeout.signal.reason)
    }
    const request = readAccountDetail('profile', 'https://platform.deepseek.com', 'private-token', timeout.signal, {})
    if (stage === 'body') {
      await reading.promise
      timeout.abort(new DOMException('private-timeout-message', 'TimeoutError'))
      body!.error(timeout.signal.reason)
    }
    expect(await request).toEqual({ status: 'failed' })
    expect(output).toHaveBeenCalledOnce()
    expect(JSON.stringify(output.mock.calls)).not.toContain('private-')
  } finally {
    body?.error()
    fetcher.mockRestore()
    output.mockRestore()
  }
})

it('reports invalid profile fields once without logging profile values', async () => {
  const output = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
    code: 0, data: { biz_code: 0, biz_data: { email: 42, id: 'private-id' } },
  })))
  try {
    expect(await readAccountDetail('profile', 'https://platform.deepseek.com', 'private-token',
      new AbortController().signal, {})).toEqual({ status: 'failed' })
    expect(output).toHaveBeenCalledOnce()
    expect(output.mock.calls[0]?.[0]).toBe('[deepseek-account] profile schema rejected')
    const logged = JSON.stringify(output.mock.calls)
    expect(logged).toContain('email')
    expect(logged).toContain('invalid_type')
    expect(logged).not.toContain('private-')
  } finally {
    fetcher.mockRestore()
    output.mockRestore()
  }
})
