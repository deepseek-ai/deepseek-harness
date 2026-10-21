import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Events } from '@deepseek-ai/cordis'
import { bindScopeParent, createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { PreToolDecision, ToolDefinition, ToolExecution, ToolExecutionInput, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'

import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'

const testToolSignal = new AbortController().signal

/** Mount the registry (with its systemPrompt dependency) on a fresh context. */
async function mount(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  return ctx
}

/** Mint a scope whose key doubles as a minimal Agent-like object. */
async function mintAgentScope(ctx: Context, name: string): Promise<{ scope: Scope; key: Agent }> {
  const key = { id: name as SessionId } as Agent
  let scope!: Scope
  // The scoped context resolves services through the MINTING plugin's
  // dependency chain — the minter must inject what scope holders will reach
  // (in production the agent loop's inject list plays this role).
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, key) },
    { inject: ['tools', 'systemPrompt'] }))
  return { scope, key }
}

function tool(name: string, reply = `ran:${name}`): ToolDefinition {
  return {
    name,
    description: `tool ${name}`,
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value as string }],
    },
    execute: (): Promise<string> => Promise.resolve(reply),
  }
}

async function run(ctx: Context, name: string, agent?: Agent): Promise<string> {
  const result = await executeToolFixture(ctx, {
    signal: testToolSignal,
    callId: ToolCallId('c1'),
    name,
    arguments: {},
    ...agent ? { agent } : {},
  })
  const first = result.content[0]
  return first?.type === 'text' ? first.text : JSON.stringify(result.content)
}

describe('scoped tool registration', () => {
  it('keeps final-result observers synchronous', () => {
    type ToolResultListener = Events['tools/result']
    type AsyncToolResultListener = () => Promise<void>

    expectTypeOf<AsyncToolResultListener>().not.toExtend<ToolResultListener>()
    expectTypeOf<ReturnType<ToolResultListener>>().toEqualTypeOf<undefined>()
  })

  it('files a scoped tool in its layer: visible/executable for that scope only', async () => {
    const ctx = await mount()
    const { scope, key } = await mintAgentScope(ctx, 'a')
    const other = { id: 'other' as SessionId } as Agent
    ctx.tools.register(tool('shared'))
    scope.ctx.tools.register(tool('mine'))

    expect(ctx.tools.schemas(key).map(t => t.name).sort()).toEqual(['mine', 'shared'])
    expect(ctx.tools.schemas().map(t => t.name)).toEqual(['shared'])
    expect(ctx.tools.schemas(other).map(t => t.name)).toEqual(['shared'])

    expect(await run(ctx, 'mine', key)).toBe('ran:mine')
    // Out-of-view execution is indistinguishable from a nonexistent tool.
    expect(await run(ctx, 'mine', other)).toBe('Error: unknown tool "mine"')
    expect(await run(ctx, 'mine')).toBe('Error: unknown tool "mine"')
  })

  it('scoped shadows global on a name conflict, in either registration order', async () => {
    const ctx = await mount()
    const { scope, key } = await mintAgentScope(ctx, 'a')
    // scoped-then-global
    scope.ctx.tools.register(tool('bash', 'restricted-bash'))
    ctx.tools.register(tool('bash', 'global-bash'))
    expect(await run(ctx, 'bash', key)).toBe('restricted-bash')
    expect(await run(ctx, 'bash')).toBe('global-bash')
    expect(ctx.tools.get('bash', key)?.description).toBe(ctx.tools.get('bash', key)?.description)
    // Exactly one 'bash' in the scope's schema view (the shadow, not a double).
    expect(ctx.tools.schemas(key).filter(t => t.name === 'bash')).toHaveLength(1)
  })

  it('rejects a duplicate name within one layer, naming agent.ctx for the global case', async () => {
    const ctx = await mount()
    const { scope } = await mintAgentScope(ctx, 'a')
    ctx.tools.register(tool('x'))
    expect(() => ctx.tools.register(tool('x'))).toThrow(/agent\.ctx/)
    scope.ctx.tools.register(tool('y'))
    expect(() => scope.ctx.tools.register(tool('y'))).toThrow(/already registered in this scope/)
  })

  it('disposing the scope unwinds its registrations and leaves no residue', async () => {
    const ctx = await mount()
    const { scope, key } = await mintAgentScope(ctx, 'a')
    scope.ctx.tools.register(tool('mine'))
    expect(ctx.tools.get('mine', key)).toBeDefined()
    await scope.dispose()
    expect(ctx.tools.get('mine', key)).toBeUndefined()
    expect(ctx.tools.schemas(key)).toEqual([])
  })
})

