import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, expect, it } from 'vitest'
import { z } from 'zod'
import { bindTypertRemote, Remote } from '@deepseek-ai/dsh-typert-protocol'
import TypertRegistry, { type TypertContribution } from '@deepseek-ai/dsh-typert-registry'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import TypertGateway from '../src/index.ts'
import { ownerPeer } from './peer.ts'

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })

const contribution: TypertContribution = {
  package: '@fixture/strict', face: 'host', schemas: [],
  model: { services: [], events: [], objects: [] },
  invocations: [{
    id: '@fixture/strict#items/read', service: 'items', namespace: 'items', method: 'read',
    invocation: { kind: 'direct' },
    parameters: [{ name: 'request', wire: 'request', source: 'json', codec: {
      mode: 'strict', typeSymbol: 'Request', create: () => z.strictObject({ title: z.string() }),
    } }],
    result: { mode: 'strict', typeSymbol: 'string', create: () => z.string() },
  }],
}

class ItemsService extends Service {
  readonly typertRemote
  calls = 0
  constructor(ctx: Context) {
    super(ctx, 'items')
    this.typertRemote = bindTypertRemote(this, 'items')
  }
  @Remote
  read(request: { title: string }): string {
    this.calls++
    return request.title
  }
}

async function setup() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(RemoteAccessService)
  await ctx.plugin(TypertGateway)
  const service = new ItemsService(ctx)
  return { ctx, service }
}

it('validates source dispatch with the ordinary local Registry before invoking the Service', async () => {
  const { ctx, service } = await setup()
  ctx.typert.register(contribution)
  await expect(ctx.typertGateway.invoke({ namespace: 'items', method: 'read', args: { request: { title: 'ready' } }, peer: ownerPeer(ctx) }))
    .resolves.toBe('ready')
  for (const args of [{}, { request: { title: 'ready', extra: true } }, { request: { title: 1 } }]) {
    const code: unknown = expect.stringMatching(/^gateway\/(arguments|input)-invalid$/)
    await expect(ctx.typertGateway.invoke({ namespace: 'items', method: 'read', args, peer: ownerPeer(ctx) }))
      .rejects.toMatchObject({ code })
  }
  expect(service.calls).toBe(1)
})

it('allows limited source fallback without recovering erased object constraints', async () => {
  const { ctx, service } = await setup()
  await expect(ctx.typertGateway.invoke({ namespace: 'items', method: 'read', args: { request: { title: 'ready', extra: true } }, peer: ownerPeer(ctx) }))
    .resolves.toBe('ready')
  expect(service.calls).toBe(1)
})

it('refuses source fallback after the strict definition owner unloads', async () => {
  const { ctx, service } = await setup()
  const owner = ctx.plugin({ inject: ['typert'], apply(ctx) { ctx.typert.register(contribution) } })
  await owner
  expect(ctx.typert.local.get('items/read')).toBe(contribution.invocations[0])
  await owner.dispose()
  expect(ctx.typert.local.get('items/read')).toBeUndefined()
  await expect(ctx.typertGateway.invoke({ namespace: 'items', method: 'read', args: { request: { title: 'ready' } }, peer: ownerPeer(ctx) }))
    .rejects.toMatchObject({ code: 'gateway/definition-unavailable' })
  expect(service.calls).toBe(0)
})
