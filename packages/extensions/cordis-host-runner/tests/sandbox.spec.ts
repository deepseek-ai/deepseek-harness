import { describe, expect, it, vi } from 'vitest'
import { HarnessError } from '@deepseek-ai/dsh-error'
import { sandboxDefineTool } from '../src/guard.ts'
import { syntaxErrorContext } from '../src/sandbox.ts'
import { AGENT_A, call, CONTENT_OUTPUT_CODE, mount, setup, text, running } from './helpers.ts'

/**
 * The vm sandbox contract a host half runs under: isolated globals, Node-API
 * traps that redirect to cordis services, the encoding primitives a bare vm
 * context lacks, the dual-realm `instanceof` patch, the synchronous evaluation
 * bound, and the teaching text a parse or runtime failure carries. Failures
 * leave nothing running.
 */

describe('dynamic tool declaration boundary', () => {
  it.each([
    [42, 'options must be an object'],
    [{ parameters: {} }, 'output must declare { schema, render, presentationMeta? }'],
    [{ parameters: {}, output: { schema: { type: 'json' } }, execute: async (): Promise<null> => null }, 'output.render must be a function'],
    [{ parameters: {}, output: { schema: { type: 'json' }, render: () => [] }, execute: true }, 'execute must be a function'],
    [{
      parameters: {},
      output: { schema: { type: 'json' }, render: () => [], presentationMeta: true },
      execute: async (): Promise<null> => null,
    }, 'output.presentationMeta must be a function'],
  ])('rejects an invalid dynamic tool declaration before registration: %j', (definition, message) => {
    expect(() => sandboxDefineTool(definition)).toThrow(message)
  })

  it('bounds the preview of an invalid dynamic renderer return', () => {
    const definition = sandboxDefineTool({
      name: 'invalid-renderer',
      description: 'invalid renderer',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: () => ['x'.repeat(500)],
      },
      execute: async () => 'ok',
    })
    expect(() => definition.output.render({}, 'ok')).toThrow(/output\.render returned \["x+…/)
  })
})

describe('dynamic tool execution failures', () => {
  const tool = (execute: () => Promise<unknown>) => sandboxDefineTool({
    name: 'failing', description: 'failing tool', parameters: {},
    output: { schema: { type: 'json' }, render: () => [] },
    execute,
  })
  const run = (execute: () => Promise<unknown>, signal = new AbortController().signal) =>
    tool(execute).execute({}, { signal } as never)

  it('classifies thrown values and non-JSON results as PluginToolError', async () => {
    const thrown = Object.assign(new Error('quota exhausted'), { code: 'QUOTA' })
    await expect(run(() => Promise.reject(thrown))).rejects.toMatchObject({
      name: 'PluginToolError', code: 'PLUGIN_TOOL_FAILED', message: 'quota exhausted (code QUOTA)', cause: thrown,
    })
    // Sandbox code may reject with any value, not only an Error.
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors
    await expect(run(() => Promise.reject('bare failure'))).rejects.toMatchObject({
      name: 'PluginToolError', code: 'PLUGIN_TOOL_FAILED', message: 'bare failure',
    })
    const trapped = new Proxy({}, { get: (_target, key) => { if (key === 'code') throw new Error('trap'); return undefined } })
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors
    await expect(run(() => Promise.reject(trapped))).rejects.toMatchObject({ name: 'PluginToolError', code: 'PLUGIN_TOOL_FAILED' })
    await expect(run(() => Promise.resolve(new Map()))).rejects.toMatchObject({
      name: 'PluginToolError', code: 'PLUGIN_TOOL_INVALID_RESULT',
    })
  })

  it('keeps a HarnessError and a failure after cancellation unchanged', async () => {
    const coded = new HarnessError('service failed', 'SERVICE_FAILED')
    await expect(run(() => Promise.reject(coded))).rejects.toBe(coded)
    const controller = new AbortController()
    const reason = new Error('cancelled')
    controller.abort(reason)
    await expect(run(() => Promise.reject(reason), controller.signal)).rejects.toBe(reason)
    await expect(run(() => Promise.reject(new Error('cleanup failed')), controller.signal)).rejects.toMatchObject({
      name: 'PluginToolError', code: 'PLUGIN_TOOL_FAILED', message: 'cleanup failed',
    })
  })

  it('classifies hostile thrown values and results that throw during the clone', async () => {
    const revocable = Proxy.revocable({}, {})
    revocable.revoke()
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors
    await expect(run(() => Promise.reject(revocable.proxy))).rejects.toMatchObject({ name: 'PluginToolError', code: 'PLUGIN_TOOL_FAILED' })
    for (const thrown of ['getter failed', null]) {
      const value = { get broken(): never { throw thrown } }
      await expect(run(() => Promise.resolve(value))).rejects.toMatchObject({
        name: 'PluginToolError', code: 'PLUGIN_TOOL_INVALID_RESULT', message: String(thrown),
      })
    }
  })
})

describe('sandbox isolation and Node-API traps', () => {
  it('isolates sandbox globals: no process/Buffer, and globalThis writes do not leak to the host', async () => {
    const harness = await setup()
    await mount(harness, `
      globalThis.__cordis_runner_leak = 'leaked'
      return { name: 'probe-' + typeof process + '-' + typeof Buffer, apply(ctx) {} }
    `)
    expect((globalThis as Record<string, unknown>).__cordis_runner_leak).toBeUndefined()
  })

  it.each([
    ['require(\'fs\')', 'require is not available in the dynamic package sandbox', 'inject: [\'fs\']'],
    ['setTimeout(() => {}, 5)', 'setTimeout is not available in the dynamic package sandbox', 'ctx.timeout / ctx.interval'],
    ['fetch(\'https://example.com\')', 'fetch is not available in the dynamic package sandbox', 'ctx.web'],
  ])('traps the Node API call %s with a redirect to the cordis alternative', async (invocation, trapMessage, redirect) => {
    const harness = await setup()
    const failure = await mount(harness, `${invocation}\nreturn (ctx) => {}`).catch((error: unknown) =>
      error instanceof Error ? error.message : String(error))
    expect(failure).toContain(trapMessage)
    expect(failure).toContain(redirect)
    expect(running(harness.runner, AGENT_A)).toEqual([{ id: 'probe-1', running: false }])
  })

  it('lets a host half schedule through the cordis timer service (inject: [\'timer\'])', async () => {
    const harness = await setup()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const id = await mount(harness, `
      return {
        name: 'ticker',
        inject: ['timer'],
        apply(ctx) {
          ctx.setTimeout(() => console.log('tick'), 10)
        },
      }
    `)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(log).toHaveBeenCalledWith(`[cordis:${id}]`, 'tick')
    vi.restoreAllMocks()
  })

  it('provides btoa/atob and the tagged console variants inside the sandbox', async () => {
    const harness = await setup()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const id = await mount(harness, `
      console.warn('warned')
      console.error('errored')
      const round = atob(btoa('hi'))
      const bytes = new TextEncoder().encode(round)
      return { name: 'codec-' + new TextDecoder().decode(bytes), apply(ctx) { console.log('applied', typeof ctx.on) } }
    `)
    expect(log).toHaveBeenCalledWith(`[cordis:${id}]`, 'warned')
    expect(log).toHaveBeenCalledWith(`[cordis:${id}]`, 'applied', 'function')
    expect(error).toHaveBeenCalledWith(`[cordis:${id}]`, 'errored')
    vi.restoreAllMocks()
  })

  it('makes instanceof inside the sandbox see BOTH realms (patched vm constructors, host untouched)', async () => {
    // The args a tool's execute receives are HOST-realm objects; without the dual-realm
    // Symbol.hasInstance prelude, `args.items instanceof Array` in sandbox code is silently
    // false.
    const harness = await setup()
    await mount(harness, `
      return {
        name: 'probe-instanceof',
        inject: ['tools'],
        apply(ctx) {
          harness.registerTool(ctx, harness.defineTool({
            name: 'probe_instanceof',
            description: 'report instanceof checks across realms',
            parameters: { items: { type: 'array', required: true, items: { type: 'string' } } },
            ${CONTENT_OUTPUT_CODE}
            async execute(args) {
              const checks = {
                hostArray: args.items instanceof Array,
                hostObject: args instanceof Object,
                vmArray: [] instanceof Array,
                vmObject: ({}) instanceof Object,
              }
              return [{ type: 'text', text: JSON.stringify(checks) }]
            },
          }))
        },
      }
    `)
    const probed = await call(harness.ctx, 'probe_instanceof', { items: ['a'] })
    expect(probed.isError).toBe(false)
    expect(JSON.parse(text(probed))).toEqual({ hostArray: true, hostObject: true, vmArray: true, vmObject: true })
    // The host realm's constructors keep their default instanceof: no own
    // Symbol.hasInstance was added to them.
    expect(Object.getOwnPropertySymbols(Object)).not.toContain(Symbol.hasInstance)
    expect(Object.getOwnPropertySymbols(Array)).not.toContain(Symbol.hasInstance)
  })

  it('honors the configured vmTimeoutMs for the synchronous portion', async () => {
    const harness = await setup({ vmTimeoutMs: 50 })
    await expect(mount(harness, 'while (true) {}')).rejects.toThrow(/timed? ?out/i)
    expect(running(harness.runner, AGENT_A)).toEqual([{ id: 'probe-1', running: false }])
  })
})

describe('host-half failures leave nothing running', () => {
  it.each([
    ['throw new Error(\'boom in sandbox\')', 'boom in sandbox'],
    ['throw \'plain-string-throw\'', 'plain-string-throw'],
    ['return 42', 'must return a Plugin'],
    ['const plugin = (ctx) => {}', 'did you forget `return`?'],
    ['return { name: \'broken\', apply(ctx) { throw new Error(\'apply exploded\') } }', 'apply exploded'],
  ])('refuses %j with a teaching message', async (code, message) => {
    const harness = await setup()
    await expect(mount(harness, code)).rejects.toThrow(message)
    expect(running(harness.runner, AGENT_A)).toEqual([{ id: 'probe-1', running: false }])
  })

  it('passes a null throw through untouched (no SyntaxError misclassification)', async () => {
    const harness = await setup()
    await expect(mount(harness, 'throw null')).rejects.toThrow()
  })
})

describe('parse failures teach the fix', () => {
  it('answers TypeScript syntax in the plain-JS sandbox with the fix, at define time', async () => {
    const harness = await setup()
    // The precheck runs inside define, so unparseable code never reaches the registry.
    expect(() => harness.runner.define({
      sessionId: AGENT_A.id,
      plugin: { kind: 'new', idPrefix: 'probe' },
      name: 'ts',
      purpose: 'p',
      code: { host: 'return { name: \'ts\' as const, apply(ctx) {} }' },
    })).toThrow('plain JavaScript, not TypeScript')
    expect(running(harness.runner, AGENT_A)).toEqual([])
  })

  it('surfaces the offending line + caret and the bracket-balance hint on a syntax error', async () => {
    const harness = await setup()
    // The canonical model mistake: closing the returned object with `});` as
    // if it were a callback argument. The word "as" in a STRING elsewhere must
    // not trigger the TypeScript hint — the heuristic reads the failing line.
    let message = ''
    try {
      harness.runner.define({
        sessionId: AGENT_A.id,
        plugin: { kind: 'new', idPrefix: 'probe' },
        name: 'oops',
        purpose: 'p',
        code: { host: 'const note = \'treat pattern as regex\'\nreturn {\n  name: \'oops\',\n  apply(ctx) {}\n});' },
      })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('failed to parse')
    expect(message).toContain('});')
    expect(message).toContain('^')
    expect(message).toContain('BODY of an async function')
    expect(message).not.toContain('TypeScript')
  })

  it('syntaxErrorContext falls back to String(error) when the stack has no vm prelude', () => {
    const doctored = new SyntaxError('boom')
    delete (doctored as { stack?: string }).stack
    expect(syntaxErrorContext(doctored)).toBe('SyntaxError: boom')
    const plain = new SyntaxError('bang')
    plain.stack = 'not-a-vm-stack'
    expect(syntaxErrorContext(plain)).toBe('SyntaxError: bang')
  })

  it('handles a runtime-thrown SyntaxError (no source-line prelude) with the generic hint', async () => {
    const harness = await setup()
    // Thrown at RUN time (the define precheck compiles fine), so the evaluator's
    // own SyntaxError branch classifies it.
    await expect(mount(harness, 'throw new SyntaxError(\'user-crafted\')'))
      .rejects.toThrow('user-crafted')
  })
})
