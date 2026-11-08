import { afterEach, describe, expect, it, vi } from 'vitest'

/** Every dispatcher this suite's mocked undici constructed, in construction order. */
const constructed = vi.hoisted(() => [] as { kind: string; options: Record<string, unknown> }[])

vi.mock('undici', () => {
  class StubDispatcher {
    async close(): Promise<void> {}
  }
  class Agent extends StubDispatcher {
    constructor(options: Record<string, unknown>) {
      super()
      constructed.push({ kind: 'Agent', options })
    }
  }
  class Pool extends StubDispatcher {
    constructor(_origin: unknown, options: Record<string, unknown>) {
      super()
      constructed.push({ kind: 'Pool', options })
    }
  }
  class ProxyAgent extends StubDispatcher {
    constructor(options: Record<string, unknown>) {
      super()
      constructed.push({ kind: 'ProxyAgent', options })
    }
  }
  const dispatcher = new StubDispatcher()
  return {
    Agent,
    Pool,
    ProxyAgent,
    getGlobalDispatcher: () => dispatcher,
    setGlobalDispatcher: () => undefined,
  }
})

import { createRouteDispatcher, installProxyFromEnvironment } from '../src/index.ts'

/** A launch environment with exactly the proxy names a case wants. */
function env(values: Record<string, string>): { get(name: string): { value: string } | undefined } {
  return { get: name => (name in values ? { value: values[name] as string } : undefined) }
}

function lastOf(kind: string): { kind: string; options: Record<string, unknown> } | undefined {
  return constructed.filter(entry => entry.kind === kind).at(-1)
}

afterEach(() => {
  constructed.length = 0
})

describe('HTTP/2 is opt-out, not the default', () => {
  it('keeps undici\'s HTTP/2 default when installation carries no override', async () => {
    const dispose = await installProxyFromEnvironment(env({ HTTP_PROXY: 'http://127.0.0.1:9' }), () => undefined)
    try {
      expect(lastOf('Agent')?.options.allowH2).toBeUndefined()
    } finally {
      await dispose()
    }
  })

  it('pins an installed dispatcher to HTTP/1.1 when the caller passes allowH2 false', async () => {
    const dispose = await installProxyFromEnvironment(
      env({ HTTPS_PROXY: 'http://127.0.0.1:9' }),
      () => undefined,
      { allowH2: false },
    )
    try {
      const agent = lastOf('Agent')
      expect(agent?.options.allowH2).toBe(false)
      const factory = agent?.options.factory as (origin: string, options: Record<string, unknown>) => unknown
      factory('https://proxied.test', {})
      factory('http://direct.test', {})
      expect(lastOf('ProxyAgent')?.options.allowH2).toBe(false)
      expect(lastOf('Pool')?.options.allowH2).toBe(false)
    } finally {
      await dispose()
    }
  })

  it('builds a per-request dispatcher pinned to HTTP/1.1', async () => {
    const dispatcher = await createRouteDispatcher(env({ HTTPS_PROXY: 'http://127.0.0.1:9' }), { allowH2: false })
    try {
      const agent = lastOf('Agent')
      expect(agent?.options.allowH2).toBe(false)
      const factory = agent?.options.factory as (origin: string, options: Record<string, unknown>) => unknown
      factory('https://proxied.test', {})
      factory('http://direct.test', {})
      expect(lastOf('ProxyAgent')?.options.allowH2).toBe(false)
      expect(lastOf('Pool')?.options.allowH2).toBe(false)
    } finally {
      await dispatcher.close()
    }
  })

  it('keeps HTTP/2 enabled when the caller opts in', async () => {
    const proxied = await createRouteDispatcher(env({ HTTPS_PROXY: 'http://127.0.0.1:9' }), { allowH2: true })
    try {
      expect(lastOf('Agent')?.options.allowH2).toBe(true)
      const factory = lastOf('Agent')?.options.factory as (origin: string, options: Record<string, unknown>) => unknown
      factory('https://proxied.test', {})
      expect(lastOf('ProxyAgent')?.options.allowH2).toBe(true)
    } finally {
      await proxied.close()
    }
    const direct = await createRouteDispatcher(env({}), { allowH2: true })
    try {
      expect(lastOf('Agent')?.options.allowH2).toBe(true)
    } finally {
      await direct.close()
    }
  })

  it('pins a direct per-request dispatcher to HTTP/1.1', async () => {
    const dispatcher = await createRouteDispatcher(env({}), { allowH2: false })
    try {
      expect(lastOf('Agent')?.options.allowH2).toBe(false)
    } finally {
      await dispatcher.close()
    }
  })

  it('keeps undici\'s HTTP/2 default for a direct per-request dispatcher', async () => {
    const dispatcher = await createRouteDispatcher(env({}))
    try {
      expect(lastOf('Agent')?.options).toEqual({})
    } finally {
      await dispatcher.close()
    }
  })

  it('pins the direct dispatcher of a policy layered over an installed proxy', async () => {
    const disposeOuter = await installProxyFromEnvironment(env({ HTTP_PROXY: 'http://127.0.0.1:9' }), () => undefined)
    try {
      const disposeLayered = await installProxyFromEnvironment(env({}), () => undefined, { allowH2: false })
      try {
        expect(constructed.at(-1)).toEqual({ kind: 'Agent', options: { allowH2: false } })
      } finally {
        await disposeLayered()
      }
    } finally {
      await disposeOuter()
    }
  })
})
