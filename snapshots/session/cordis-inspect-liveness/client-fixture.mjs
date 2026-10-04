/** Browser transport fixture using real Gateway event streams and Client inspect queries. */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerSilentClientTransport } from '../cordis-inspect-timeout/client-fixture.mjs'

export const name = 'client-inspect-liveness-fixture'
export const inject = ['cordisInspect', 'agents', 'llm', 'typertGateway']

/**
 * Leave a disconnected query pending until timeout, then answer after reconnection.
 * @param {import('@deepseek-ai/cordis').Context} ctx - isolated snapshot Host.
 */
export function apply(ctx) {
  const open = registerSilentClientTransport(ctx)
  const expected = readFileSync(process.env.DSH_SNAPSHOT_FILE, 'utf8').trim().split('\n')
    .map(line => JSON.parse(line))
    .filter(event => event.type === 'tool/result')
    .map(event => event.data.message)
  const resultFields = message => ({
    toolCallId: message.toolCallId,
    content: message.content,
    isError: message.isError,
  })
  const queries = []
  const resolved = []
  let requests = 0
  let client
  ctx.on('llm/stream', async function* (options, next) {
    // Log comparison does not verify tool messages at llm/stream.
    // The checked fields stay pinned to the input recording during refresh.
    assert.deepEqual(
      options.messages.filter(message => message.role === 'tool').map(resultFields),
      expected.slice(0, requests).map(resultFields),
      'Each continuing model request receives the recorded Client liveness results',
    )
    switch (requests++) {
      case 0:
        assert.equal(ctx.typertGateway.hasLiveClient(), false)
        break
      case 1:
        assert.equal(queries.length, 0, 'An offline query never reaches the browser transport')
        client = await open()
        break
      case 2:
        assert.equal(ctx.typertGateway.hasLiveClient(), false)
        assert.equal(queries.length, 1)
        assert.deepEqual(resolved, queries, 'Timeout settles the disconnected query')
        await client.close()
        client = await open()
        break
      case 3:
        assert.equal(queries.length, 2)
        assert.deepEqual(resolved, queries, 'The reconnected query settles separately')
        assert.equal(ctx.typertGateway.hasLiveClient(), true)
        await client.close()
        assert.equal(ctx.typertGateway.hasLiveClient(), false)
        break
      default:
        assert.fail('Unexpected model request after Client inspection recovered')
    }
    yield* next()
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
  ctx.on('cordis/inspect-query-resolved', ({ requestId }) => { resolved.push(requestId) })
  ctx.on('cordis/inspect-query', (request) => {
    assert.equal(ctx.typertGateway.hasLiveClient(), true)
    assert.deepEqual(request.input, { service: 'remote' })
    queries.push(request.requestId)
    if (queries.length === 1) {
      client.abort()
      assert.equal(ctx.typertGateway.hasLiveClient(), false)
      assert.deepEqual(resolved, [], 'Disconnection leaves the query pending until timeout')
      return
    }
    assert.equal(queries.length, 2)
    assert.notEqual(queries[0], request.requestId)
    const agent = ctx.agents.get(request.agentId)
    assert.ok(agent, 'Client inspect request has an owning Agent')
    assert.deepEqual(ctx.cordisInspect.resolveClientQuery(agent, request.requestId, {
      ok: true,
      data: { service: 'remote' },
    }), { accepted: true })
  })
}
