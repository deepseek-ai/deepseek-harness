import { expect, it, vi } from 'vitest'
import { browserUrl, requestPlatform } from '../src/protocol.ts'

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
  const output = vi.spyOn(console, 'info').mockImplementation(() => undefined)
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
    code: 0, data: { biz_code: 40123, biz_data: { token: 'response-secret' } }, message: 'private-message',
  })))
  try {
    await expect(requestPlatform('https://platform.deepseek.com', 'auth_init',
      { code_verifier: 'request-secret' }, new AbortController().signal,
      { Cookie: 'cookie-secret' })).rejects.toThrow('account: protocol')
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
  const output = vi.spyOn(console, 'info').mockImplementation(() => undefined)
  const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('private-network-detail'))
  try {
    await expect(requestPlatform('https://platform.deepseek.com', 'auth_init', {},
      new AbortController().signal, {})).rejects.toThrow('account: network')
    const logged = JSON.stringify(output.mock.calls)
    expect(logged).toContain('network')
    expect(logged).not.toContain('private-network-detail')
  } finally {
    fetcher.mockRestore()
    output.mockRestore()
  }
})


it('identifies invalid envelope fields without logging response values', async () => {
  const output = vi.spyOn(console, 'info').mockImplementation(() => undefined)
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
  const output = vi.spyOn(console, 'info').mockImplementation(() => undefined)
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
  const output = vi.spyOn(console, 'info').mockImplementation(() => undefined)
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response())
  try {
    await expect(requestPlatform('https://platform.deepseek.com', 'auth_init', {},
      new AbortController().signal, {})).rejects.toThrow(`account: ${code}`)
    expect(JSON.stringify(output.mock.calls)).not.toContain('private-')
  } finally {
    fetcher.mockRestore()
    output.mockRestore()
  }
})
