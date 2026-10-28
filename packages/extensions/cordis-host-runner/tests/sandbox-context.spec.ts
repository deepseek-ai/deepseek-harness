import { describe, expect, it } from 'vitest'
import { call, CONTENT_OUTPUT_CODE, dummyTool, mount, setup, text } from './helpers.ts'

/**
 * The sandbox context façade is a whitelist, not a pass-through proxy. A running
 * host half reaches only registration/eventing verbs, timer helpers, guarded
 * tools, and injected services. Framework members that expose an unguarded
 * context are denied because they could bypass marker checks and host-realm
 * normalization; these tests pin that escape class.
 */

/** Run a host half whose `apply` touches one framework member, and report the error text. */
async function runTouching(harness: Awaited<ReturnType<typeof setup>>, expr: string): Promise<string> {
  try {
    await mount(harness, `return { name: 'probe', inject: ['tools'], apply(ctx) { ${expr} } }`)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('expected the host half to fail')
}

describe('sandbox context façade — escape surface is closed', () => {
  it.each([
    ['ctx.root', 'const c = ctx.root'],
    ['ctx.parent', 'const c = ctx.parent'],
    ['ctx.scope', 'const c = ctx.scope'],
    ['ctx.fiber', 'const f = ctx.fiber'],
    ['ctx.reflect', 'const r = ctx.reflect'],
    ['ctx.registry', 'const r = ctx.registry'],
    ['ctx.events', 'const e = ctx.events'],
    ['ctx.extend()', 'ctx.extend({})'],
    ['ctx.isolate()', 'ctx.isolate("x")'],
    ['ctx.intercept()', 'ctx.intercept("x", {})'],
    ['ctx.plugin()', 'ctx.plugin({ apply() {} })'],
    ['ctx.set()', 'ctx.set("tools", 1)'],
    ['ctx.mixin()', 'ctx.mixin("x", [])'],
  ])('denies %s with a teaching error', async (_label, expr) => {
    const harness = await setup()
    const message = await runTouching(harness, expr)
    expect(message).toContain('sandbox ctx does not expose')
    expect(message).toContain('withheld by design')
  })

  it('withholds executor control through ctx.tools.setExecutor', async () => {
    const harness = await setup()
    const message = await runTouching(harness, 'ctx.tools.setExecutor()')
    expect(message).toContain('is not a function')
  })

  it('the classic ctx.root.tools.register bypass registers nothing and fails loud', async () => {
    const harness = await setup()
    const message = await runTouching(harness, `
      ctx.root.tools.register({
        name: 'smuggled',
        description: 'raw, unguarded',
        parameters: { type: 'object', properties: {} },
        ${CONTENT_OUTPUT_CODE}
        async execute() { return [] },
      })
    `)
    expect(message).toContain('sandbox ctx does not expose "root"')
    // The whole point: the bypass never reaches the registry.
    expect(harness.ctx.tools.get('smuggled')).toBeUndefined()
  })

  it('rejects assignment to the façade rather than silently dropping it', async () => {
    const harness = await setup()
    await expect(mount(harness, 'return { name: \'writer\', apply(ctx) { ctx.stash = 1 } }'))
      .rejects.toThrow('sandbox ctx is read-only')
  })

  it('denies a service whose method returns a Context (the .ctx escape), registering nothing', async () => {
    // A cordis Service instance carries `.ctx` (a real Context), so
    // `ctx.systemPrompt.ctx.root.tools.register(…)` would escape the façade; service-return
    // guards reject that Context before the registration lands.
    const harness = await setup()
    const message = await (async (): Promise<string> => {
      try {
        await mount(harness, `
          return {
            name: 'svc-ctx-escape',
            inject: ['systemPrompt', 'tools'],
            apply(ctx) {
              ctx.systemPrompt.ctx.root.tools.register({
                name: 'smuggled_via_service',
                description: 'raw, unguarded',
                parameters: { type: 'object', properties: {} },
                ${CONTENT_OUTPUT_CODE}
                async execute() { return [] },
              })
            },
          }
        `)
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
      throw new Error('expected the host half to fail')
    })()
    expect(message).toContain('returned a cordis Context, which the sandbox does not expose')
    expect(harness.ctx.tools.get('smuggled_via_service')).toBeUndefined()
  })

  it('guards an async injected-service method: a host-realm Promise resolves through the guard', async () => {
    // The return guard's Promise arm only fires for a HOST-realm Promise (a vm-realm one is not
    // `instanceof` the host `Promise`).
    const harness = await setup()
    harness.ctx.plugin({
      name: 'host-async-svc',
      apply(c) { c.provide('hostAsync', { grab: async () => 'host-fetched' }) },
    })
    await mount(harness, `
      return {
        name: 'async-consumer',
        inject: ['hostAsync', 'tools'],
        apply(ctx) {
          harness.registerTool(ctx, harness.defineTool({
            name: 'do_fetch',
            description: 'awaits the host async service',
            parameters: {},
            ${CONTENT_OUTPUT_CODE}
            async execute() {
              const value = await ctx.hostAsync.grab()
              return [{ type: 'text', text: value }]
            },
          }))
        },
      }
    `)
    const result = await call(harness.ctx, 'do_fetch', {})
    expect(result.isError).toBe(false)
    expect(text(result)).toBe('host-fetched')
  })

  it('reads a symbol property as undefined and answers the `in` operator without throwing', async () => {
    const harness = await setup()
    await expect(mount(harness, `
      return {
        name: 'introspector',
        inject: ['tools'],
        apply(ctx) {
          const sym = ctx[Symbol.iterator]
          console.log('probe', sym === undefined, 'tools' in ctx, 'on' in ctx, 'root' in ctx)
        },
      }
    `)).resolves.toBeTruthy()
  })
})

describe('sandbox context façade — inject gate on services', () => {
  it('denies an undeclared live service (property access), naming the inject fix', async () => {
    // `systemPrompt` is a live global service in the setup harness, but this
    // host half does not declare it — reaching it would let the package depend
    // on a provider cordis does not know about, so it is refused.
    const harness = await setup()
    const message = await runTouching(harness, 'const s = ctx.systemPrompt')
    expect(message).toContain('service "systemPrompt" is not injected')
    expect(message).toContain('inject: [\'systemPrompt\', …]')
  })

  it('allows optional undeclared services through ctx.get', async () => {
    const harness = await setup()
    await expect(mount(harness, `
      return {
        name: 'optional-reader',
        apply(ctx) {
          const service = ctx.get('systemPrompt')
          if (service !== undefined) console.log('optional service is available')
        },
      }
    `)).resolves.toBeTruthy()
  })

  it('allows a service the host half DID declare in inject', async () => {
    const harness = await setup()
    await expect(mount(harness, `
      return {
        name: 'declared',
        inject: ['systemPrompt', 'tools'],
        apply(ctx) { console.log('has systemPrompt:', typeof ctx.systemPrompt) }
      }
    `)).resolves.toBeTruthy()
  })

  it('a cross-package consumer must declare the provider — the undeclared path is refused, not left as a zombie tool', async () => {
    // Without declared inject, Cordis cannot park the consumer when its provider stops. The
    // façade refuses access up front instead of leaving a zombie tool.
    const harness = await setup()
    await mount(harness, 'return { name: \'greeter-provider\', apply(ctx) { ctx.provide(\'greeter\', { greet: (n) => \'hi \' + n }) } }')
    await mount(harness, `
      return {
        name: 'sloppy-consumer',
        inject: ['tools'],
        apply(ctx) {
          harness.registerTool(ctx, harness.defineTool({
            name: 'greet_undeclared',
            description: 'uses greeter without declaring it',
            parameters: { n: { type: 'string', required: true } },
            ${CONTENT_OUTPUT_CODE}
            async execute(args) { return [{ type: 'text', text: ctx.greeter.greet(args.n) }] },
          }))
        },
      }
    `)
    // The tool registers (its execute is lazy), but calling it hits the gate:
    // `ctx.greeter` is undeclared, so it fails with the teaching error rather
    // than silently working and later stranding.
    const called = await call(harness.ctx, 'greet_undeclared', { n: 'x' })
    expect(called.isError).toBe(true)
    expect(text(called)).toContain('service "greeter" is not injected')
  })
})

describe('sandbox tools façade — get is a read-only schema view', () => {
  it('ctx.tools.get returns a schema, not the live ToolDefinition with execute', async () => {
    // The finding: returning the raw ToolDefinition hands package code the tool's execute
    // function, letting it bypass ToolsService.execute (and its pre/post hooks). get now
    // returns the same name/description/parameters view as schemas(), with no execute.
    const harness = await setup()
    harness.ctx.tools.register(dummyTool('host_tool'))
    await mount(harness, `
      return {
        name: 'reporter',
        inject: ['tools'],
        apply(ctx) {
          harness.registerTool(ctx, harness.defineTool({
            name: 'report_view',
            description: 'reports the shape of a tool view',
            parameters: {},
            ${CONTENT_OUTPUT_CODE}
            async execute() {
              const view = ctx.tools.get('host_tool')
              return [{ type: 'text', text: JSON.stringify({
                hasExecute: 'execute' in view,
                hasPresentCall: 'presentCall' in view,
                name: view.name,
                keys: Object.keys(view).sort(),
              }) }]
            },
          }))
        },
      }
    `)
    const reported = await call(harness.ctx, 'report_view', {})
    expect(reported.isError).toBe(false)
    const shape = JSON.parse(text(reported)) as { hasExecute: boolean; hasPresentCall: boolean; name: string; keys: string[] }
    expect(shape.hasExecute).toBe(false)
    expect(shape.hasPresentCall).toBe(false)
    expect(shape.name).toBe('host_tool')
    expect(shape.keys).toEqual(['description', 'name', 'parameters'])
  })

  it('ctx.tools.get returns undefined for an unknown tool', async () => {
    const harness = await setup()
    await mount(harness, `
      return {
        name: 'unknown-probe',
        inject: ['tools'],
        apply(ctx) {
          harness.registerTool(ctx, harness.defineTool({
            name: 'probe_unknown',
            description: 'reports whether an unknown tool resolves',
            parameters: {},
            ${CONTENT_OUTPUT_CODE}
            async execute() {
              return [{ type: 'text', text: String(ctx.tools.get('no_such_tool') === undefined) }]
            },
          }))
        },
      }
    `)
    expect(text(await call(harness.ctx, 'probe_unknown', {}))).toBe('true')
  })
})
