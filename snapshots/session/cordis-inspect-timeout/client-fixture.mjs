/** Test-only Client transport: one provider failure, then a page that never answers. */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

export const name = 'client-inspect-timeout-fixture'
export const inject = ['cordisInspect', 'agents', 'llm', 'typertGateway']

/**
 * Register a silent event source and open real Gateway Client streams on demand.
 * @param {import('@deepseek-ai/cordis').Context} ctx - owner of the source and streams.
 * @returns opener resolving after readiness, with abort and quiescent close operations.
 */
export function registerSilentClientTransport(ctx) {
  ctx.effect(() => ctx.typertGateway.registerRemoteEvents(async function* (signal) {
    await new Promise(resolve => {
      if (signal.aborted) resolve()
      else signal.addEventListener('abort', resolve, { once: true })
    })
  }, { home: '/snapshot-host' }))
  return async () => {
    const controller = new AbortController()
    const stream = await ctx.typertGateway.wireStream.open(
      '$events', { args: {} }, (async function* () {})(), undefined, controller.signal,
    )
    const iterator = stream[Symbol.asyncIterator]()
    const close = ctx.effect(() => async () => {
      controller.abort()
      await iterator.return?.()
    })
    const ready = await iterator.next()
    assert.equal(ready.done, false)
    assert.equal(ready.value.type, 'ready')
    assert.equal(ctx.typertGateway.hasLiveClient(), true)
    return { abort: () => { controller.abort() }, close }
  }
}

/**
 * Mirror a Client manifest and deliver only the first query's failure.
 * @param {import('@deepseek-ai/cordis').Context} ctx - isolated snapshot Host.
 * @returns after the Gateway Client stream is ready.
 */
export async function apply(ctx) {
  await registerSilentClientTransport(ctx)()
  const expected = readFileSync(process.env.DSH_SNAPSHOT_FILE, 'utf8').trim().split('\n')
    .map(line => JSON.parse(line))
    .filter(event => event.type === 'tool/result')
    .map(event => event.data.message)
  const resultFields = message => ({
    toolCallId: message.toolCallId,
    content: message.content,
    isError: message.isError,
  })
  let requests = 0
  ctx.on('llm/stream', (options, next) => {
    assert.equal(ctx.typertGateway.hasLiveClient(), true)
    // Log comparison does not verify tool messages at llm/stream.
    // The checked fields stay pinned to the input recording during refresh.
    assert.deepEqual(
      options.messages.filter(message => message.role === 'tool').map(resultFields),
      expected.slice(0, requests++).map(resultFields),
      'Each continuing model request receives the recorded Client timeout errors',
    )
    return next()
  })
  ctx.cordisInspect.syncClientManifest([{
    id: 'Service',
    description: 'Snapshot Client Service provider.',
    methods: [{
      name: 'listService',
      description: 'Inspect one Client Service.',
      inputSchema: {
        type: 'object',
        properties: { service: { type: 'string' } },
        additionalProperties: false,
      },
      outputSchema: { type: 'object' },
    }],
  }])
  let queries = 0
  ctx.on('cordis/inspect-query', (request) => {
    if (++queries !== 1) return
    const agent = ctx.agents.get(request.agentId)
    if (agent === undefined) throw new Error('Client inspect request has no owning Agent')
    ctx.cordisInspect.resolveClientQuery(agent, request.requestId, {
      ok: false,
      reason: 'provider-error',
      message: 'no catalogued Service named "remote"',
    })
  })
}
