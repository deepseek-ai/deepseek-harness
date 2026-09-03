import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installProxyFromEnvironment } from '@deepseek-ai/dsh-http-proxy'
import { HttpFetchProvider } from '@deepseek-ai/dsh-web-fetch-http'
import type { HttpFetchLimits } from '@deepseek-ai/dsh-web-fetch-http'
import { isNonPublicIpLiteral, publicHttpNetwork } from '../src/network.ts'

const limits: HttpFetchLimits = {
  maxResponseBytes: 5_000_000,
  maxBodyChars: 100_000,
  timeoutMs: 5_000,
  maxRedirects: 5,
  userAgent: 'test-agent/1.0',
}

/** Absolute-form targets the fake proxy saw; a populated entry proves the hop was tunnelled. */
let proxied: string[]
let proxy: Server
let origin: Server
let proxyUrl: string
let originUrl: string

/**
 * The target for every assertion about a tunnelled hop. Loopback cannot serve: no policy routes
 * this machine through a proxy. The host never resolves — the proxy answers the absolute-form
 * request — which is also what makes the skipped resolver observable.
 */
const proxyTarget = 'http://origin.test/page'
let disposeProxy: (() => Promise<void>) | undefined

function listen(server: Server): Promise<AddressInfo> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => { resolve(server.address() as AddressInfo) })
  })
}

function respond(_request: IncomingMessage, response: ServerResponse, body: string): void {
  response.writeHead(200, { 'content-type': 'text/plain' })
  response.end(body)
}

beforeEach(async () => {
  proxied = []
  proxy = createServer((request, response) => {
    proxied.push(request.url ?? '')
    respond(request, response, 'via-proxy')
  })
  origin = createServer((request, response) => { respond(request, response, 'direct') })
  const [proxyAddress, originAddress] = await Promise.all([listen(proxy), listen(origin)])
  proxyUrl = `http://127.0.0.1:${String(proxyAddress.port)}`
  originUrl = `http://127.0.0.1:${String(originAddress.port)}/page`
})

afterEach(async () => {
  await disposeProxy?.()
  disposeProxy = undefined
  vi.restoreAllMocks()
  await Promise.all([
    new Promise<void>((resolve) => { proxy.close(() => { resolve() }) }),
    new Promise<void>((resolve) => { origin.close(() => { resolve() }) }),
  ])
})

/**
 * Install the policy of a user who exported one proxy for both schemes; the fixture disposes it
 * after every case.
 */
async function installProxy(): Promise<() => Promise<void>> {
  const env = { get: (name: string) => (name === 'HTTP_PROXY' || name === 'HTTPS_PROXY' ? { value: proxyUrl } : undefined) }
  return await installProxyFromEnvironment(env, () => undefined)
}

describe('fetching through a proxy', () => {
  it('tunnels the request and never resolves a public address for it', async () => {
    const resolve = vi.spyOn(publicHttpNetwork, 'resolve')
    disposeProxy = await installProxy()

    const result = await new HttpFetchProvider(limits).fetch({ url: proxyTarget })

    expect(result.body.content).toBe('via-proxy')
    expect(proxied).toEqual([proxyTarget])
    // Through a proxy the origin's DNS happens proxy-side, so the resolver that rejects non-public
    // destinations is not consulted at all.
    expect(resolve).not.toHaveBeenCalled()
  })

  it('keeps resolving and pinning a hop the policy does not proxy', async () => {
    const resolve = vi.spyOn(publicHttpNetwork, 'resolve')
      .mockResolvedValue([{ address: '127.0.0.1', family: 4 }])
    // No bypass entry needed: a resolved policy never routes loopback through a proxy, which is
    // exactly the case this asserts still resolves and pins.
    disposeProxy = await installProxy()

    const result = await new HttpFetchProvider(limits).fetch({ url: originUrl })

    expect(result.body.content).toBe('direct')
    expect(proxied).toEqual([])
    expect(resolve).toHaveBeenCalledOnce()
  })

  it('resolves and pins when no proxy is installed', async () => {
    const resolve = vi.spyOn(publicHttpNetwork, 'resolve')
      .mockResolvedValue([{ address: '127.0.0.1', family: 4 }])

    const result = await new HttpFetchProvider(limits).fetch({ url: originUrl })

    expect(result.body.content).toBe('direct')
    expect(resolve).toHaveBeenCalledOnce()
  })

  it.each(['10.0.0.5', '169.254.169.254', '127.0.0.2'])(
    'refuses %s instead of letting the proxy reach it for us',
    async (host) => {
      const resolve = vi.spyOn(publicHttpNetwork, 'resolve')
      disposeProxy = await installProxy()

      // The proxied path exists because a proxy resolves the origin; a literal needs no resolution,
      // so taking it would spend the address checks for nothing and hand a proxy on this machine
      // the private or loopback destination those checks exist to refuse. The hop therefore takes
      // the validated path instead, where the existing refusal already covers it.
      await expect(new HttpFetchProvider(limits).fetch({ url: `http://${host}:8080/` }))
        .rejects.toThrow(expect.objectContaining({ code: 'WEB_BLOCKED_URL' }))
      expect(proxied).toEqual([])
      expect(resolve).toHaveBeenCalledOnce()
    },
  )

  it('reads an IPv4-mapped literal as non-public without asking the network', () => {
    // Driven through the predicate rather than a fetch: an IPv6 literal sends `resolvePublicAddresses`
    // looking for a NAT64 prefix before it refuses anything, and that is a real DNS query. The three
    // IPv4 cases above already prove the branch end to end without one.
    expect(isNonPublicIpLiteral('[::ffff:7f00:1]')).toBe(true)
    expect(isNonPublicIpLiteral('[::1]')).toBe(true)
    expect(isNonPublicIpLiteral('[::ffff:808:808]')).toBe(false)
    expect(isNonPublicIpLiteral('example.com')).toBe(false)
  })

  it('still refuses a cross-origin redirect on the proxied path', async () => {
    proxy.removeAllListeners('request')
    proxy.on('request', (request, response) => {
      proxied.push(request.url ?? '')
      response.writeHead(302, { location: 'http://elsewhere.example/next' })
      response.end()
    })
    disposeProxy = await installProxy()

    await expect(new HttpFetchProvider(limits).fetch({ url: proxyTarget }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_REDIRECT_BLOCKED' }))
  })

  it('still refuses a URL the transport policy rejects before any hop', async () => {
    disposeProxy = await installProxy()

    await expect(new HttpFetchProvider(limits).fetch({ url: 'ftp://example.com/x' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_INVALID_URL' }))
    expect(proxied).toEqual([])
  })
})