describe('restrict()', () => {
  it('masks global tools, merges scope-local tools afterward, and keeps assembly with execution', async () => {
    const ctx = await mount()
    const { scope, key } = await mintAgentScope(ctx, 'a')
    ctx.tools.register(tool('read'))
    ctx.tools.register(tool('bash'))
    scope.ctx.tools.register(tool('capture'))
    scope.ctx.tools.restrict({ allow: ['read'] })

    // The scope-local registration survives the allow-list; the unlisted global is gone.
    expect(ctx.tools.schemas(key).map(t => t.name).sort()).toEqual(['capture', 'read'])
    expect(await run(ctx, 'bash', key)).toBe('Error: unknown tool "bash"')
    expect(await run(ctx, 'read', key)).toBe('ran:read')
    expect(await run(ctx, 'capture', key)).toBe('ran:capture')
    // Other scopes and the global view are untouched.
    expect(ctx.tools.schemas().map(t => t.name).sort()).toEqual(['bash', 'read'])
  })

  it('applies snapshotted filters to the live global registry before merging later scope-local tools', async () => {
    const ctx = await mount()
    const denied = await mintAgentScope(ctx, 'denied')
    const allowed = await mintAgentScope(ctx, 'allowed')
    ctx.tools.register(tool('read'))
    ctx.tools.register(tool('bash'))
    denied.scope.ctx.tools.restrict({ deny: ['bash'] })
    allowed.scope.ctx.tools.restrict({ allow: ['read'] })

    ctx.tools.register(tool('web'))
    denied.scope.ctx.tools.register(tool('denied-local'))
    allowed.scope.ctx.tools.register(tool('allowed-local'))

    expect(ctx.tools.schemas(denied.key).map(t => t.name).sort())
      .toEqual(['denied-local', 'read', 'web'])
    expect(ctx.tools.schemas(allowed.key).map(t => t.name).sort())
      .toEqual(['allowed-local', 'read'])
    expect(await run(ctx, 'web', denied.key)).toBe('ran:web')
    expect(await run(ctx, 'web', allowed.key)).toBe('Error: unknown tool "web"')
    expect(await run(ctx, 'denied-local', denied.key)).toBe('ran:denied-local')
    expect(await run(ctx, 'allowed-local', allowed.key)).toBe('ran:allowed-local')
  })

  it('composes multiple restrictions by intersection and lifts each independently', async () => {
    const ctx = await mount()
    const { scope, key } = await mintAgentScope(ctx, 'a')
    for (const name of ['a', 'b', 'c']) ctx.tools.register(tool(name))
    const liftAllow = scope.ctx.tools.restrict({ allow: ['a', 'b'] })
    scope.ctx.tools.restrict({ deny: ['b'] })
    expect(ctx.tools.schemas(key).map(t => t.name)).toEqual(['a'])
    liftAllow()
    // The deny remains after the allow-list is lifted.
    expect(ctx.tools.schemas(key).map(t => t.name).sort()).toEqual(['a', 'c'])
  })

  it('compiles the readonly filter values at registration', async () => {
    const ctx = await mount()
    const { scope, key } = await mintAgentScope(ctx, 'a')
    ctx.tools.register(tool('a'))
    ctx.tools.register(tool('b'))
    const filter = { deny: ['a'] }
    scope.ctx.tools.restrict(filter)
    filter.deny.push('b')
    expect(ctx.tools.schemas(key).map(t => t.name)).toEqual(['b'])
  })

  it('fails loud on an unscoped call, an empty filter, and names it does not inherit', async () => {
    const ctx = await mount()
    const { scope } = await mintAgentScope(ctx, 'a')
    ctx.tools.register(tool('real'))
    scope.ctx.tools.register(tool('local'))
    expect(() => ctx.tools.restrict({ deny: ['real'] })).toThrow(/requires a scoped context/)
    expect(() => scope.ctx.tools.restrict({})).toThrow(/no-op/)
    // A scope's own registration is exempt from its own filter, so naming it
    // is a caller error rather than a silent no-op.
    expect(() => scope.ctx.tools.restrict({ allow: ['local'] })).toThrow(/unknown global tool "local"/)
    expect(() => scope.ctx.tools.restrict({ allow: ['reall'] })).toThrow(/unknown global tool "reall".*known global tools: real/s)
    expect(() => scope.ctx.tools.restrict({ deny: ['ghost', 'wraith'] })).toThrow(/unknown global tools "ghost", "wraith"/)

    const emptyCtx = await mount()
    const { scope: emptyScope } = await mintAgentScope(emptyCtx, 'empty')
    expect(() => emptyScope.ctx.tools.restrict({ deny: ['ghost'] }))
      .toThrow(/known global tools: \(none\)/)
  })
})

