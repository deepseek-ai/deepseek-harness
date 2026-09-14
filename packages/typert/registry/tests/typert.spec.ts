import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import TypertRegistry, {
  typertEndpoint,
  typertKey,
  typertPackageKey,
  type TypertContribution,
} from '@deepseek-ai/dsh-typert-registry'
import type {
  InvocationDescriptor,
  TypertContext,
  TypertLookup,
  TypertRemoteContribution,
} from '@deepseek-ai/dsh-typert-protocol'
import { apply as applyClientRegistry, inject as clientRegistryInject } from '../src/client/index.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertLookupMap {
    fixture: TypertLookup<{ readonly id: string }, string>
  }

  interface TypertContextMap {
    registryFixture: TypertContext<string>
    registryFixtureOther: TypertContext<string>
  }
}

async function makeCtx(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(TypertRegistry)
  return ctx
}

function toolsContribution(schema: z.ZodType = z.object({ name: z.string() })): TypertContribution {
  return {
    package: '@deepseek-ai/dsh-tools',
    face: 'host',
    schemas: [{ name: 'ToolInput', schema }],
    invocations: [],
    model: {
      services: [{
        key: 'tools',
        exportName: 'ToolRuntime',
        summary: 'Tool registry and execution pipeline.',
        tags: [],
        members: [{
          kind: 'method',
          name: 'register',
          signature: 'register(definition: ToolDefinition): () => void',
        }],
        types: [{ name: 'ToolDefinition', declaration: 'export interface ToolDefinition {}' }],
      }],
      events: [{
        name: 'tools/change',
        mode: 'emit',
        signature: "'tools/change'(): void",
        tags: [],
      }],
      objects: [],
    },
  }
}

function invocation(id = '@fixture/remote#goals/create'): InvocationDescriptor {
  return {
    id,
    service: 'goals',
    namespace: 'goals',
    method: 'create',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request',
      wire: 'request',
      source: 'json',
      codec: { mode: 'src-json' },
    }],
    result: { mode: 'src-json' },
  }
}

function scopedInvocation(): InvocationDescriptor {
  return {
    ...invocation('@fixture/remote#goals/create-scoped'),
    scope: { context: 'fixture', wire: 'agentId' },
    parameters: [{
      name: 'agent',
      wire: 'agentId',
      source: 'lookup',
      lookup: 'fixture',
      codec: { mode: 'src-json' },
    }, {
      name: 'request',
      wire: 'request',
      source: 'json',
      codec: { mode: 'src-json' },
    }],
  }
}

