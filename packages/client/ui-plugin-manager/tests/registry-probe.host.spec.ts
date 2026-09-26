import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { NPMMIRROR_REGISTRY, OFFICIAL_NPM_REGISTRY } from '@deepseek-ai/dsh-plugin-manager/registry'
import PluginRegistryProbe, { type Config } from '../src/index.ts'

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

async function mount(config: Partial<Config> = {}) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(PluginRegistryProbe, PluginRegistryProbe.Config(config))
  return { ctx, probe: ctx.pluginRegistryProbe }
}

function transport() {
  const requests = new Map<string, ReturnType<typeof Promise.withResolvers<Response>> & { signal: AbortSignal }>()
  const fetch = vi.fn((url: string, init: RequestInit) => {
    const signal = init.signal
    if (!signal) throw new Error('Missing probe signal')
    const pending = Promise.withResolvers<Response>()
    const abort = () => { pending.reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    requests.set(url, { ...pending, signal })
    return pending.promise.finally(() => { signal.removeEventListener('abort', abort) })
  })
  vi.stubGlobal('fetch', fetch)
  const request = (registry: string) => {
    const found = requests.get(`${registry}-/ping`)
    if (!found) throw new Error('Probe has not started')
    return found
  }
  return { fetch, request }
}

it.each([OFFICIAL_NPM_REGISTRY, NPMMIRROR_REGISTRY])('shares concurrent probes and caches the first successful response from %s', async (winner) => {
  vi.useFakeTimers()
  const { fetch, request } = transport()
  const { probe } = await mount({ registryProbeCacheTtlMs: 50 })
  const first = probe.fastest()
  const shared = probe.fastest()
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(fetch).toHaveBeenCalledWith(`${winner}-/ping`, expect.objectContaining({ redirect: 'error' }))
  const cancel = vi.fn()
  request(winner).resolve(new Response(new ReadableStream({ cancel })))
  expect(await first).toBe(winner)
  expect(await shared).toBe(winner)
  expect(cancel).toHaveBeenCalledOnce()
  const other = winner === OFFICIAL_NPM_REGISTRY ? NPMMIRROR_REGISTRY : OFFICIAL_NPM_REGISTRY
  expect(request(other).signal.aborted).toBe(true)
  expect(await probe.fastest()).toBe(winner)
  expect(fetch).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(50)
  const refreshed = probe.fastest()
  request(other).resolve(new Response(null, { status: 204 }))
  expect(await refreshed).toBe(other)
  expect(fetch).toHaveBeenCalledTimes(4)
})

it('performs no request when disabled', async () => {
  const { fetch } = transport()
  const { probe } = await mount({ registryProbeEnabled: false })
  expect(await probe.fastest()).toBeNull()
  expect(fetch).not.toHaveBeenCalled()
})

it('ignores a faster HTTP failure and releases both response bodies', async () => {
  const { request } = transport()
  const { probe } = await mount()
  const result = probe.fastest()
  const cancel = vi.fn()
  request(OFFICIAL_NPM_REGISTRY).resolve(new Response(new ReadableStream({ cancel }), { status: 503 }))
  request(NPMMIRROR_REGISTRY).resolve(new Response(null, { status: 204 }))
  expect(await result).toBe(NPMMIRROR_REGISTRY)
  expect(cancel).toHaveBeenCalledOnce()
})

it('caches unavailable results when both registries fail', async () => {
  const { fetch, request } = transport()
  const { probe } = await mount()
  const result = probe.fastest()
  request(OFFICIAL_NPM_REGISTRY).reject(new TypeError('offline'))
  request(NPMMIRROR_REGISTRY).resolve(new Response(null, { status: 500 }))
  expect(await result).toBeNull()
  expect(await probe.fastest()).toBeNull()
  expect(fetch).toHaveBeenCalledTimes(2)
})

it.each(['timeout', 'dispose'] as const)('settles both pending probes on %s', async (cause) => {
  const { request } = transport()
  const { ctx, probe } = await mount({ registryProbeTimeoutMs: 50 })
  const result = probe.fastest()
  if (cause === 'dispose') await ctx.fiber.dispose()
  expect(await result).toBeNull()
  for (const registry of [OFFICIAL_NPM_REGISTRY, NPMMIRROR_REGISTRY]) expect(request(registry).signal.aborted).toBe(true)
  if (cause === 'dispose') await expect(probe.fastest()).rejects.toThrow()
})

it('chooses by response arrival and awaits response-body cleanup before settling', async () => {
  const { request } = transport()
  const { probe } = await mount()
  const cleanup = Promise.withResolvers<undefined>()
  const cancelled = Promise.withResolvers<undefined>()
  const result = probe.fastest()
  const settled = vi.fn()
  void result.then(settled)
  request(OFFICIAL_NPM_REGISTRY).resolve(new Response(new ReadableStream({
    cancel() { cancelled.resolve(undefined); return cleanup.promise },
  })))
  request(NPMMIRROR_REGISTRY).resolve(new Response(null, { status: 204 }))
  try {
    await cancelled.promise
    expect(settled).not.toHaveBeenCalled()
    cleanup.resolve(undefined)
    expect(await result).toBe(OFFICIAL_NPM_REGISTRY)
  } finally {
    cleanup.resolve(undefined)
    await result
  }
})

it('keeps a successful response when discarding its body rejects', async () => {
  const { request } = transport()
  const { probe } = await mount()
  const result = probe.fastest()
  request(NPMMIRROR_REGISTRY).resolve(new Response(new ReadableStream({
    cancel() { return Promise.reject(new Error('body already aborted')) },
  })))
  expect(await result).toBe(NPMMIRROR_REGISTRY)
})

it.each([
  { registryProbeTimeoutMs: 0 }, { registryProbeTimeoutMs: 2_147_483_648 },
  { registryProbeCacheTtlMs: -1 },
])('rejects invalid probe limits %j', (config) => {
  expect(() => PluginRegistryProbe.Config(config)).toThrow()
})
