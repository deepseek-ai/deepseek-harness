import { spawnSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest'
import { getGlobalDispatcher } from 'undici'
import {
  clearedProxyEnv,
  installProxyFromEnvironment,
  proxyEnvironmentForChild,
  proxyRouteFor,
} from '../src/index.ts'
import { PROXY_ENV_NAMES } from '../src/policy.ts'

/** Absolute-form request targets the fake proxy received; a populated entry proves a request was tunnelled. */
let proxied: string[] = []
let proxy: Server
let origin: Server
let proxyUrl: string
let originUrl: string

/**
 * The target for every assertion about a tunnelled hop. It is deliberately not loopback: no policy
 * routes this machine through a proxy, so a loopback target could only ever prove a direct hop. The
 * host never resolves — the client connects to the proxy, which answers the absolute-form request.
 */
const proxyTarget = 'http://origin.test/probe'

function listen(server: Server): Promise<AddressInfo> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => { resolve(server.address() as AddressInfo) })
  })
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => { server.close(() => { resolve() }) })
}

beforeAll(async () => {
  proxy = createServer((request, response) => {
    proxied.push(`${request.method} ${request.url}`)
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('VIA-PROXY')
  })
  proxy.on('connect', (request, socket) => {
    proxied.push(`CONNECT ${request.url ?? ''}`)
    socket.end()
  })
  origin = createServer((_request, response) => { response.end('DIRECT') })
  const [proxyAddress, originAddress] = await Promise.all([listen(proxy), listen(origin)])
  proxyUrl = `http://127.0.0.1:${String(proxyAddress.port)}`
  originUrl = `http://127.0.0.1:${String(originAddress.port)}/probe`
})

afterAll(async () => {
  await Promise.all([close(proxy), close(origin)])
})

afterEach(() => {
  proxied = []
})

/** A second proxy URL, never dialed: it only has to differ from {@link proxyUrl} in an assertion. */
const nestedUrl = 'http://127.0.0.1:9'

/** A launch environment built from the names a user would export, in the casings they wrote. */
function env(values: Record<string, string>): { get(name: string): { value: string } | undefined } {
  return { get: name => (name in values ? { value: values[name] as string } : undefined) }
}

/** The environment of a user who exported one proxy for both schemes. */
function proxyAll(noProxy?: string): { get(name: string): { value: string } | undefined } {
  return env({ HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, ...noProxy === undefined ? {} : { NO_PROXY: noProxy } })
}

/** Install and collect whatever the resolution reported, so a case can assert on both. */
async function install(
  lookup: { get(name: string): { value: string } | undefined },
): Promise<{ dispose: () => Promise<void>; reported: string[] }> {
  const reported: string[] = []
  const dispose = await installProxyFromEnvironment(lookup, (message) => { reported.push(message) })
  return { dispose, reported }
}

/** Run one case from a known-empty proxy environment, then restore what the machine had. */
async function withCleanProxyEnv(run: () => Promise<void>): Promise<void> {
  const saved = Object.fromEntries(PROXY_ENV_NAMES.map(name => [name, process.env[name]]))
  for (const name of PROXY_ENV_NAMES) Reflect.deleteProperty(process.env, name)
  try {
    await run()
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) Reflect.deleteProperty(process.env, name)
      else process.env[name] = value
    }
  }
}

