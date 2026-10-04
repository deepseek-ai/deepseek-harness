import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import TypertGateway from '@deepseek-ai/dsh-api-gateway'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import DynamicCordisRunnerService from '../src/index.ts'
import { CordisInspectRegistryService } from '../src/inspect-registry.ts'
import type { CordisInspectProviderManifest, CordisInspectQueryRequest, CordisInspectRequestId } from '../src/types.ts'
import { AGENT_A, AGENT_B } from './helpers.ts'

const manifest: CordisInspectProviderManifest = {
  id: 'Service',
  description: 'Test Service provider.',
  methods: [{
    name: 'listService',
    description: 'Inspect one service.',
    inputSchema: { type: 'object', properties: { service: { type: 'string' } }, additionalProperties: false },
    outputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  }],
}
const timeout = 'Error: Service.listService: Client inspect query Service.listService timed out after 100ms. '
const failure = { ok: false, reason: 'provider-error', message: 'page failed' } as const

let ctx: Context
let fiber: Fiber
let registry: CordisInspectRegistryService
let requests: CordisInspectQueryRequest[]
let resolved: CordisInspectRequestId[]
let controllers: AbortController[]
let results: Promise<unknown>[]
let disposers: (() => void)[]

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  requests = []
  resolved = []
  controllers = []
  results = []
  disposers = []
  ctx = new Context()
  const mounted = ctx.plugin(CordisInspectRegistryService, 100)
  fiber = mounted
  await mounted
  registry = ctx.cordisInspect
  registry.syncClientManifest([manifest])
  disposers.push(ctx.on('cordis/inspect-query', (request) => { requests.push(request) }))
  disposers.push(ctx.on('cordis/inspect-query-resolved', (event) => { resolved.push(event.requestId) }))
})

afterEach(async () => {
  try {
    for (const controller of controllers) controller.abort()
    await Promise.allSettled(results)
    await ctx.fiber.dispose()
  } finally {
    for (const dispose of disposers) dispose()
    vi.restoreAllMocks()
    vi.useRealTimers()
  }
})

function start() {
  const controller = new AbortController()
  controllers.push(controller)
  let settled = false
  const result = registry.query('client', 'Service', 'listService', { service: 'remote' }, AGENT_A, controller.signal).then(
    (value) => { settled = true; return { value } },
    (error: unknown) => { settled = true; return { error: String(error) } },
  )
  results.push(result)
  return { controller, result, request: requests.at(-1)!, settled: () => settled }
}

function answer(query: ReturnType<typeof start>) {
  return registry.resolveClientQuery(AGENT_A, query.request.requestId, { ok: true, data: { name: 'theme' } })
}

async function connectGatewayClient(): Promise<AbortController> {
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(TypertGateway)
  ctx.effect(() => ctx.typertGateway.registerRemoteEvents(async function* (signal) {
    await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
  }, { home: '/fixture' }))
  const connection = new AbortController()
  const stream = await ctx.typertGateway.wireStream.open('$events', { args: {} }, (async function* () {})(), undefined, connection.signal)
  const client = stream[Symbol.asyncIterator]()
  ctx.effect(() => async () => {
    connection.abort()
    await client.return?.()
  })
  await client.next()
  expect(ctx.typertGateway.hasLiveClient()).toBe(true)
  return connection
}

