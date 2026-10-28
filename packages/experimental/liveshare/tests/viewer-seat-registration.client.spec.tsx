// @vitest-environment jsdom
/**
 * The viewer's read-only composer seats replace the shipped seats instead of colliding with them.
 *
 * A single slot renders its lowest-ranked live entry and throws when a second registration repeats an
 * occupied rank. A served viewer page mounts the owner's own plugins, so the shipped permission and
 * model controls are already registered at the default rank; the viewer seats must register below
 * that rank to become the rendered entry. Mounting them at the shipped rank is the failure this
 * suite pins: the registration conflict leaves the viewer entry unregistered, so the shipped control
 * keeps rendering.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { Context } from '@deepseek-ai/cordis'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import { act, cleanup, waitFor } from '@testing-library/react'
import { en, NS, zh } from '../src/client/locales.ts'
import * as viewerModel from '../src/client/viewer-model.tsx'
import * as viewerPermission from '../src/client/viewer-permission.tsx'
import { VIEWER_SEAT_PRIORITY } from '../src/client/viewer-seat.tsx'

afterEach(cleanup)

/** The advisory catalog one Host serves for the Session the seat states. */
const CATALOG = {
  default: { provider: 'internal', model: 'dsv41f' },
  groups: [{
    id: 'internal',
    models: [{
      id: 'dsv41f',
      name: '内网 DSV41F',
      reasoning: {
        efforts: [{ id: 'low', name: '低强度' }, { id: 'high', name: '高强度' }],
        defaultEffort: 'low',
      },
    }],
  }],
}

/** The Session's durable selection fold: the model the next request would use. */
const SELECTION = {
  lastUsed: null,
  next: { provider: 'internal', model: 'dsv41f', reasoningEffort: 'high' },
}

/**
 * A runtime whose declared composer slots the shipped plugins can fill at their default rank, ready
 * for the viewer plugins to mount over them.
 * @param options - Whether the Host answers its model catalog.
 * @returns The runtime, the Session reference the rendered seats receive, and the shipped-seat mount.
 */
async function bench(options: { readonly catalogReadable?: boolean } = {}) {
  const runtime = await SlotTestRuntime.create()
  onTestFinished(() => runtime.dispose())
  let catalogReads = 0
  const locale = new LocaleRuntime(runtime.ctx)
  locale.register(NS, { en, zh })
  locale.setLocale('zh')
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  runtime.remote.provideNamespaces({
    session: {
      modelCatalog: () => {
        catalogReads += 1
        return Promise.resolve(options.catalogReadable === false
          ? { ok: false, value: {} }
          : { ok: true, value: CATALOG })
      },
    },
  })
  const sessionId = await runtime.sessions.add({ id: 'viewer-seat' })
  await runtime.sessions.setProjection(sessionId, 'modelSelection', SELECTION)
  const session = runtime.sessions.retainFor(runtime.ctx, sessionId)
  await runtime.declare({
    'conversation.input.permission': { kind: 'single', scope: 'session' },
    'conversation.input.model': { kind: 'single', scope: 'session' },
  })
  // The shipped seats register one entry per slot at the default rank, exactly as their plugins do.
  const mountShipped = async (): Promise<void> => {
    await runtime.mount({
      inject: ['slots'],
      apply(ctx: ClientContext) {
        ctx.slots.register({ name: 'conversation.input.permission' }, () => <span data-shipped="permission">shipped permission</span>)
        ctx.slots.register({ name: 'conversation.input.model' }, () => <span data-shipped="model">shipped model</span>)
      },
    })
  }
  return { runtime, session, mountShipped, catalogReads: () => catalogReads }
}

/**
 * Record every registration crash the slot ledger reports.
 * @param runtime - the bench runtime.
 * @returns the live record and its unsubscribe.
 */
function watchEntryErrors(runtime: SlotTestRuntime) {
  const entryErrors: { key: string; message: string }[] = []
  const stop = runtime.slots.onEntryError((key, _registration, error) => {
    entryErrors.push({ key, message: error instanceof Error ? error.message : String(error) })
  })
  return { entryErrors, stop }
}

/**
 * Render both composer seats the viewer states.
 * @param runtime - the bench runtime.
 * @param session - the Session reference the rendered seats receive.
 * @returns Both rendered slot views.
 */
function renderSeats(runtime: SlotTestRuntime, session: SessionReference) {
  const permission = runtime.renderSlot('conversation.input.permission', { locked: false }, { session })
  const model = runtime.renderSlot('conversation.input.model', { locked: false }, { session })
  return { permission, model }
}

/** Both seats' ranks as the ledger holds them, defaulted the way the registry ranks a missing option. */
function seatRanks(runtime: SlotTestRuntime, name: 'conversation.input.permission' | 'conversation.input.model'): number[] {
  return runtime.slots.entries(name).map(entry => entry.options.priority ?? 0)
}