describe('installProxyFromEnvironment', () => {
  it('routes the built-in global fetch through the proxy', async () => {
    const { dispose } = await install(proxyAll())
    try {
      await expect((await fetch(proxyTarget)).text()).resolves.toBe('VIA-PROXY')
      expect(proxied).toEqual([`GET ${proxyTarget}`])
    } finally {
      await dispose()
    }
  })

  it('connects directly when the bypass list covers the target', async () => {
    const { dispose } = await install(env({ HTTP_PROXY: proxyUrl, NO_PROXY: 'origin.test' }))
    try {
      await expect(fetch(proxyTarget, { signal: AbortSignal.timeout(1500) })).rejects.toThrow()
      expect(proxied).toEqual([])
    } finally {
      await dispose()
    }
  })

  it('reports a value it cannot use and installs the rest', async () => {
    const { dispose, reported } = await install(env({ HTTP_PROXY: proxyUrl, HTTPS_PROXY: 'socks5://127.0.0.1:1080' }))
    try {
      // A variable exported for another tool must not stop the agent from starting, and the user
      // has to learn that this scheme stays direct rather than discover it from a failing request.
      // The message names the variable, never its value: a proxy URL may carry `user:password`.
      expect(reported).toHaveLength(1)
      expect(reported[0]).toContain('HTTPS_PROXY')
      expect(reported[0]).toContain('SOCKS')
      expect(reported[0]).not.toContain('1080')
      await expect((await fetch(proxyTarget)).text()).resolves.toBe('VIA-PROXY')
    } finally {
      await dispose()
    }
  })

  it('publishes the policy through the proxy environment in both casings', async () => {
    const { dispose } = await install(proxyAll('example.com'))
    try {
      expect(process.env.http_proxy).toBe(proxyUrl)
      expect(process.env.HTTP_PROXY).toBe(proxyUrl)
      expect(process.env.no_proxy).toContain('example.com')
      expect(process.env.NO_PROXY).toContain('example.com')
    } finally {
      await dispose()
    }
  })

  it('removes an environment name the policy leaves unset', async () => {
    process.env.HTTPS_PROXY = 'http://stale.example'
    // The user named no HTTPS proxy, so the policy derives one from HTTP — the name is rewritten,
    // never left carrying a value from an earlier process.
    const { dispose } = await install(env({ HTTP_PROXY: proxyUrl, HTTPS_PROXY: 'socks5://127.0.0.1:1080' }))
    try {
      expect(process.env.HTTPS_PROXY).toBeUndefined()
    } finally {
      await dispose()
      expect(process.env.HTTPS_PROXY).toBe('http://stale.example')
      delete process.env.HTTPS_PROXY
    }
  })

  it('restores the dispatcher, the route, and the environment on disposal', async () => {
    const before = getGlobalDispatcher()
    const beforeEnv = process.env.HTTP_PROXY
    const { dispose } = await install(proxyAll())
    expect(getGlobalDispatcher()).not.toBe(before)
    expect(proxyRouteFor(new URL(proxyTarget)).proxied).toBe(true)
    await dispose()
    expect(getGlobalDispatcher()).toBe(before)
    expect(proxyRouteFor(new URL(proxyTarget)).proxied).toBe(false)
    expect(process.env.HTTP_PROXY).toBe(beforeEnv)
    await expect((await fetch(originUrl)).text()).resolves.toBe('DIRECT')
  })

  it('installs no dispatcher and touches no environment when the user exported none', async () => {
    const before = getGlobalDispatcher()
    process.env.HTTP_PROXY = 'http://untouched.example'
    const { dispose, reported } = await install(env({}))
    try {
      expect(getGlobalDispatcher()).toBe(before)
      expect(process.env.HTTP_PROXY).toBe('http://untouched.example')
      expect(reported).toEqual([])
      expect(proxyRouteFor(new URL(proxyTarget))).toEqual({ proxied: false })
    } finally {
      await dispose()
      delete process.env.HTTP_PROXY
    }
  })

  it('keeps a scheme direct when the policy refused the proxy the user named for it', async () => {
    // What `HTTPS_PROXY=socks5://…` plus `HTTP_PROXY=http://p` resolves to: http proxied, https
    // direct. undici's own EnvHttpProxyAgent cannot express this — with no HTTPS proxy present it
    // reuses the HTTP one, tunnelling the scheme the diagnostic told the user stayed direct.
    const { dispose } = await install(env({ HTTP_PROXY: proxyUrl, HTTPS_PROXY: 'socks5://127.0.0.1:1080' }))
    try {
      // The direct path here fails on a DNS miss whose latency is the machine's resolver to decide;
      // the deadline bounds it. Either rejection proves the same thing — no CONNECT reached the
      // proxy — and a proxied hop would have answered in milliseconds instead.
      await expect(fetch('https://refused-scheme.invalid/', { signal: AbortSignal.timeout(1500) })).rejects.toThrow()
      expect(proxied).toEqual([])
      // The same policy still tunnels http, so the empty expectation above is not vacuous.
      await expect((await fetch(proxyTarget)).text()).resolves.toBe('VIA-PROXY')
      expect(proxied).toEqual([`GET ${proxyTarget}`])
    } finally {
      await dispose()
    }
  })
})