describe('Client inspect completion', () => {
  it('returns a result when the Gateway has a connected Client', async () => {
    await connectGatewayClient()
    registry.syncClientManifest([manifest])
    const query = start()
    expect(requests).toHaveLength(1)
    expect(answer(query)).toEqual({ accepted: true })
    expect(await query.result).toEqual({ value: { name: 'theme' } })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not dispatch a query when the Gateway has no connected Client', async () => {
    await ctx.plugin(TypertRegistry)
    await ctx.plugin(TypertGateway)
    const query = start()
    expect(requests).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
    expect(await query.result).toEqual({
      error: 'Error: Client inspect query Service.listService has no connected Harness page. Open or reconnect the Harness page, then retry.',
    })
    expect(registry.list()).toHaveLength(1)
  })

  it('keeps the response deadline when the Client disconnects after dispatch', async () => {
    const connection = await connectGatewayClient()
    const query = start()
    expect(requests).toHaveLength(1)
    connection.abort()
    expect(ctx.typertGateway.hasLiveClient()).toBe(false)
    await vi.advanceTimersByTimeAsync(99)
    expect(query.settled()).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await query.result).toEqual({ error: timeout + 'Open or reconnect the Harness page, then retry.' })
    expect(answer(query)).toEqual({ accepted: false })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('returns the Client catalog failure at the deadline instead of losing it', async () => {
    const query = start()
    expect(registry.resolveClientQuery(AGENT_A, query.request.requestId, {
      ok: false, reason: 'provider-error', message: 'no catalogued Service named "remote"',
    })).toEqual({ accepted: false })
    await vi.advanceTimersByTimeAsync(99)
    expect(query.settled()).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await query.result).toEqual({ error: timeout + 'Client failure: provider-error: no catalogued Service named "remote"' })
    expect(resolved).toEqual([query.request.requestId])
    expect(answer(query)).toEqual({ accepted: false })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('allows a later successful page to win after another page fails', async () => {
    const query = start()
    expect(registry.resolveClientQuery(AGENT_A, query.request.requestId, failure)).toEqual({ accepted: false })
    await vi.advanceTimersByTimeAsync(99)
    expect(answer(query)).toEqual({ accepted: true })
    expect(await query.result).toEqual({ value: { name: 'theme' } })
    await vi.advanceTimersByTimeAsync(1000)
    expect(resolved).toEqual([query.request.requestId])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps the first failure when several pages fail', async () => {
    const query = start()
    registry.resolveClientQuery(AGENT_A, query.request.requestId, failure)
    registry.resolveClientQuery(AGENT_A, query.request.requestId, { ...failure, message: 'second failure' })
    await vi.advanceTimersByTimeAsync(100)
    expect(await query.result).toEqual({ error: timeout + 'Client failure: provider-error: page failed' })
  })

  it('retains output validation errors for timeout diagnostics', async () => {
    const query = start()
    expect(registry.resolveClientQuery(AGENT_A, query.request.requestId, { ok: true, data: {} })).toEqual({ accepted: false })
    await vi.advanceTimersByTimeAsync(100)
    expect(await query.result).toHaveProperty('error', expect.stringContaining('Client Cordis inspect Service.listService returned invalid output'))
  })

  it('accepts valid output after an invalid response', async () => {
    const query = start()
    registry.resolveClientQuery(AGENT_A, query.request.requestId, { ok: true, data: {} })
    expect(answer(query)).toEqual({ accepted: true })
    expect(await query.result).toEqual({ value: { name: 'theme' } })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ignores responses from another Agent without retaining their error', async () => {
    const query = start()
    expect(registry.resolveClientQuery(AGENT_B, query.request.requestId, failure)).toEqual({ accepted: false })
    await vi.advanceTimersByTimeAsync(100)
    expect(await query.result).toEqual({ error: timeout + 'Open or reconnect the Harness page, then retry.' })
  })

  it('ends unanswered requests and accepts a fresh retry after manifest publication', async () => {
    const first = start()
    registry.syncClientManifest([manifest])
    expect(requests).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(100)
    expect(await first.result).toEqual({ error: timeout + 'Open or reconnect the Harness page, then retry.' })
    const retry = start()
    expect(retry.request.requestId).not.toBe(first.request.requestId)
    expect(answer(first)).toEqual({ accepted: false })
    expect(answer(retry)).toEqual({ accepted: true })
    expect(await retry.result).toEqual({ value: { name: 'theme' } })
    expect(resolved).toHaveLength(2)
  })

  it('cancels before the deadline and removes its timer and abort listener', async () => {
    const query = start()
    const remove = vi.spyOn(query.controller.signal, 'removeEventListener')
    query.controller.abort()
    expect(await query.result).toEqual({ error: 'Error: Service.listService: Client inspect query Service.listService was cancelled' })
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(vi.getTimerCount()).toBe(0)
    expect(answer(query)).toEqual({ accepted: false })
    await vi.advanceTimersByTimeAsync(100)
    expect(resolved).toEqual([query.request.requestId])
  })

  it('does not dispatch or start a timer for an already cancelled query', async () => {
    const controller = new AbortController()
    controller.abort(new Error('already cancelled'))
    await expect(registry.query('client', 'Service', 'listService', {}, AGENT_A, controller.signal)).rejects.toThrow('already cancelled')
    expect(requests).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('settles all pending requests when the registry is disposed', async () => {
    const first = start()
    const second = start()
    await fiber.dispose()
    for (const query of [first, second]) {
      expect(await query.result).toEqual({ error: 'Error: Service.listService: Client inspect registry was disposed' })
      expect(answer(query)).toEqual({ accepted: false })
    }
    expect(resolved).toEqual([first.request.requestId, second.request.requestId])
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['timeout', 'disposal'] as const)('contains throwing completion subscribers during %s', async (completion) => {
    const error = new Error('subscriber failed')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    disposers.push(ctx.on('cordis/inspect-query-resolved', () => { throw error }))
    const queries = [start(), start()]
    if (completion === 'timeout') await vi.advanceTimersByTimeAsync(100)
    else await fiber.dispose()
    for (const query of queries) {
      expect(await query.result).toHaveProperty('error')
      expect(answer(query)).toEqual({ accepted: false })
    }
    expect(log).toHaveBeenCalledTimes(2)
    expect(log).toHaveBeenCalledWith('[cordis-host-runner] notifying Client inspect completion failed:', error)
    expect(vi.getTimerCount()).toBe(0)
    expect(resolved).toHaveLength(2)
  })

  it('leaves local Host queries outside the Client response deadline', async () => {
    disposers.push(registry.register({ manifest, query: async () => ({ name: 'local' }) }))
    await expect(registry.query('host', 'Service', 'listService', {}, AGENT_A, new AbortController().signal))
      .resolves.toEqual({ name: 'local' })
    expect(requests).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('Client inspect timeout configuration', () => {
  it('defaults to ten seconds and accepts both timer limits', () => {
    expect(DynamicCordisRunnerService.Config({}).clientInspectTimeoutMs).toBe(10_000)
    for (const clientInspectTimeoutMs of [1, 100, 2_147_483_647]) {
      expect(DynamicCordisRunnerService.Config({ clientInspectTimeoutMs }).clientInspectTimeoutMs).toBe(clientInspectTimeoutMs)
    }
  })

  it.each([0, -1, 0.5, Infinity, NaN, 2_147_483_648])('rejects invalid timer budget %s', (clientInspectTimeoutMs) => {
    expect(() => DynamicCordisRunnerService.Config({ clientInspectTimeoutMs })).toThrow()
  })
})
