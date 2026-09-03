import { createServer, type Server } from 'node:http'
import { spawn } from 'node:child_process'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { clearedProxyEnv, installProxyFromEnvironment } from '@deepseek-ai/dsh-http-proxy'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { scrubbedParentEnv } from '../src/index.ts'

/**
 * Whether this runtime honors `NODE_USE_ENV_PROXY`, which is how a child Node receives the policy.
 * Added in Node 24.0 and backported to 22.21; the engines range admits 22.19 and 22.20, where a
 * child stays direct.
 */
function supportsEnvProxy(): boolean {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number)
  return major >= 24 || (major === 22 && minor >= 21)
}

let seen: string[] = []
let proxy: Server
let proxyUrl: string
let saved: Record<string, string | undefined> = {}

beforeAll(async () => {
  proxy = createServer((request, response) => {
    seen.push(request.url ?? '')
    response.writeHead(200)
    response.end('VIA-PROXY')
  })
  // Node's own proxy support may tunnel rather than send an absolute-form request; record either.
  proxy.on('connect', (request, socket) => {
    seen.push(request.url ?? '')
    socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
    socket.end()
  })
  const address = await new Promise<AddressInfo>((resolve) => {
    proxy.listen(0, '127.0.0.1', () => { resolve(proxy.address() as AddressInfo) })
  })
  proxyUrl = `http://127.0.0.1:${String(address.port)}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => { proxy.close(() => { resolve() }) })
})

beforeEach(() => {
  seen = []
  const names = Object.keys(clearedProxyEnv())
  saved = Object.fromEntries(names.map(name => [name, process.env[name]]))
  for (const name of names) Reflect.deleteProperty(process.env, name)
})

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) Reflect.deleteProperty(process.env, name)
    else process.env[name] = value
  }
})

/** Run a child Node that fetches, using exactly the environment every harness spawner builds. */
function childFetch(target: string, env: Record<string, string>): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['-e', `fetch(${JSON.stringify(target)}).then(r=>r.text()).then(t=>console.log(t)).catch(e=>console.log('ERR'+String(e.cause?.code)))`],
      { env, stdio: ['ignore', 'pipe', 'ignore'] },
    )
    let out = ''
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString() })
    child.on('close', () => { resolve(out.trim()) })
  })
}

describe('child process egress', () => {
  it('a child Node honors the proxy the user exported', async () => {
    // The user's own export is what a child inherits, so the scenario starts from one.
    process.env.HTTP_PROXY = proxyUrl
    const dispose = await installProxyFromEnvironment(
      createLaunchEnvironmentSnapshot([{ source: 'process', values: { HTTP_PROXY: proxyUrl } }]),
      () => undefined,
    )
    let childEnv: Record<string, string> = {}
    try {
      childEnv = scrubbedParentEnv()
      await childFetch('http://child-probe.invalid/x', childEnv)
    } finally {
      await dispose()
    }
    expect(childEnv.NODE_USE_ENV_PROXY).toBe('1')
    expect(childEnv.HTTP_PROXY).toBe(proxyUrl)
    // The flag is what a child Node acts on; an older runtime ignores it and stays direct, which is
    // the documented seam rather than a defect.
    if (supportsEnvProxy()) expect(seen.join('|')).toContain('child-probe.invalid')
    else expect(seen).toEqual([])
  })

  it('a child Node reaches a proxy the user gave only as ALL_PROXY', async () => {
    process.env.ALL_PROXY = proxyUrl
    const dispose = await installProxyFromEnvironment(
      createLaunchEnvironmentSnapshot([{ source: 'process', values: { ALL_PROXY: proxyUrl } }]),
      () => undefined,
    )
    let childEnv: Record<string, string> = {}
    try {
      childEnv = scrubbedParentEnv()
      await childFetch('http://all-proxy-probe.invalid/x', childEnv)
    } finally {
      await dispose()
    }
    // `NODE_USE_ENV_PROXY` reads neither casing of `ALL_PROXY`, so a child handed only the user's
    // own names connects directly while this process proxies. The resolved value fills that gap.
    expect(childEnv.ALL_PROXY).toBe(proxyUrl)
    expect(childEnv.HTTP_PROXY).toBe(proxyUrl)
    if (supportsEnvProxy()) expect(seen.join('|')).toContain('all-proxy-probe.invalid')
    else expect(seen).toEqual([])
  })

  it('keeps a proxy the user set for another tool, and fills only a scheme they never named', async () => {
    // A SOCKS proxy this package refuses but `curl` uses, alongside an HTTP proxy it accepts.
    process.env.HTTP_PROXY = proxyUrl
    process.env.https_proxy = 'socks5://127.0.0.1:1080'
    const dispose = await installProxyFromEnvironment(
      createLaunchEnvironmentSnapshot([{
        source: 'process',
        values: { HTTP_PROXY: proxyUrl, https_proxy: 'socks5://127.0.0.1:1080' },
      }]),
      () => undefined,
    )
    try {
      const child = scrubbedParentEnv()
      // The user named `https:`, so their value survives in the casing they wrote it, even though
      // this process refused it and routes that scheme directly.
      expect(child.https_proxy).toBe('socks5://127.0.0.1:1080')
      expect(child.HTTPS_PROXY).toBeUndefined()
      // The bypass list is always the resolved one; the user set none, so it is the loopback
      // entries alone — without them the child sends its own localhost traffic to the proxy.
      expect(child.NO_PROXY).toBe('localhost,127.0.0.1,::1,[::1]')
    } finally {
      await dispose()
    }
  })

  it('gives a child the same routing as its parent for a scheme the user never named', async () => {
    process.env.HTTP_PROXY = proxyUrl
    const dispose = await installProxyFromEnvironment(
      createLaunchEnvironmentSnapshot([{ source: 'process', values: { HTTP_PROXY: proxyUrl } }]),
      () => undefined,
    )
    try {
      // This process routes `https:` through the HTTP proxy, matching undici. A child that did not
      // see the name would diverge from its parent; `curl`, which performs no such fallback of its
      // own, gains it here — the deliberate cost of one routing answer for parent and child alike.
      expect(process.env.HTTPS_PROXY).toBe(proxyUrl)
      expect(scrubbedParentEnv().HTTPS_PROXY).toBe(proxyUrl)
    } finally {
      await dispose()
    }
  })

  it('adds nothing when no proxy is active', () => {
    expect(scrubbedParentEnv().NODE_USE_ENV_PROXY).toBeUndefined()
  })
})