describe('proxyRouteFor', () => {
  it('carries the dispatcher already routing, so a branch and its request agree', async () => {
    const { dispose } = await install(proxyAll())
    const route = proxyRouteFor(new URL(proxyTarget))
    expect(route).toMatchObject({ proxied: true, proxy: proxyUrl })
    if (!route.proxied) throw new Error('unreachable: asserted proxied above')
    // One transport, not a copy: a caller that branched on this route sends its request through the
    // very agent the branch described, so no second read can put the two on different routes.
    expect(route.dispatcher).toBe(getGlobalDispatcher())
    const undici = await import('undici')
    // Disposing the install while a request is in flight: the shared dispatcher is closed, not
    // destroyed, so the hop that already left finishes.
    const inFlight = undici.fetch(proxyTarget, { dispatcher: route.dispatcher })
    await dispose()
    await expect((await inFlight).text()).resolves.toBe('VIA-PROXY')
    expect(proxied).toEqual([`GET ${proxyTarget}`])
  })

  it('is direct for a bypassed URL, and direct with nothing installed', async () => {
    const { dispose } = await install(proxyAll('origin.test'))
    try {
      expect(proxyRouteFor(new URL(proxyTarget))).toEqual({ proxied: false })
    } finally {
      await dispose()
    }
    expect(proxyRouteFor(new URL(proxyTarget))).toEqual({ proxied: false })
  })

  it('is direct for a loopback URL under a policy that proxies everything', async () => {
    const { dispose } = await install(proxyAll())
    try {
      expect(proxyRouteFor(new URL(originUrl))).toEqual({ proxied: false })
    } finally {
      await dispose()
    }
  })
})