describe('viewer seat registration', () => {
  it('mounts both viewer seats over the shipped seats and renders the viewer entries', async () => {
    const { runtime, session, mountShipped } = await bench()
    const { entryErrors, stop } = watchEntryErrors(runtime)
    // Mounting must not report a single-slot conflict: the viewer entry is a lower rank, not a second occupant.
    await mountShipped()
    const permissionHandle = await runtime.mount(viewerPermission)
    const modelHandle = await runtime.mount(viewerModel)
    expect(entryErrors).toEqual([])

    const { permission, model } = renderSeats(runtime, session)
    expect(permission.container.querySelector('[data-liveshare-viewer-seat="permission"]')).not.toBeNull()
    expect(permission.container.querySelector('[data-shipped="permission"]')).toBeNull()
    expect(permission.container.textContent).toContain(zh['viewer.permission.locked'])
    expect(model.container.querySelector('[data-liveshare-viewer-seat="model"]')).not.toBeNull()
    expect(model.container.querySelector('[data-shipped="model"]')).toBeNull()
    // The viewer's own copy states the restriction; the shipped control has none.
    expect(model.container.textContent).toContain(zh['viewer.model.locked'])

    // Both entries stay on the ledger: the viewer entry is the lower one, the shipped entry is shadowed.
    expect(seatRanks(runtime, 'conversation.input.permission')).toEqual([VIEWER_SEAT_PRIORITY, 0])
    expect(seatRanks(runtime, 'conversation.input.model')).toEqual([VIEWER_SEAT_PRIORITY, 0])

    // A viewer unload restores the shipped control: the shadow was a registration, not a removal.
    await permissionHandle.dispose()
    await modelHandle.dispose()
    expect(await permission.view.findByText('shipped permission')).toBeTruthy()
    expect(await model.view.findByText('shipped model')).toBeTruthy()
    stop()
  })

  it('keeps the viewer entries when the viewer page mounts them before the shipped seats', async () => {
    const { runtime, session, mountShipped } = await bench()
    const { entryErrors, stop } = watchEntryErrors(runtime)
    // The served page loads the owner's plugins in its own order; the shadow rank must hold either way.
    await runtime.mount(viewerPermission)
    await runtime.mount(viewerModel)
    await mountShipped()
    expect(entryErrors).toEqual([])
    expect(seatRanks(runtime, 'conversation.input.permission')).toEqual([VIEWER_SEAT_PRIORITY, 0])
    expect(seatRanks(runtime, 'conversation.input.model')).toEqual([VIEWER_SEAT_PRIORITY, 0])

    const { permission, model } = renderSeats(runtime, session)
    expect(permission.container.querySelector('[data-liveshare-viewer-seat="permission"]')).not.toBeNull()
    expect(model.container.querySelector('[data-liveshare-viewer-seat="model"]')).not.toBeNull()
    stop()
  })

  it('states the Session’s own route when the Host cannot answer its model catalog', async () => {
    const { runtime, session, catalogReads } = await bench({ catalogReadable: false })
    await runtime.mount(viewerModel)

    const { model } = renderSeats(runtime, session)
    // The seat reads the catalog once it is mounted; the answer is unreadable, so its display names
    // never arrive.
    await act(async () => {})
    expect((await model.view.findByText(/dsv41f/)).textContent).toBe('dsv41f · high')
    // The catalog's display names are an adornment: a Host that cannot answer leaves the route and
    // the Session's own effort stated rather than an empty seat.
    await waitFor(() => { expect(catalogReads()).toBe(1) })
    expect(model.container.textContent).toContain('dsv41f · high')
  })
})

describe('single-slot shadow rank', () => {
  it('pins the shipped-rank failure the viewer seats must not repeat', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(SlotRegistry)
    await fiber.await()
    const slots = ctx.get('slots') as SlotRegistry
    slots.register({
      name: 'root',
      children: { 'conversation.input.permission': { kind: 'single', scope: 'session' } },
    } as never, () => null)
    slots.register({ name: 'conversation.input.permission' } as never, () => null)
    let conflict: Error | undefined
    try {
      slots.register({ name: 'conversation.input.permission' } as never, () => null)
    } catch (error: unknown) {
      conflict = error as Error
    }
    expect(conflict?.message).toContain('single slot "conversation.input.permission" already has a registration at priority 0')
    expect(conflict?.message).toContain('register at a different priority to shadow it (lowest renders)')
    await fiber.dispose()
  })

  it('states the rank every shipped seat is replaced from', () => {
    // The shipped seats register at the default rank; the shadow rank must stay below it.
    expect(VIEWER_SEAT_PRIORITY).toBeLessThan(0)
  })
})
