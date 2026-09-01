// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { DirectoryFlowOwnerProps } from '@deepseek-ai/dsh-client-ui-workspace/client'
import { apply, inject } from '../src/client/index.ts'
import { NativeDirectoryFlow } from '../src/client/flow.ts'
import { apply as nodeApply } from '../src/index.ts'

afterEach(cleanup)

const HOLES = ['conversation.hero.workspace.directoryFlow', 'sidebar.workspaces.directoryFlow'] as const

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const pickDirectory = vi.fn(async (): Promise<string | null> => '/tmp/picked')
  ctx.provide('uiWorkspace', { pickDirectory } as never)
  const slots = ctx.get('slots') as SlotRegistry
  const declare = () => slots.register({
    name: 'root',
    children: Object.fromEntries(HOLES.map(name => [name, { kind: 'single', scope: 'root' }])),
  } as never, () => null)
  return { ctx, slots, pickDirectory, declare }
}

function owner(overrides: Partial<DirectoryFlowOwnerProps> = {}): DirectoryFlowOwnerProps {
  return {
    open: true, busy: false,
    onPicked: vi.fn(), onCancel: vi.fn(), onError: vi.fn(),
    ...overrides,
  }
}

describe('directory-picker-native client half', () => {
  it('declares the services it drives', () => {
    expect(inject).toEqual(['slots', 'uiWorkspace'])
  })

  it('fills both directory-flow holes for declarations before or after apply, and leaves with its fiber', async () => {
    const before = await bench()
    before.declare()
    const fiber = before.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    for (const hole of HOLES) expect(before.slots.entries(hole)).toHaveLength(1)
    // Registry-contribution disposal proof: the fiber going down empties the holes.
    await fiber.dispose()
    for (const hole of HOLES) expect(before.slots.entries(hole)).toHaveLength(0)

    const after = await bench()
    await after.ctx.plugin({ inject: [...inject], apply }).await()
    for (const hole of HOLES) expect(after.slots.entries(hole)).toHaveLength(0)
    after.declare()
    await Promise.resolve()
    for (const hole of HOLES) expect(after.slots.entries(hole)).toHaveLength(1)
  })

  it('fails loudly instead of deduplicating a duplicate package row', async () => {
    const b = await bench()
    b.declare()
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const duplicate = b.ctx.plugin({ inject: [...inject], apply })
    await expect(duplicate.await()).rejects.toThrow(/already has a registration/)
    for (const hole of HOLES) expect(b.slots.entries(hole)).toHaveLength(1)
  })

  it('rolls back wholesale and reports loudly when a rival injection wins declaration activation', async () => {
    const b = await bench()
    const rejections: unknown[] = []
    const onUnhandled = (reason: unknown): void => { rejections.push(reason) }
    // queueMicrotask throws surface as uncaughtException, not a rejection.
    process.on('unhandledRejection', onUnhandled)
    process.on('uncaughtException', onUnhandled)
    try {
      // The rival subscribes first, so synchronous declaration notifications
      // let it occupy the pair before this provider's waiting injection runs.
      b.slots.inject(HOLES[0], () => b.slots.inject(HOLES[1], function* () {
        yield b.slots.register({ name: HOLES[0] } as never, () => null)
        yield b.slots.register({ name: HOLES[1] } as never, () => null)
      }))
      await b.ctx.plugin({ inject: [...inject], apply }).await()
      b.declare()
      await new Promise(resolve => setTimeout(resolve, 20))
      // The rival keeps both holes; this provider rolled back wholesale and
      // surfaced the conflict on the fail-loud channel — no partial mix.
      for (const hole of HOLES) expect(b.slots.entries(hole)).toHaveLength(1)
      expect(rejections.map(String).join('\n')).toContain('already has a registration')

      // Non-Error conflicts wrap before the loud rethrow (same channel).
      const c = await bench()
      await c.ctx.plugin({ inject: [...inject], apply }).await()
      const original = c.slots.register.bind(c.slots)
      const slotsAny = c.slots as { register: typeof original }
      slotsAny.register = ((options: never, component: never) => {
        if ((options as { name?: string }).name === HOLES[0]) throw 'string conflict'
        return original(options, component)
      }) as typeof original
      c.declare()
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(rejections.map(String).join('\n')).toContain('string conflict')
    } finally {
      process.off('unhandledRejection', onUnhandled)
      process.off('uncaughtException', onUnhandled)
    }
  })

  it('rolls back the outer injection when the second hole is already occupied', async () => {
    const b = await bench()
    b.declare()
    // Foreign occupant in the SECOND registered hole: the pair construction
    // throws after the outer injection installed its subscription.
    b.slots.register({ name: HOLES[1] } as never, () => null)
    const rejections: unknown[] = []
    const onUnhandled = (reason: unknown): void => { rejections.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      const fiber = b.ctx.plugin({ inject: [...inject], apply })
      await expect(fiber.await()).rejects.toThrow(/already has a registration/)
      // A leaked first deferral would now race this probe registration and
      // throw from its orphaned subscription against the HERO hole; the
      // rollback leaves only the activation failure itself (cordis re-raises
      // the apply throw as a late rejection — installFailLoud's contract).
      const disposeProbe = b.slots.register({ name: HOLES[0] } as never, () => null)
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(rejections.map(String).filter(text => text.includes(HOLES[0]))).toEqual([])
      disposeProbe()
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('rejects a second flow occupant at load (single-kind hole)', async () => {
    const b = await bench()
    b.declare()
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    expect(() => b.slots.register({ name: HOLES[0] } as never, () => null))
      .toThrow(/already has a registration/)
  })

  it('drives the injected pick through the hole entry and reports the picked path', async () => {
    const b = await bench()
    b.declare()
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const entry = b.slots.entries(HOLES[0])[0]!
    const injected = (entry.inject as () => { pick: () => Promise<string | null> })()
    await expect(injected.pick()).resolves.toBe('/tmp/picked')
    expect(b.pickDirectory).toHaveBeenCalledOnce()
  })

  it('runs one pick per open edge and reports the path to the latest onPicked', async () => {
    let resolve!: (path: string | null) => void
    const pick = vi.fn(() => new Promise<string | null>((settle) => { resolve = settle }))
    const first = owner()
    const view = render(<NativeDirectoryFlow {...first} pick={pick} />)
    expect(pick).toHaveBeenCalledOnce()
    // Re-renders while open (busy flips, handler identity changes) must not relaunch the chooser.
    const second = owner()
    view.rerender(<NativeDirectoryFlow {...second} busy pick={pick} />)
    expect(pick).toHaveBeenCalledOnce()
    // Even a fresh injected face (re-registration re-runs the inject factory)
    // must not relaunch while the same request is still open.
    const replacedPick = vi.fn(() => new Promise<string | null>(() => {}))
    view.rerender(<NativeDirectoryFlow {...second} busy pick={replacedPick} />)
    expect(replacedPick).not.toHaveBeenCalled()
    await act(async () => { resolve('/tmp/project') })
    expect(second.onPicked).toHaveBeenCalledWith('/tmp/project')
    expect(first.onPicked).not.toHaveBeenCalled()
  })

  it('discards a settlement that lands after the flow unmounted', async () => {
    let resolve!: (path: string | null) => void
    const pick = vi.fn(() => new Promise<string | null>((settle) => { resolve = settle }))
    const props = owner()
    const view = render(<NativeDirectoryFlow {...props} pick={pick} />)
    expect(pick).toHaveBeenCalledOnce()
    view.unmount()
    // The dead instance must neither adopt nor error; the owner's callbacks
    // stay untouched by the orphaned chooser's answer.
    await act(async () => { resolve('/tmp/late') })
    expect(props.onPicked).not.toHaveBeenCalled()
    expect(props.onCancel).not.toHaveBeenCalled()
    expect(props.onError).not.toHaveBeenCalled()

    // The failure arm is discarded the same way.
    let reject!: (reason: unknown) => void
    const failing = vi.fn(() => new Promise<string | null>((_settle, rejectPick) => { reject = rejectPick }))
    const late = owner()
    const failingView = render(<NativeDirectoryFlow {...late} pick={failing} />)
    failingView.unmount()
    await act(async () => { reject(new Error('too late')) })
    expect(late.onError).not.toHaveBeenCalled()
  })

  it('reports null as cancellation and re-arms after the owner withdraws open', async () => {
    const pick = vi.fn(async () => null as string | null)
    const props = owner()
    const view = render(<NativeDirectoryFlow {...props} pick={pick} />)
    await act(async () => {})
    expect(props.onCancel).toHaveBeenCalledOnce()
    expect(props.onPicked).not.toHaveBeenCalled()
    // Withdraw and reopen: a fresh request runs a fresh pick.
    view.rerender(<NativeDirectoryFlow {...props} open={false} pick={pick} />)
    view.rerender(<NativeDirectoryFlow {...props} pick={pick} />)
    await act(async () => {})
    expect(pick).toHaveBeenCalledTimes(2)
  })

  it('folds pick failures into onError messages', async () => {
    const props = owner()
    render(<NativeDirectoryFlow {...props} pick={vi.fn(async () => { throw new Error('no chooser installed') })} />)
    await act(async () => {})
    expect(props.onError).toHaveBeenCalledWith('no chooser installed')

    const nonError = owner()
    render(<NativeDirectoryFlow {...nonError} pick={vi.fn(async () => { throw 'denied' })} />)
    await act(async () => {})
    expect(nonError.onError).toHaveBeenCalledWith('denied')
  })

  it('renders nothing while closed and while open', () => {
    const closed = render(<NativeDirectoryFlow {...owner({ open: false })} pick={vi.fn(async () => null)} />)
    expect(closed.container.innerHTML).toBe('')
    const opened = render(<NativeDirectoryFlow {...owner()} pick={vi.fn(async () => null)} />)
    expect(opened.container.innerHTML).toBe('')
  })
})

describe('directory-picker-native node half', () => {
  it('the node apply is an inert loader seat', () => {
    expect(() => { nodeApply() }).not.toThrow()
  })
})