describe('proxyEnvironmentForChild', () => {
  it('is empty when no policy is installed', () => {
    expect(proxyEnvironmentForChild()).toEqual({})
  })

  it('is empty when the user exported none, so a child sees no flag it cannot use', async () => {
    const { dispose } = await install(env({}))
    try {
      expect(proxyEnvironmentForChild()).toEqual({})
    } finally {
      await dispose()
    }
  })

  it('hands a child the values the user exported, not this process\'s normalization', async () => {
    await withCleanProxyEnv(async () => {
      // A user who set only HTTP_PROXY, plus a SOCKS proxy this package refuses but `curl` uses.
      process.env.HTTP_PROXY = proxyUrl
      process.env.https_proxy = 'socks5://127.0.0.1:1080'
      const { dispose } = await install(env({ HTTP_PROXY: proxyUrl, https_proxy: 'socks5://127.0.0.1:1080', NO_PROXY: 'example.com' }))
      try {
        const child = proxyEnvironmentForChild()
        // The published policy derived an HTTPS proxy for this process; the child must not see it.
        // Asserted over both casings rather than one: Windows folds the pair into a single variable,
        // so which spelling carries the value is the platform's to decide — that it is the user's
        // value and never the derived one is not.
        const https = [child.https_proxy, child.HTTPS_PROXY]
        expect(https).toContain('socks5://127.0.0.1:1080')
        expect(https).not.toContain(proxyUrl)
        expect(child.HTTP_PROXY).toBe(proxyUrl)
        // The bypass list is the resolved one: it only adds entries to what the user wrote, and
        // without the loopback ones the child sends its own localhost traffic to a proxy that
        // cannot route it.
        expect(child.no_proxy).toBe('example.com,localhost,127.0.0.1,::1,[::1]')
        expect(child.NO_PROXY).toBe('example.com,localhost,127.0.0.1,::1,[::1]')
        // The SOCKS value kept for `curl` is one Node would refuse at startup, so the flag that makes
        // Node read it is withheld and a child Node connects directly rather than failing to start.
        expect(child.NODE_USE_ENV_PROXY).toBeUndefined()
      } finally {
        await dispose()
      }
    })
  })

  it('fills a scheme the user named in neither casing, so a child Node is not left direct', async () => {
    await withCleanProxyEnv(async () => {
      // The user exported only ALL_PROXY. `NODE_USE_ENV_PROXY` never reads that name, so a child
      // Node would connect directly while this process proxies — the seam this fill closes.
      process.env.ALL_PROXY = proxyUrl
      const { dispose } = await install(env({ ALL_PROXY: proxyUrl }))
      try {
        const child = proxyEnvironmentForChild()
        expect(child.HTTP_PROXY).toBe(proxyUrl)
        expect(child.http_proxy).toBe(proxyUrl)
        expect(child.HTTPS_PROXY).toBe(proxyUrl)
        expect(child.https_proxy).toBe(proxyUrl)
        expect(child.NODE_USE_ENV_PROXY).toBe('1')
      } finally {
        await dispose()
      }
    })
  })

  it.each(['socks4://127.0.0.1:1080', 'ftp://p:1', 'not a url'])(
    'withholds NODE_USE_ENV_PROXY when the child receives %s, so a child Node still starts',
    async (refused) => {
      await withCleanProxyEnv(async () => {
        process.env.HTTP_PROXY = proxyUrl
        process.env.HTTPS_PROXY = refused
        const { dispose } = await install(env({ HTTP_PROXY: proxyUrl, HTTPS_PROXY: refused }))
        try {
          const child = proxyEnvironmentForChild()
          // The value is still handed over — `curl` may read it — but Node, which parses these two
          // names before running anything under the flag, must not be told to.
          expect(child.HTTPS_PROXY).toBe(refused)
          expect(child.HTTP_PROXY).toBe(proxyUrl)
          expect(child).not.toHaveProperty('NODE_USE_ENV_PROXY')
          // Proved on a real child rather than inferred: the same environment with the flag present
          // exits before the program runs, on every Node this repository supports.
          const childEnv: Record<string, string> = { PATH: process.env.PATH ?? '' }
          for (const [name, value] of Object.entries(child)) if (value !== undefined) childEnv[name] = value
          const run = spawnSync(process.execPath, ['-e', 'process.stdout.write("started")'], { env: childEnv, encoding: 'utf8' })
          expect({ status: run.status, stdout: run.stdout }).toEqual({ status: 0, stdout: 'started' })
        } finally {
          await dispose()
        }
      })
    },
  )

  it('keeps the outermost install\'s record of what the user exported across a nested one', async () => {
    await withCleanProxyEnv(async () => {
      // The user exported one name, in one casing.
      process.env.HTTP_PROXY = proxyUrl
      // The launcher installs first; a second `installProxyFromEnvironment` layers another policy over it.
      const outer = await install(env({ HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, NO_PROXY: 'example.com' }))
      try {
        const inner = await install(env({ HTTP_PROXY: nestedUrl, HTTPS_PROXY: nestedUrl }))
        try {
          const child = proxyEnvironmentForChild()
          // The user named no HTTPS proxy, so this scheme carries whichever policy is active. Reading
          // the outer install's published environment as the user's would pin it to the outer proxy
          // instead — the one discriminator that does not depend on how a platform cases names.
          expect(child.https_proxy).toBe(nestedUrl)
          expect(child.HTTPS_PROXY).toBe(nestedUrl)
        } finally {
          await inner.dispose()
        }
        // Unmounting the inner install must leave the outer one still able to describe that
        // environment; clearing the record instead makes this an empty object, so every later child
        // inherits the normalized values from `process.env` untouched.
        expect(proxyEnvironmentForChild().HTTP_PROXY).toBe(proxyUrl)
        expect(proxyEnvironmentForChild().https_proxy).toBe(proxyUrl)
      } finally {
        await outer.dispose()
      }
    })
  })
})