describe('restrict() over an inherited scope layer', () => {
  /** Mint a child scope parented to `parent`, as a subagent's creation window does. */
  async function mintChild(ctx: Context, parentKey: Agent, name: string): Promise<{ scope: Scope; key: Agent }> {
    const key = { id: name as SessionId } as Agent
    bindScopeParent(key, parentKey)
    let scope!: Scope
    await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, key) },
      { inject: ['tools', 'systemPrompt'] }))
    return { scope, key }
  }

  it('filters tools the child inherits from an ancestor scope, not only global ones', async () => {
    // The shape every preset deployment has: no model-facing row in the global
    // layer, all of them contributed by an ancestor scope the child joined.
    const ctx = await mount()
    const parent = await mintAgentScope(ctx, 'parent')
    parent.scope.ctx.tools.register(tool('bash'))
    parent.scope.ctx.tools.register(tool('read'))
    const child = await mintChild(ctx, parent.key, 'child')

    expect(ctx.tools.schemas(child.key).map(t => t.name).sort()).toEqual(['bash', 'read'])
    child.scope.ctx.tools.restrict({ deny: ['bash'] })

    // Reading the exempt set as "the global layer" left this unfiltered, and
    // the name unrestrictable in the first place.
    expect(ctx.tools.schemas(child.key).map(t => t.name)).toEqual(['read'])
    expect(await run(ctx, 'bash', child.key)).toBe('Error: unknown tool "bash"')
    // The ancestor keeps its whole surface: a child's filter is its own.
    expect(ctx.tools.schemas(parent.key).map(t => t.name).sort()).toEqual(['bash', 'read'])
  })

  it('keeps the child\'s own registrations outside its own filter', async () => {
    // The delegation runtime registers a child's reporting and structured
    // output tools into the child's own layer; an `allow` naming only the
    // capabilities the child may use must not strip them.
    const ctx = await mount()
    const parent = await mintAgentScope(ctx, 'parent')
    parent.scope.ctx.tools.register(tool('bash'))
    parent.scope.ctx.tools.register(tool('read'))
    const child = await mintChild(ctx, parent.key, 'child')
    child.scope.ctx.tools.register(tool('report'))

    child.scope.ctx.tools.restrict({ allow: ['read'] })

    expect(ctx.tools.schemas(child.key).map(t => t.name).sort()).toEqual(['read', 'report'])
    expect(await run(ctx, 'report', child.key)).toBe('ran:report')
  })

  it('lets an ancestor\'s restriction reach every scope nested inside it', async () => {
    const ctx = await mount()
    ctx.tools.register(tool('web'))
    const parent = await mintAgentScope(ctx, 'parent')
    parent.scope.ctx.tools.register(tool('bash'))
    const child = await mintChild(ctx, parent.key, 'child')
    parent.scope.ctx.tools.restrict({ deny: ['web'] })

    expect(ctx.tools.schemas(child.key).map(t => t.name)).toEqual(['bash'])
    expect(ctx.tools.schemas(parent.key).map(t => t.name)).toEqual(['bash'])
  })
})

