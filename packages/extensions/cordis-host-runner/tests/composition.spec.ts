import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CordisDynamicPackageId, CordisDynamicPluginId } from '../src/types.ts'
import { missingServices } from '../src/lifecycle.ts'
import {
  AGENT_A, call, CONSUMER_CODE, CONTENT_OUTPUT_CODE, dummyTool, LISTENER_CODE, mount,
  PROVIDER_CODE, REVERSE_TOOL_CODE, setup, text,
  running,
} from './helpers.ts'

/**
 * Cross-package composition through ordinary cordis provide/inject semantics:
 * one package's host half provides a service, another injects it, and definition
 * ids stay the lifecycle handles across stop and run again. Every assertion is
 * against the WORLD — the registry, the service store, real tool dispatch — not
 * a rendered summary (that is the tool package's job).
 */

afterEach(() => {
  vi.restoreAllMocks()
})

function latestPackage(harness: Awaited<ReturnType<typeof setup>>, pluginId: CordisDynamicPluginId): CordisDynamicPackageId {
  const row = harness.runner.inventory().find(candidate => candidate.pluginId === pluginId)
  const packageId = row?.packages.at(-1)?.packageId
  if (packageId === undefined) throw new Error(`missing package for ${pluginId}`)
  return packageId
}

describe('cross-package provide/inject', () => {
  it('provider first: the consumer activates immediately and its tool reaches the provided service', async () => {
    const harness = await setup()
    await mount(harness, PROVIDER_CODE)
    await mount(harness, CONSUMER_CODE)

    // The vm-realm service value is callable across packages, and the result
    // normalizes into the host realm like any dynamic tool result.
    const greeted = await call(harness.ctx, 'greet', { name: 'harness' })
    expect(greeted.isError).toBe(false)
    expect(text(greeted)).toBe('hi harness')
  })

  it('consumer first: runs but stays parked on the missing service, then activates when the provider runs', async () => {
    const harness = await setup()
    const consumer = await mount(harness, CONSUMER_CODE)

    // A settled-but-pending host half is a successful run in legal cordis
    // semantics; the fiber names what it waits for.
    const [row] = harness.runner.snapshot(AGENT_A)
    expect(row?.activeRun?.fiber).toBeDefined()
    expect(missingServices(harness.ctx, row?.activeRun?.fiber as never)).toEqual(['greeter'])
    expect(harness.ctx.tools.get('greet')).toBeUndefined()
    expect(running(harness.runner, AGENT_A)).toEqual([{ id: consumer, running: true }])

    await mount(harness, PROVIDER_CODE)
    expect(harness.ctx.tools.get('greet')).toBeDefined()
    expect(text(await call(harness.ctx, 'greet', { name: 'late' }))).toBe('hi late')
  })

  it('stopping the provider sends the consumer back to pending and unwinds its registrations', async () => {
    const harness = await setup()
    const provider = await mount(harness, PROVIDER_CODE)
    await mount(harness, CONSUMER_CODE)
    expect(harness.ctx.tools.get('greet')).toBeDefined()

    await expect(harness.runner.stop(AGENT_A, provider)).resolves.toEqual({ ok: true })

    expect(harness.ctx.tools.get('greet')).toBeUndefined()
    expect(harness.ctx.get('greeter')).toBeUndefined()
  })

  it('running the provider again re-runs the consumer through a fresh guard (tool back)', async () => {
    const harness = await setup()
    const provider = await mount(harness, PROVIDER_CODE)
    await mount(harness, CONSUMER_CODE)
    await harness.runner.stop(AGENT_A, provider)
    expect(harness.ctx.tools.get('greet')).toBeUndefined()

    // The same definition, a new dispatch: the consumer's apply re-runs through
    // a new façade rather than needing its own re-definition.
    await expect(harness.runner.run(
      AGENT_A, provider, latestPackage(harness, provider), 'run',
    )).resolves.toMatchObject({ ok: true })
    expect(harness.ctx.tools.get('greet')).toBeDefined()
    expect(text(await call(harness.ctx, 'greet', { name: 'again' }))).toBe('hi again')
  })

  it('a duplicate provide fails loud and leaves the second package not running', async () => {
    const harness = await setup()
    await mount(harness, PROVIDER_CODE)

    await expect(mount(harness, PROVIDER_CODE)).rejects.toThrow('has been registered')

    const rows = harness.runner.snapshot(AGENT_A)
    expect(rows.map(row => row.activeRun !== undefined)).toEqual([true, false])
    // The service still belongs to the first package's fiber.
    expect(harness.ctx.get('greeter')).toBeDefined()
  })

  it('a primitive (or null) provided value passes through the façade unwrapped, on both read paths', async () => {
    const harness = await setup()
    await mount(harness, `
      return {
        name: 'answer-provider',
        apply(ctx) {
          ctx.provide('answer', 42)
          ctx.provide('nothing', null)
        },
      }
    `)
    await mount(harness, `
      return {
        name: 'answer-consumer',
        inject: ['answer', 'nothing', 'tools'],
        apply(ctx) {
          harness.registerTool(ctx, harness.defineTool({
            name: 'answer',
            description: 'Read the provided primitive services.',
            parameters: {},
            ${CONTENT_OUTPUT_CODE}
            async execute() {
              return [{ type: 'text', text: ctx.answer + '/' + ctx.get('answer') + '/' + ctx.nothing }]
            },
          }))
        },
      }
    `)

    expect(text(await call(harness.ctx, 'answer', {}))).toBe('42/42/null')
  })

  it('stopping the consumer leaves the provider and its service intact', async () => {
    const harness = await setup()
    await mount(harness, PROVIDER_CODE)
    const consumer = await mount(harness, CONSUMER_CODE)

    await harness.runner.stop(AGENT_A, consumer)

    expect(harness.ctx.tools.get('greet')).toBeUndefined()
    expect(harness.ctx.get('greeter')).toBeDefined()
  })
})

describe('stop reaches quiescence', () => {
  it('the host half\'s listeners have stopped by the time stop returns', async () => {
    const harness = await setup()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const id = await mount(harness, LISTENER_CODE)

    harness.ctx.tools.register(dummyTool('trigger_before'))
    expect(log).toHaveBeenCalledTimes(1)

    await expect(harness.runner.stop(AGENT_A, id)).resolves.toEqual({ ok: true })

    // Immediately after the awaited stop, the listener must be gone — no grace
    // period, no eventual consistency.
    harness.ctx.tools.register(dummyTool('trigger_after'))
    expect(log).toHaveBeenCalledTimes(1)
  })

  it('unregisters a self-made tool on stop, and registers it again on the next run', async () => {
    const harness = await setup()
    const id = await mount(harness, REVERSE_TOOL_CODE)
    expect(harness.ctx.tools.get('reverse_text')).toBeDefined()

    await harness.runner.stop(AGENT_A, id)
    expect(harness.ctx.tools.get('reverse_text')).toBeUndefined()

    await harness.runner.run(AGENT_A, id, latestPackage(harness, id), 'run')
    expect(harness.ctx.tools.get('reverse_text')).toBeDefined()
  })

  it('names the replace recipe when a run collides with a live registration', async () => {
    const harness = await setup()
    await mount(harness, REVERSE_TOOL_CODE)

    // A second package registering the same tool name collides; the teaching
    // error points at the stop-then-run recipe rather than a bare conflict.
    await expect(mount(harness, REVERSE_TOOL_CODE)).rejects.toThrow('first stop that package through its runner or the Cordis panel')
  })
})