describe('TypertRegistry', () => {
  it('registers and queries generated schemas separately from package reflection', async () => {
    const ctx = await makeCtx()
    const contribution = toolsContribution()
    ctx.typert.register(contribution)

    expect(typertKey('@deepseek-ai/dsh-tools', 'ToolInput')).toBe('@deepseek-ai/dsh-tools#ToolInput')
    expect(typertPackageKey('@deepseek-ai/dsh-tools', 'host')).toBe('@deepseek-ai/dsh-tools#host')
    expect(ctx.typert.get('@deepseek-ai/dsh-tools#ToolInput')).toMatchObject({
      package: '@deepseek-ai/dsh-tools',
      face: 'host',
      name: 'ToolInput',
    })
    expect(ctx.typert.get('@deepseek-ai/dsh-tools#ToolInput')?.schema).toBe(contribution.schemas[0]?.schema)
    expect(ctx.typert.getPackage('@deepseek-ai/dsh-tools', 'host')).toMatchObject({
      key: '@deepseek-ai/dsh-tools#host',
      model: { services: [{ key: 'tools' }] },
    })
    expect(ctx.typert.list()).toHaveLength(1)
    expect(ctx.typert.listPackages({ face: 'host' })).toHaveLength(1)
  })

  it('withdraws schemas and package metadata through the exact contribution disposer', async () => {
    const ctx = await makeCtx()
    const dispose = ctx.typert.register(toolsContribution())
    expect(ctx.typert.getPackage('@deepseek-ai/dsh-tools')).toBeDefined()

    await dispose()

    expect(ctx.typert.get('@deepseek-ai/dsh-tools#ToolInput')).toBeUndefined()
    expect(ctx.typert.getPackage('@deepseek-ai/dsh-tools')).toBeUndefined()
    expect(ctx.typert.listPackages()).toEqual([])
  })

  it('follows the registering plugin fiber lifecycle', async () => {
    const ctx = await makeCtx()
    const fiber = ctx.plugin(Object.assign(
      (child: Context) => { child.typert.register(toolsContribution()) },
      { inject: ['typert'] },
    ))
    await fiber
    expect(ctx.typert.getPackage('@deepseek-ai/dsh-tools')).toBeDefined()

    await fiber.dispose()

    expect(ctx.typert.getPackage('@deepseek-ai/dsh-tools')).toBeUndefined()
    expect(ctx.typert.list()).toEqual([])
  })

  it('rejects duplicate package faces and schema keys before committing', async () => {
    const ctx = await makeCtx()
    const original = toolsContribution()
    ctx.typert.register(original)

    expect(() => ctx.typert.register(toolsContribution(z.never()))).toThrow('package face')
    expect(ctx.typert.get('@deepseek-ai/dsh-tools#ToolInput')?.schema).toBe(original.schemas[0]?.schema)

    const duplicateBatch: TypertContribution = {
      ...toolsContribution(),
      package: '@fixture/duplicate',
      schemas: [
        { name: 'Same', schema: z.string() },
        { name: 'Same', schema: z.number() },
      ],
    }
    expect(() => ctx.typert.register(duplicateBatch)).toThrow('schema "@fixture/duplicate#Same" is already registered')
    expect(ctx.typert.getPackage('@fixture/duplicate')).toBeUndefined()
  })

  it('rejects malformed contribution identities and filters both registry views', async () => {
    const ctx = await makeCtx()
    ctx.typert.register(toolsContribution())

    expect(() => ctx.typert.register({ ...toolsContribution(), package: '' }))
      .toThrow('invalid package name')
    expect(() => ctx.typert.register({ ...toolsContribution(), package: 'bad#package' }))
      .toThrow('invalid package name')
    expect(() => ctx.typert.register({ ...toolsContribution(), face: 'worker' as 'host' }))
      .toThrow('invalid face')
    expect(() => ctx.typert.register({
      ...toolsContribution(),
      package: '@fixture/schema-name',
      schemas: [{ name: 'bad#name', schema: z.string() }],
    })).toThrow('invalid schema name')

    expect(ctx.typert.list({ package: '@fixture/absent' })).toEqual([])
    expect(ctx.typert.list({ face: 'client' })).toEqual([])
    expect(ctx.typert.listPackages({ package: '@fixture/absent' })).toEqual([])
    expect(ctx.typert.listPackages({ face: 'client' })).toEqual([])
  })

  it('resolves required schemas and projects fresh JSON Schema documents', async () => {
    const ctx = await makeCtx()
    ctx.typert.register(toolsContribution())

    expect(ctx.typert.resolve('@deepseek-ai/dsh-tools#ToolInput').name).toBe('ToolInput')
    expect(() => ctx.typert.resolve('@deepseek-ai/dsh-tools#Missing')).toThrow('contributes no schema named "Missing"')
    expect(() => ctx.typert.resolve('@fixture/absent#Value')).toThrow('has no registered contribution')
    expect(() => ctx.typert.resolve('invalid')).toThrow('expected "<package>#<name>"')
    const projected = ctx.typert.toJSONSchema('@deepseek-ai/dsh-tools#ToolInput')
    expect(projected).toMatchObject({ type: 'object', properties: { name: { type: 'string' } } })
    expect(ctx.typert.toJSONSchema('@deepseek-ai/dsh-tools#ToolInput')).not.toBe(projected)
  })

  it('registers local invocations atomically with generated reflection', async () => {
    const ctx = await makeCtx()
    const descriptor = invocation()
    const contribution = { ...toolsContribution(), invocations: [descriptor] }
    const changes: string[] = []
    ctx.typert.local.subscribe((change) => { changes.push(`${change.kind}:${change.key}`) })

    expect(ctx.typert.local.hasSeen('goals/create')).toBe(false)
    const dispose = ctx.typert.register(contribution)

    expect(typertEndpoint(descriptor)).toBe('goals/create')
    expect(ctx.typert.local.get('goals/create')).toBe(descriptor)
    expect(ctx.typert.local.hasSeen('goals/create')).toBe(true)
    expect(ctx.typert.local.list()).toEqual([descriptor])
    expect(changes).toEqual(['local:goals/create'])

    await dispose()
    expect(ctx.typert.local.list()).toEqual([])
    expect(ctx.typert.local.hasSeen('goals/create')).toBe(true)
    expect(ctx.typert.getPackage('@deepseek-ai/dsh-tools')).toBeUndefined()
    expect(changes).toEqual(['local:goals/create', 'local:goals/create'])
  })

  it('rejects duplicate invocation endpoints and ids atomically', async () => {
    const ctx = await makeCtx()
    const first = invocation()
    ctx.typert.register({ ...toolsContribution(), invocations: [first] })

    expect(() => ctx.typert.remotes.register({
      package: '@fixture/duplicate-endpoint',
      descriptors: [invocation('@fixture/remote#first'), invocation('@fixture/remote#second')],
    })).toThrow('endpoint "goals/create" is already registered')
    expect(() => ctx.typert.remotes.register({
      package: '@fixture/duplicate-id',
      descriptors: [
        invocation('@fixture/remote#same'),
        { ...invocation('@fixture/remote#same'), method: 'rename' },
      ],
    })).toThrow('invocation id "@fixture/remote#same" is already registered')
    expect(() => ctx.typert.register({
      ...toolsContribution(),
      package: '@fixture/existing-endpoint',
      invocations: [{ ...first, id: '@fixture/local#other' }],
    })).toThrow('endpoint "goals/create" is already registered')
  })

  it.each(['create#v2', 'create goal', '.', '..'])('rejects untransportable invocation method %s', async (method) => {
    const ctx = await makeCtx()
    expect(() => ctx.typert.remotes.register({
      package: '@fixture/invalid-endpoint',
      descriptors: [{ ...invocation(), method }],
    })).toThrow('RPC endpoint segment characters')
  })

  it('mounts Remote contributions in the calling fiber and withdraws them exactly', async () => {
    const ctx = await makeCtx()
    const descriptor = invocation()
    const contribution: TypertRemoteContribution = {
      package: '@fixture/remote',
      descriptors: [descriptor],
    }
    const changes: string[] = []
    ctx.typert.remotes.subscribe((change) => { changes.push(`${change.kind}:${change.key}`) })
    const fiber = ctx.plugin(Object.assign(
      (child: Context) => { child.typert.remotes.register(contribution) },
      { inject: ['typert'] },
    ))
    await fiber

    expect(ctx.typert.remotes.get('goals/create')).toBe(descriptor)
    expect(() => ctx.typert.remotes.register(contribution)).toThrow('Remote package')

    await fiber.dispose()
    expect(ctx.typert.remotes.list()).toEqual([])
    expect(changes).toEqual(['remote:goals/create', 'remote:goals/create'])
  })

  it('accepts only a direct scope selecting its unique lookup parameter', async () => {
    const ctx = await makeCtx()
    const descriptor = scopedInvocation()
    const dispose = ctx.typert.remotes.register({ package: '@fixture/scoped', descriptors: [descriptor] })
    expect(ctx.typert.remotes.get('goals/create')).toBe(descriptor)
    await dispose()

    const cases: readonly [InvocationDescriptor, string][] = [
      [{
        ...descriptor,
        invocation: {
          kind: 'context',
          context: 'fixture',
          wire: 'scopeId',
          codec: { mode: 'src-json' },
        },
      }, 'Context receiver cannot declare a direct scope projection'],
      [{ ...descriptor, scope: { context: 'fixture', wire: 'missingId' } }, 'must select its only lookup parameter'],
      [{
        ...descriptor,
        parameters: [...descriptor.parameters, {
          name: 'other',
          wire: 'otherId',
          source: 'lookup',
          lookup: 'fixture',
          codec: { mode: 'src-json' },
        }],
      }, 'must select its only lookup parameter'],
      [{ ...descriptor, scope: { context: 'other', wire: 'agentId' } }, 'must select its only lookup parameter'],
    ]
    for (const [index, [candidate, message]] of cases.entries()) {
      expect(() => ctx.typert.remotes.register({
        package: `@fixture/rejected-${String(index)}`,
        descriptors: [candidate],
      })).toThrow(message)
    }
    expect(ctx.typert.remotes.list()).toEqual([])
  })

  it('registers lookup and Context providers without domain branches', async () => {
    const ctx = await makeCtx()
    const object = { id: 'agent-1' }
    const scoped = ctx.extend()
    const disposeLookup = ctx.typert.lookups.register('fixture', {
      parameter: 'agent',
      wire: 'agentId',
      hostTypeSymbol: '@fixture/agent#Agent',
      wireTypeSymbol: '@fixture/session#SessionId',
      resolve: id => id === object.id ? object : undefined,
    })
    const disposeHost = ctx.typert.contexts.registerHost('registryFixture', {
      wire: 'agentId',
      wireTypeSymbol: '@fixture/session#SessionId',
      resolve: id => id === object.id ? scoped : undefined,
    })
    const disposeClient = ctx.typert.contexts.registerClient('registryFixture', {
      identity: candidate => candidate === scoped ? object.id : undefined,
      resolve: id => id === object.id ? scoped : undefined,
    })

    expect(ctx.typert.lookups.get('fixture')?.resolve('agent-1')).toBe(object)
    expect(ctx.typert.lookups.definitions()).toEqual([{
      key: 'fixture',
      parameter: 'agent',
      wire: 'agentId',
      hostTypeSymbol: '@fixture/agent#Agent',
      wireTypeSymbol: '@fixture/session#SessionId',
    }])
    expect(ctx.typert.contexts.getHost('registryFixture')?.resolve('agent-1')).toBe(scoped)
    expect(ctx.typert.contexts.getClient('registryFixture')?.identity(scoped)).toBe('agent-1')
    expect(ctx.typert.contexts.getClient('registryFixture')?.resolve('agent-1')).toBe(scoped)

    await Promise.all([disposeClient(), disposeHost(), disposeLookup()])
    expect(ctx.typert.lookups.keys()).toEqual([])
    expect(ctx.typert.lookups.definitions()).toHaveLength(1)
    expect(ctx.typert.contexts.getHost('registryFixture')).toBeUndefined()
    expect(ctx.typert.contexts.getClient('registryFixture')).toBeUndefined()
  })

  it('configures an asynchronous lookup resolver independently of provider load order', async () => {
    const ctx = await makeCtx()
    const fallback = { id: 'fallback' }
    const configured = { id: 'configured' }
    const disposeResolver = ctx.typert.lookups.configure('fixture', async id =>
      id === configured.id ? configured : undefined)

    expect(ctx.typert.lookups.get('fixture')).toBeUndefined()
    const disposeProvider = ctx.typert.lookups.register('fixture', {
      parameter: 'agent',
      wire: 'agentId',
      hostTypeSymbol: '@fixture/agent#Agent',
      wireTypeSymbol: '@fixture/session#SessionId',
      resolve: id => id === fallback.id ? fallback : undefined,
    })
    await expect(ctx.typert.lookups.get('fixture')?.resolve('configured')).resolves.toBe(configured)
    expect(() => ctx.typert.lookups.configure('fixture', () => undefined)).toThrow('already configured')

    await disposeProvider()
    expect(ctx.typert.lookups.get('fixture')).toBeUndefined()
    const disposeReloadedProvider = ctx.typert.lookups.register('fixture', {
      parameter: 'agent',
      wire: 'agentId',
      hostTypeSymbol: '@fixture/agent#Agent',
      wireTypeSymbol: '@fixture/session#SessionId',
      resolve: id => id === fallback.id ? fallback : undefined,
    })
    await expect(ctx.typert.lookups.get('fixture')?.resolve('configured')).resolves.toBe(configured)

    await disposeResolver()
    expect(ctx.typert.lookups.get('fixture')?.resolve('fallback')).toBe(fallback)
    await disposeReloadedProvider()
  })

  it('configures an asynchronous Host Context resolver independently of provider load order', async () => {
    const ctx = await makeCtx()
    const fallback = ctx.extend()
    const configured = ctx.extend()
    const disposeResolver = ctx.typert.contexts.configureHost('registryFixture', async id =>
      id === 'configured' ? configured : undefined)

    expect(ctx.typert.contexts.getHost('registryFixture')).toBeUndefined()
    const disposeProvider = ctx.typert.contexts.registerHost('registryFixture', {
      wire: 'agentId',
      wireTypeSymbol: '@fixture/session#SessionId',
      resolve: id => id === 'fallback' ? fallback : undefined,
    })
    await expect(ctx.typert.contexts.getHost('registryFixture')?.resolve('configured')).resolves.toBe(configured)
    expect(() => ctx.typert.contexts.configureHost('registryFixture', () => undefined)).toThrow('already configured')

    await disposeProvider()
    expect(ctx.typert.contexts.getHost('registryFixture')).toBeUndefined()
    const disposeReloadedProvider = ctx.typert.contexts.registerHost('registryFixture', {
      wire: 'agentId',
      wireTypeSymbol: '@fixture/session#SessionId',
      resolve: id => id === 'fallback' ? fallback : undefined,
    })
    await expect(ctx.typert.contexts.getHost('registryFixture')?.resolve('configured')).resolves.toBe(configured)

    await disposeResolver()
    expect(ctx.typert.contexts.getHost('registryFixture')?.resolve('fallback')).toBe(fallback)
    await disposeReloadedProvider()
  })

  it('publishes provider changes, rejects duplicate providers, and disposes subscriptions', async () => {
    const ctx = await makeCtx()
    const changes: string[] = []
    const disposeLookupSubscription = ctx.typert.lookups.subscribe((change) => {
      changes.push(`${change.kind}:${change.key}`)
    })
    const disposeContextSubscription = ctx.typert.contexts.subscribe((change) => {
      changes.push(`${change.kind}:${change.key}`)
    })
    const lookup = {
      parameter: 'agent',
      wire: 'agentId',
      hostTypeSymbol: '@fixture#Agent',
      wireTypeSymbol: '@fixture#AgentId',
      resolve: () => undefined,
    }
    const host = {
      wire: 'agentId',
      wireTypeSymbol: '@fixture#AgentId',
      resolve: () => undefined,
    }
    const client = {
      identity: (_candidate: Context) => undefined,
      resolve: () => undefined,
    }
    const disposeLookup = ctx.typert.lookups.register('fixture', lookup)
    const disposeHost = ctx.typert.contexts.registerHost('registryFixture', host)
    const disposeClient = ctx.typert.contexts.registerClient('registryFixture', client)

    expect(() => ctx.typert.lookups.register('fixture', lookup)).toThrow('already registered')
    expect(() => ctx.typert.contexts.registerHost('registryFixture', host)).toThrow('already registered')
    expect(() => ctx.typert.contexts.registerClient('registryFixture', client)).toThrow('already registered')
    await Promise.all([disposeLookup(), disposeHost(), disposeClient()])
    expect(changes).toEqual([
      'lookup:fixture',
      'host-context:registryFixture',
      'client-context:registryFixture',
      'lookup:fixture',
      'host-context:registryFixture',
      'client-context:registryFixture',
    ])

    await Promise.all([disposeLookupSubscription(), disposeContextSubscription()])
    for (const changed of [
      { ...lookup, parameter: 'session' },
      { ...lookup, wire: 'sessionId' },
      { ...lookup, hostTypeSymbol: '@fixture#Session' },
      { ...lookup, wireTypeSymbol: '@fixture#SessionId' },
    ]) {
      expect(() => ctx.typert.lookups.register('fixture', changed))
        .toThrow('changed its wire declaration during this registry lifetime')
    }
    ctx.typert.lookups.register('fixture', lookup)
    expect(changes).toHaveLength(6)
  })

  it('validates every invocation and provider boundary', async () => {
    const ctx = await makeCtx()
    const strict = {
      mode: 'strict' as const,
      typeSymbol: '@fixture#Value',
      schema: z.string(),
    }
    const strictInvocation: InvocationDescriptor = {
      ...invocation('@fixture/remote#strict'),
      implementation: 'remoteExportCreate',
      parameters: [{ name: 'request', wire: 'request', source: 'json', codec: strict }],
      cancellation: { parameter: 'signal' },
      result: strict,
    }
    const dispose = ctx.typert.remotes.register({ package: '@fixture/strict', descriptors: [strictInvocation] })
    await dispose()

    const malformed: readonly [InvocationDescriptor, string][] = [
      [{ ...invocation(), id: '' }, 'invocation id'],
      [{ ...invocation(), namespace: 'bad/name' }, 'namespace'],
      [{ ...invocation(), implementation: 'bad/name' }, 'implementation method'],
      [{
        ...invocation(),
        cancellation: { parameter: 'abort' } as unknown as { readonly parameter: 'signal' },
      }, 'cancellation parameter'],
      [{
        ...invocation(),
        parameters: [
          ...invocation().parameters,
          { name: 'other', wire: 'request', source: 'json', codec: { mode: 'src-json' } },
        ],
      }, 'repeats wire field'],
      [{
        ...invocation(),
        parameters: [{ name: 'agent', wire: 'agentId', source: 'lookup', codec: { mode: 'src-json' } }],
      }, 'has no lookup key'],
      [{
        ...invocation(),
        parameters: [{
          name: 'agent',
          wire: 'agentId',
          source: 'lookup',
          lookup: 'fixture',
          acceptsUndefined: true,
          codec: { mode: 'src-json' },
        }],
      }, 'cannot accept undefined'],
      [{
        ...invocation(),
        parameters: [{
          name: 'request', wire: 'request', source: 'json', lookup: 'fixture', codec: { mode: 'src-json' },
        }],
      }, 'JSON parameter'],
      [{
        ...invocation(),
        invocation: {
          kind: 'context', context: 'registryFixture', wire: 'request', codec: { mode: 'src-json' },
        },
      }, 'repeats wire field'],
      [{
        ...invocation(),
        result: { mode: 'strict', typeSymbol: '', schema: z.string() },
      }, 'type symbol'],
      [{
        ...invocation(),
        result: { mode: 'strict', typeSymbol: '@fixture#Broken', schema: {} as z.ZodType },
      }, 'has no parse'],
    ]
    for (const [index, [descriptor, message]] of malformed.entries()) {
      expect(() => ctx.typert.remotes.register({
        package: `@fixture/malformed-${String(index)}`,
        descriptors: [descriptor],
      })).toThrow(message)
    }

    expect(() => ctx.typert.lookups.register('bad#key' as 'fixture', {
      parameter: 'agent',
      wire: 'agent/id',
      hostTypeSymbol: '',
      wireTypeSymbol: '',
      resolve: () => undefined,
    })).toThrow('lookup key')
    expect(() => ctx.typert.lookups.register('fixture', {
      parameter: 'agent',
      wire: 'agent/id',
      hostTypeSymbol: '@fixture#Agent',
      wireTypeSymbol: '@fixture#AgentId',
      resolve: () => undefined,
    })).toThrow('lookup wire field')
  })

  it('installs the registry through the Client entry without importing the Host entry', async () => {
    const ctx = new Context()
    await ctx.plugin({ inject: clientRegistryInject, apply: applyClientRegistry })
    expect(ctx.typert.list()).toEqual([])
  })

  it('contains change-listener failures and still notifies later listeners', async () => {
    const ctx = await makeCtx()
    const warnings: unknown[] = []
    ctx.logger.warn = ((message: unknown) => { warnings.push(message) }) as typeof ctx.logger.warn
    let observed = 0
    ctx.typert.remotes.subscribe(() => { throw new Error('observer failed') })
    ctx.typert.remotes.subscribe(() => { observed += 1 })

    ctx.typert.remotes.register({ package: '@fixture/remote', descriptors: [invocation()] })

    expect(observed).toBe(1)
    expect(warnings.map(String)).toContain('Error: observer failed')
  })
})