describe('scoped execution dispatch', () => {
  it('an agent.ctx pre-execute listener gates only its own agent (and never subject-less calls)', async () => {
    const ctx = await mount()
    const { scope, key } = await mintAgentScope(ctx, 'a')
    const other = { id: 'other' as SessionId } as Agent
    ctx.tools.register(tool('t'))

    const seen: (string | undefined)[] = []
    scope.ctx.on('tools/pre-execute', (exec: ToolExecution, _next: () => Promise<PreToolDecision>) => {
      seen.push(exec.agent?.id)
      return Promise.resolve<PreToolDecision>({ kind: 'deny', reason: 'scoped veto' })
    })

    expect(await run(ctx, 't', key)).toBe('Error: scoped veto')
    expect(await run(ctx, 't', other)).toBe('ran:t')
    expect(await run(ctx, 't')).toBe('ran:t')
    expect(seen).toEqual(['a'])
  })

  it('applies scoped guards after pre-execute and unwinds duplicate registrations independently', async () => {
    const ctx = await mount()
    const { scope, key } = await mintAgentScope(ctx, 'a')
    const other = { id: 'other' as SessionId } as Agent
    let bodyCalls = 0
    ctx.tools.register({
      ...tool('t'),
      execute: () => {
        bodyCalls += 1
        return Promise.resolve('ran:t')
      },
    })
    const guard = (execution: Readonly<ToolExecution>): string => {
      expect(Object.isFrozen(execution.arguments)).toBe(true)
      return 'terminal policy'
    }
    const liftFirst = scope.ctx.tools.guard(guard)
    scope.ctx.tools.guard(guard)
    // Registered later and prepended outside every existing waterfall listener:
    // it can force the extensible pre decision to allow, but cannot bypass the
    // owner-level monotonic guard that runs after the waterfall.
    scope.ctx.on('tools/pre-execute', () => Promise.resolve({ kind: 'allow' }), { prepend: true })

    expect(await run(ctx, 't', key)).toBe('Error: terminal policy')
    expect(await run(ctx, 't', other)).toBe('ran:t')
    expect(bodyCalls).toBe(1)

    liftFirst()
    expect(await run(ctx, 't', key)).toBe('Error: terminal policy')
    await scope.dispose()
    expect(await run(ctx, 't', key)).toBe('ran:t')
    expect(bodyCalls).toBe(2)
  })

  it('composes global guards monotonically when one abstains and a later one denies', async () => {
    const ctx = await mount()
    let bodyCalls = 0
    ctx.tools.register({
      ...tool('t'),
      execute: () => {
        bodyCalls += 1
        return Promise.resolve('ran:t')
      },
    })
    ctx.tools.guard(() => undefined)
    ctx.tools.guard(() => 'global denial')

    expect(await run(ctx, 't')).toBe('Error: global denial')
    expect(bodyCalls).toBe(0)
  })

  it('live-iterates a guard registered by an earlier guard', async () => {
    const ctx = await mount()
    const calls: string[] = []
    let added = false
    ctx.tools.register(tool('t'))
    ctx.tools.guard(() => {
      calls.push('first')
      if (!added) {
        added = true
        ctx.tools.guard(() => {
          calls.push('late')
          return 'late denial'
        })
      }
      return undefined
    })

    expect(await run(ctx, 't')).toBe('Error: late denial')
    expect(calls).toEqual(['first', 'late'])
  })

  it('defers a scoped guard that replaces the last guard in its generation', async () => {
    const ctx = await mount()
    const { scope, key } = await mintAgentScope(ctx, 'a')
    const calls: string[] = []
    ctx.tools.register(tool('t'))
    scope.ctx.tools.register(tool('scope_sibling'))
    const lift = scope.ctx.tools.guard(() => {
      calls.push('first')
      lift()
      scope.ctx.tools.guard(() => {
        calls.push('replacement')
        return 'replacement denial'
      })
      return undefined
    })

    expect(await run(ctx, 't', key)).toBe('ran:t')
    expect(calls).toEqual(['first'])
    expect(await run(ctx, 't', key)).toBe('Error: replacement denial')
    expect(calls).toEqual(['first', 'replacement'])
  })

  it('shares one token and materialized argument value across the pipeline', async () => {
    const ctx = await mount()
    const { scope, key } = await mintAgentScope(ctx, 'a')
    let safeCalls = 0
    let dangerCalls = 0
    let scopedResults = 0
    let safeArguments: unknown
    const tokens = new Set<ToolExecutionToken>()
    ctx.tools.register({
      ...tool('safe'),
      execute: (args) => {
        safeCalls += 1
        safeArguments = args
        return Promise.resolve('safe')
      },
    })
    ctx.tools.register({
      ...tool('danger'),
      execute: () => {
        dangerCalls += 1
        return Promise.resolve('danger')
      },
    })
    scope.ctx.tools.guard(exec => exec.name === 'danger' ? 'danger denied' : undefined)
    ctx.on('tools/pre-execute', (exec, next) => {
      tokens.add(exec.token)
      expect(Object.isFrozen(exec.arguments)).toBe(true)
      return next()
    })
    ctx.on('tools/execute', (exec, next) => {
      tokens.add(exec.token)
      return next()
    })
    ctx.on('tools/post-execute', (exec, _result, next) => {
      tokens.add(exec.token)
      return next()
    })
    scope.ctx.on('tools/result', () => { scopedResults += 1 })

    expect(await run(ctx, 'danger', key)).toBe('Error: danger denied')
    const callerArguments = { source: true }
    const safeResult = await executeToolFixture(ctx, {
      signal: testToolSignal,
      callId: ToolCallId('safe-call'),
      name: 'safe',
      arguments: callerArguments,
      agent: key,
    })
    expect(safeResult.content[0]).toMatchObject({ text: 'safe' })
    expect(Object.isFrozen(callerArguments)).toBe(false)
    expect(safeArguments).not.toBe(callerArguments)
    expect(Object.isFrozen(safeArguments)).toBe(true)
    expect(callerArguments).toEqual({ source: true })
    // One token for danger and one shared by every phase of safe.
    expect(tokens.size).toBe(2)
    expect({ safeCalls, dangerCalls, scopedResults }).toEqual({
      safeCalls: 1,
      dangerCalls: 0,
      scopedResults: 2,
    })
  })

  it('normalizes non-cloneable arguments and still publishes one scoped final outcome', async () => {
    const ctx = await mount()
    const { scope, key } = await mintAgentScope(ctx, 'a')
    let policyCalls = 0
    let bodyCalls = 0
    let scopedObserved = 0
    let globalObserved = 0
    ctx.tools.register({
      ...tool('t'),
      execute: () => {
        bodyCalls += 1
        return Promise.resolve('ran:t')
      },
    })
    ctx.on('tools/pre-execute', (_exec, next) => {
      policyCalls += 1
      return next()
    })
    let parent!: ToolExecutionToken
    ctx.tools.register(tool('parent'))
    const stopCapture = ctx.on('tools/pre-execute', (exec, next) => {
      if (exec.name === 'parent') parent = exec.token
      return next()
    })
    await executeToolFixture(ctx, { signal: testToolSignal, callId: ToolCallId('parent'), name: 'parent', arguments: {} })
    stopCapture()
    policyCalls = 0
    const signal = new AbortController().signal
    scope.ctx.on('tools/result', (exec, result) => {
      scopedObserved += 1
      expect(exec.arguments).toBeUndefined()
      expect(exec.parent).toBe(parent)
      expect(exec.signal).toBe(signal)
      expect(Object.isFrozen(exec)).toBe(true)
      expect(result.isError).toBe(true)
    })
    ctx.on('tools/result', () => { globalObserved += 1 })
    const callerArguments = { invalid: () => undefined }

    const scopedResult = await executeToolFixture(ctx, {
      callId: ToolCallId('non-cloneable'),
      name: 't',
      arguments: callerArguments,
      agent: key,
      parent,
      signal,
    })
    const subjectlessResult = await executeToolFixture(ctx, {
      signal: testToolSignal,
      callId: ToolCallId('non-cloneable-subjectless'),
      name: 't',
      arguments: { invalid: () => undefined },
    })
    expect(scopedResult.isError).toBe(true)
    expect(scopedResult.content[0]?.type === 'text' && scopedResult.content[0].text).toContain('losslessly JSON-serializable')
    expect(subjectlessResult.isError).toBe(true)
    expect({ policyCalls, bodyCalls, scopedObserved, globalObserved }).toEqual({
      policyCalls: 0,
      bodyCalls: 0,
      scopedObserved: 1,
      globalObserved: 2,
    })
    expect(Object.isFrozen(callerArguments)).toBe(false)
    expect(callerArguments.invalid).toBeTypeOf('function')
  })

  it('reads a stateful parent accessor once before policy, dispatch, and result observation', async () => {
    const ctx = await mount()
    const observed: (ToolExecutionToken | undefined)[] = []
    ctx.tools.register({
      ...tool('t'),
      execute: (_args, exec) => {
        observed.push(exec.parent)
        return Promise.resolve('ran:t')
      },
    })
    ctx.on('tools/pre-execute', (exec, next) => {
      observed.push(exec.parent)
      return next()
    })
    ctx.on('tools/execute', (exec, next) => {
      observed.push(exec.parent)
      return next()
    })
    ctx.on('tools/result', (exec) => { observed.push(exec.parent) })
    const forged = { fake: true } as unknown as ToolExecutionToken
    let parentReads = 0
    const input = {
      callId: ToolCallId('stateful-parent'),
      name: 't',
      arguments: {},
      signal: testToolSignal,
      get parent(): ToolExecutionToken | undefined {
        parentReads += 1
        return parentReads === 1 ? undefined : forged
      },
    } as ToolExecutionInput

    const result = await executeToolFixture(ctx, input)

    expect(result.isError).toBe(false)
    expect(parentReads).toBe(1)
    expect(observed).toEqual([undefined, undefined, undefined, undefined])
  })

  it('uses one input snapshot for the normalized error shell', async () => {
    const ctx = await mount()
    const { scope, key } = await mintAgentScope(ctx, 'accepted')
    const driftAgent = { id: 'drift' as SessionId } as Agent
    ctx.tools.register(tool('parent'))
    ctx.tools.register(tool('t'))
    let parent!: ToolExecutionToken
    const stopCapture = ctx.on('tools/pre-execute', (exec, next) => {
      if (exec.name === 'parent') parent = exec.token
      return next()
    })
    await executeToolFixture(ctx, { signal: testToolSignal, callId: ToolCallId('parent'), name: 'parent', arguments: {} })
    stopCapture()
    const acceptedSignal = new AbortController().signal
    const driftSignal = new AbortController().signal
    const forged = { fake: true } as unknown as ToolExecutionToken
    const reads = { callId: 0, name: 0, arguments: 0, agent: 0, parent: 0, signal: 0 }
    const input = {
      get callId() { reads.callId += 1; return ToolCallId('unstable-error') },
      get name() { reads.name += 1; return 't' },
      get arguments(): unknown { reads.arguments += 1; return { invalid: () => undefined } },
      get agent() { reads.agent += 1; return reads.agent === 1 ? key : driftAgent },
      get parent() { reads.parent += 1; return reads.parent <= 2 ? parent : forged },
      get signal() { reads.signal += 1; return reads.signal === 1 ? acceptedSignal : driftSignal },
    } as ToolExecutionInput
    let observed: Readonly<ToolExecution> | undefined
    let scopedObserved = 0
    ctx.on('tools/result', (exec) => { observed = exec })
    scope.ctx.on('tools/result', () => { scopedObserved += 1 })

    const result = await executeToolFixture(ctx, input)

    expect(result.isError).toBe(true)
    expect(reads).toEqual({ callId: 1, name: 1, arguments: 1, agent: 1, parent: 1, signal: 1 })
    expect(scopedObserved).toBe(1)
    expect(observed).toMatchObject({
      callId: ToolCallId('unstable-error'),
      name: 't',
      agent: key,
      parent,
      signal: acceptedSignal,
    })
    expect(Object.isFrozen(observed)).toBe(true)
  })

  it('normalizes a throwing arguments accessor without rereading it or losing the final notification', async () => {
    const ctx = await mount()
    ctx.tools.register(tool('t'))
    let argumentReads = 0
    let observed = 0
    ctx.on('tools/result', (exec, result) => {
      observed += 1
      expect(exec.arguments).toBeUndefined()
      expect(result.isError).toBe(true)
    })
    const input = {
      callId: ToolCallId('throwing-arguments'),
      name: 't',
      signal: testToolSignal,
      get arguments(): unknown {
        argumentReads += 1
        throw new Error('getter exploded')
      },
    } as ToolExecutionInput

    const result = await executeToolFixture(ctx, input)

    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'Error: getter exploded' }])
    expect(argumentReads).toBe(1)
    expect(observed).toBe(1)
  })

  it.each([
    ['Map', new Map([['mutable', true]])],
    ['class instance', new (class Arguments { value = 1 })()],
  ])('rejects cloneable non-JSON arguments (%s) before policy or dispatch', async (_kind, argumentsValue) => {
    const ctx = await mount()
    let policyCalls = 0
    let bodyCalls = 0
    let observed = 0
    ctx.tools.register({
      ...tool('t'),
      execute: () => {
        bodyCalls += 1
        return Promise.resolve('ran:t')
      },
    })
    ctx.on('tools/pre-execute', (_exec, next) => {
      policyCalls += 1
      return next()
    })
    ctx.on('tools/result', (exec, result) => {
      observed += 1
      expect(exec.arguments).toBeUndefined()
      expect(result.isError).toBe(true)
    })

    const result = await executeToolFixture(ctx, {
      signal: testToolSignal,
      callId: ToolCallId('bad-arguments'), name: 't', arguments: argumentsValue,
    })

    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{
      type: 'text', text: 'Error: tool execution arguments must be losslessly JSON-serializable',
    }])
    expect({ policyCalls, bodyCalls, observed }).toEqual({ policyCalls: 0, bodyCalls: 0, observed: 1 })
  })

  it('reads nested arguments once into the executed snapshot', async () => {
    const ctx = await mount()
    ctx.tools.register(tool('t'))
    let reads = 0
    const argumentsValue = Object.defineProperty({}, 'value', {
      enumerable: true,
      get: () => ++reads === 1 ? 'safe' : new Map([['mutable', true]]),
    })

    const result = await executeToolFixture(ctx, {
      signal: testToolSignal,
      callId: ToolCallId('unstable-arguments'), name: 't', arguments: argumentsValue,
    })

    expect(reads).toBe(1)
    expect(result).toEqual({
      content: [{ type: 'text', text: 'ran:t' }],
      isError: false,
      value: 'ran:t',
    })
  })

  it('notifies every tools/result observer with the frozen final outcome and contains failures', async () => {
    const ctx = await mount()
    const { scope, key } = await mintAgentScope(ctx, 'a')
    ctx.tools.register(tool('t'))
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => ctx.logger)
    const seen: boolean[] = []
    const dispatchModes: string[] = []
    ctx.on('internal/dispatch', (mode, name) => {
      if (name === 'tools/result') dispatchModes.push(mode)
    })
    ctx.on('tools/execute', async (_exec, next) => {
      await next()
      return {
        content: [{ type: 'text', text: 'outer failure' }],
        isError: true,
        error: { message: 'outer failure' },
      }
    }, { prepend: true })
    scope.ctx.on('tools/result', (_exec, result) => {
      expect(Object.isFrozen(_exec)).toBe(true)
      expect(Object.isFrozen(_exec.arguments)).toBe(true)
      expect(Object.isFrozen(result)).toBe(true)
      expect(Object.isFrozen(result.content)).toBe(true)
      seen.push(result.isError)
    })
    ctx.on('tools/result', () => {
      throw { toString: () => { throw new Error('coercion trap') } }
    })
    ctx.on('tools/result', () => Promise.reject(new Error('async observer failure')) as never)
    ctx.on('tools/result', (_exec, result) => { seen.push(result.isError) })

    const result = await executeToolFixture(ctx, { signal: testToolSignal, callId: ToolCallId('final'), name: 't', arguments: {}, agent: key })
    await Promise.resolve()
    expect(result).toMatchObject({ isError: true, content: [{ type: 'text', text: 'outer failure' }] })
    expect(seen).toEqual([true, true])
    expect(dispatchModes).toEqual(['emit'])
    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn.mock.calls.map(call => String(call[0]))).toEqual(expect.arrayContaining([
      expect.stringContaining('<unprintable thrown value>'),
      expect.stringContaining('async observer failure'),
    ]))
  })
})
