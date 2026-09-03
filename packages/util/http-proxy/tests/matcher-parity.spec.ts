import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { installProxyFromEnvironment } from '../src/index.ts'
import { proxyForUrl, resolveProxyPolicy } from '../src/policy.ts'

/**
 * `proxyForUrl` answers where a URL goes; these cases check that answer against where a real `fetch`
 * actually went, for every form in the documented bypass vocabulary. The installed dispatcher routes
 * by this same predicate, so the two cannot drift apart by parsing the list twice — what a case can
 * still catch is `bypassesProxy` reading a form differently from how the vocabulary documents it,
 * and any future dispatcher that reintroduces a second matcher.
 *
 * The remaining second matcher is Node's, in a spawned child: it reads the published `NO_PROXY` and
 * applies its own rules, which differ in separators and IPv4-range support. That seam is documented
 * rather than asserted here, because the difference is real.
 */
const CASES: readonly { readonly noProxy: string; readonly path: string; readonly bypassed: boolean }[] = [
  { noProxy: '', path: '/plain', bypassed: false },
  { noProxy: 'probe.invalid', path: '/exact', bypassed: true },
  { noProxy: '.probe.invalid', path: '/dot-suffix', bypassed: true },
  { noProxy: '*.probe.invalid', path: '/star-suffix', bypassed: true },
  { noProxy: 'other.invalid', path: '/miss', bypassed: false },
  { noProxy: '*', path: '/all', bypassed: true },
  { noProxy: 'probe.invalid:80', path: '/with-default-port', bypassed: true },
  { noProxy: 'probe.invalid:8443', path: '/wrong-port', bypassed: false },
  { noProxy: 'a.invalid, probe.invalid', path: '/comma-list', bypassed: true },
]

let seen: string[] = []
let proxy: Server
let proxyUrl: string

beforeAll(async () => {
  proxy = createServer((request, response) => {
    seen.push(request.url ?? '')
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('VIA-PROXY')
  })
  const address = await new Promise<AddressInfo>((resolve) => {
    proxy.listen(0, '127.0.0.1', () => { resolve(proxy.address() as AddressInfo) })
  })
  proxyUrl = `http://127.0.0.1:${String(address.port)}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => { proxy.close(() => { resolve() }) })
})

/** The launch environment of a user who exported one proxy for both schemes plus one bypass list. */
function proxyEnv(noProxy: string): { get(name: string): { value: string } | undefined } {
  const values: Record<string, string> = { HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, NO_PROXY: noProxy }
  return { get: name => (name in values ? { value: values[name] as string } : undefined) }
}

describe('bypass matcher parity', () => {
  it.each(CASES)('agrees on $noProxy for $path', async ({ noProxy, path, bypassed }) => {
    seen = []
    const url = new URL(`http://probe.invalid${path}`)
    const env = proxyEnv(noProxy)
    const { policy } = resolveProxyPolicy(env)
    const dispose = await installProxyFromEnvironment(env, () => undefined)
    try {
      // A bypassed target has no route here, so the fetch fails; a proxied one reaches the recorder
      // in milliseconds. The deadline bounds the failing path, whose DNS miss is otherwise as slow
      // as the machine's resolver decides — and only that path, so it cannot mask a proxied hop.
      await fetch(url, { signal: AbortSignal.timeout(1500) }).then(response => response.text()).catch(() => undefined)
      const agentProxied = seen.length > 0
      expect({ ours: proxyForUrl(policy, url) !== undefined, agent: agentProxied })
        .toEqual({ ours: !bypassed, agent: !bypassed })
    } finally {
      await dispose()
    }
  })
})
