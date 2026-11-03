import { describe, expect, it, vi } from 'vitest'

/** Calls the helper made into its collaborators, in call order. */
const calls = vi.hoisted(() => ({
  create: [] as { options: Record<string, unknown> }[],
  fetch: [] as { dispatcher?: unknown }[],
  closed: 0,
  /** What the dispatcher factory answered for one proxy name the environment carries and one it does not. */
  proxyLookups: [] as ({ value: string } | undefined)[][],
}))

vi.mock('@deepseek-ai/dsh-http-proxy', () => ({
  createRouteDispatcher: async (env: { get(name: string): { value: string } | undefined }, options: Record<string, unknown>) => {
    calls.create.push({ options })
    calls.proxyLookups.push([env.get('HTTPS_PROXY'), env.get('DSH_RELAY_FETCH_TEST_UNSET')])
    return { close: async () => { calls.closed += 1 } }
  },
}))

vi.mock('undici', () => ({
  fetch: async (_input: unknown, init: Record<string, unknown>) => {
    calls.fetch.push(init)
    return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } })
  },
}))

import { closeRelayFetch, configureRelayFetchEnvironment, relayFetch } from '../src/host/relay-fetch.ts'

describe('relayFetch', () => {
  it('uses a private proxy-aware HTTP/2 dispatcher', async () => {
    const response = await relayFetch('https://relay.test/__liveshare/share')
    expect(await response.json()).toEqual({ ok: true })
    expect(calls.create).toEqual([{ options: { allowH2: true } }])
    expect(calls.fetch).toHaveLength(1)
    expect(calls.fetch[0]?.dispatcher).toBeDefined()
  })

  it('closes the dispatcher when the host unloads', async () => {
    await relayFetch('https://relay.test/__liveshare/share')
    await closeRelayFetch()
    expect(calls.closed).toBe(1)
    await closeRelayFetch()
    expect(calls.closed).toBe(1)
  })

  it('does not fall back to a replaced global fetch in production', async () => {
    const replacement = vi.fn(async () => new Response('{"replaced":true}'))
    const previous = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    vi.stubGlobal('fetch', replacement)
    try {
      const response = await relayFetch('https://relay.test/__liveshare/share')
      expect(await response.json()).toEqual({ ok: true })
      expect(replacement).not.toHaveBeenCalled()
      expect(calls.fetch.at(-1)?.dispatcher).toBeDefined()
    } finally {
      process.env.NODE_ENV = previous
      vi.unstubAllGlobals()
    }
  })

  it('delegates to a replaced global fetch while running under test', async () => {
    const replacement = vi.fn(async () => new Response('{"replaced":true}'))
    const previousNodeEnv = process.env.NODE_ENV
    process.env.NODE_ENV = 'test'
    vi.stubGlobal('fetch', replacement)
    try {
      const response = await relayFetch('https://relay.test/__liveshare/share')
      expect(await response.json()).toEqual({ replaced: true })
      expect(replacement).toHaveBeenCalledWith('https://relay.test/__liveshare/share', {})
    } finally {
      vi.unstubAllGlobals()
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = previousNodeEnv
    }
  })

  it('resolves the dispatcher policy from the launcher snapshot when configured', async () => {
    await closeRelayFetch()
    configureRelayFetchEnvironment(name => name === 'HTTPS_PROXY' ? { value: 'http://snapshot-proxy.test:3128' } : undefined)
    try {
      await relayFetch('https://relay.test/__liveshare/share')
      expect(calls.proxyLookups.at(-1)).toEqual([{ value: 'http://snapshot-proxy.test:3128' }, undefined])
    } finally {
      configureRelayFetchEnvironment((name) => {
        const value = process.env[name]
        return value === undefined ? undefined : { value }
      })
      await closeRelayFetch()
    }
  })

  it('resolves the dispatcher policy from the current process environment', async () => {
    const previous = process.env.HTTPS_PROXY
    process.env.HTTPS_PROXY = 'http://relay-proxy.test:3128'
    await closeRelayFetch()
    try {
      await relayFetch('https://relay.test/__liveshare/share')
      expect(calls.proxyLookups.at(-1)).toEqual([{ value: 'http://relay-proxy.test:3128' }, undefined])
    } finally {
      if (previous === undefined) delete process.env.HTTPS_PROXY
      else process.env.HTTPS_PROXY = previous
      await closeRelayFetch()
    }
  })
})