describe('installing over an existing installation', () => {
  it('stops proxying when the mounted policy proxies nothing', async () => {
    const outer = await install(proxyAll())
    try {
      await expect((await fetch(proxyTarget)).text()).resolves.toBe('VIA-PROXY')
      const off = await install(env({}))
      try {
        // `mode: 'off'` must actually stop proxying, not merely report a direct policy while the
        // launcher's agent keeps tunnelling. A direct hop needs a host that answers, so this one
        // reaches the real origin rather than the name only the proxy can resolve.
        await expect((await fetch(originUrl)).text()).resolves.toBe('DIRECT')
        expect(proxyRouteFor(new URL(proxyTarget))).toEqual({ proxied: false })
      } finally {
        await off.dispose()
      }
      // Disposing the direct policy restores the proxy the launcher installed.
      await expect((await fetch(proxyTarget)).text()).resolves.toBe('VIA-PROXY')
      expect(proxyRouteFor(new URL(proxyTarget)).proxied).toBe(true)
    } finally {
      await outer.dispose()
    }
  })
})

describe('the environment while a direct policy is layered over a proxied one', () => {
  it('hands a child the user\'s own values, and the outer normalization again afterwards', async () => {
    await withCleanProxyEnv(async () => {
      // The user exported one usable proxy and one this package refuses.
      process.env.HTTP_PROXY = proxyUrl
      process.env.https_proxy = 'socks5://127.0.0.1:1080'
      const outer = await install(env({ HTTP_PROXY: proxyUrl, https_proxy: 'socks5://127.0.0.1:1080' }))
      try {
        // The outer install published its policy: the refused scheme is removed in both casings.
        expect([process.env.HTTPS_PROXY, process.env.https_proxy]).toEqual([undefined, undefined])
        const off = await install(env({}))
        try {
          // A spawned child copies `process.env`, and `proxyEnvironmentForChild()` adds nothing under a
          // direct policy — so what it copies has to be the user's own environment, not a normalization
          // no active policy stands behind: the SOCKS value they set for `curl` is theirs again.
          expect(process.env.HTTP_PROXY).toBe(proxyUrl)
          expect([process.env.HTTPS_PROXY, process.env.https_proxy]).toContain('socks5://127.0.0.1:1080')
          expect(proxyEnvironmentForChild()).toEqual({})
        } finally {
          await off.dispose()
        }
        // Ending the window re-applies what the outer install published.
        expect([process.env.HTTPS_PROXY, process.env.https_proxy]).toEqual([undefined, undefined])
        expect(process.env.HTTP_PROXY).toBe(proxyUrl)
      } finally {
        await outer.dispose()
      }
    })
  })

  it('touches no environment when the install underneath proxied nothing', async () => {
    process.env.HTTP_PROXY = 'http://untouched.example'
    const outer = await install(env({}))
    const inner = await install(env({}))
    try {
      expect(process.env.HTTP_PROXY).toBe('http://untouched.example')
    } finally {
      await inner.dispose()
      await outer.dispose()
      expect(process.env.HTTP_PROXY).toBe('http://untouched.example')
      delete process.env.HTTP_PROXY
    }
  })
})

describe('the published environment', () => {
  it('restores every name from one snapshot taken before any write', async () => {
    process.env.http_proxy = 'http://before.example'
    process.env.HTTP_PROXY = 'http://before.example'
    const { dispose } = await install(proxyAll())
    expect(process.env.HTTP_PROXY).toBe(proxyUrl)
    await dispose()
    // Reading the uppercase spelling after writing the lowercase one must not restore the value
    // just written — the failure Windows's case-folded environment would produce.
    expect(process.env.http_proxy).toBe('http://before.example')
    expect(process.env.HTTP_PROXY).toBe('http://before.example')
    delete process.env.http_proxy
    delete process.env.HTTP_PROXY
  })
})

describe('clearedProxyEnv', () => {
  it('names every proxy variable for removal, so a replay reaches its own fixture server', () => {
    const cleared = clearedProxyEnv()
    expect(Object.keys(cleared).sort()).toEqual([...PROXY_ENV_NAMES].sort())
    expect(Object.values(cleared).every(value => value === undefined)).toBe(true)
  })
})
