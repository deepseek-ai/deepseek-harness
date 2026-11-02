// @vitest-environment jsdom
import type { MenuAction } from '../src/client/types.ts'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import type { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { MenuOverlayInjected } from '../src/client/View.tsx'
import { apply, inject } from '../src/client/index.ts'
import { apply as hostApply } from '../src/index.ts'
import type { createMenuStore } from '../src/client/store.ts'

afterEach(() => { vi.useRealTimers() })

declare module '@deepseek-ai/dsh-client-ui-context-menu/client' {
  interface ContextMenuTargetMap { pluginDocument: { readonly id: string } }
}

it('lets an external contribution open another menu and withdraws its actions when its fiber unloads', async () => {
  const ctx = new Context()
  ctx.provide('shortcuts', { catalog: createSnapshotStore([]) } as never)
  let overlay!: MenuOverlayInjected
  let store!: ReturnType<ReturnType<typeof createMenuStore>['create']>
  ctx.provide('slots', { provideRoot: () => () => {},
    inject: (_name: string, register: Parameters<SlotRegistry['inject']>[1]) => ctx.effect(register),
    register: (entry: { inject: () => MenuOverlayInjected; store: ReturnType<typeof createMenuStore> }) => {
      overlay = entry.inject(); store = entry.store.create(); return () => {}
    },
  } as never)
  ctx.provide('locale', { register: () => () => {}, bind: () => (key: string) => key } as never)
  const menuFiber = ctx.plugin({ inject, apply })
  await menuFiber.await()
  expect(hostApply).not.toThrow()
  const run = vi.fn()
  const contribution = ctx.plugin({ inject: ['contextMenus'], apply: (plugin: Context) => {
    plugin.effect(() => plugin.contextMenus.register({
      target: 'pluginDocument', id: 'example.document', order: 0,
      resolve: ({ id }) => [{ id: 'inspect', label: id, run: () => {
        run(id)
        plugin.contextMenus.open({ kind: 'pluginDocument', value: { id: 'next' } }, { x: 3, y: 4 })
      } }],
    }))
  } })
  await contribution.await()
  try {
    ctx.contextMenus.open({ kind: 'pluginDocument', value: { id: 'clicked' } }, { x: 1, y: 2 })
    await vi.waitFor(() => { expect(store.getSnapshot().items.length).toBeGreaterThan(0) })
    overlay.select('example.document/inspect')
    expect(run).toHaveBeenCalledExactlyOnceWith('clicked')
    expect(ctx.contextMenus.active.getSnapshot()).toEqual({ kind: 'pluginDocument', value: { id: 'next' } })
    const occurrence = ctx.contextMenus.resolve({ kind: 'pluginDocument', value: { id: 'retained' } })
    expect(occurrence.source.getSnapshot().map(action => action.label)).toEqual(['retained'])
    await contribution.dispose()
    expect(occurrence.source.getSnapshot()).toEqual([])
    occurrence.select('example.document/inspect')
    expect(run).toHaveBeenCalledOnce()
    occurrence.dispose()
    ctx.contextMenus.notify('Saved', true)
    expect(store.getSnapshot().notice).toMatchObject({ text: 'Saved', success: true })
    ctx.contextMenus.notify('Unavailable')
    expect(store.getSnapshot().notice).toMatchObject({ text: 'Unavailable', success: false })
    const reveal = vi.fn(async () => {})
    ctx.contextMenus.notify('Saved', true, { label: 'Show in folder', run: reveal, failureLabel: 'Reveal failed' })
    const previousAction = store.getSnapshot().notice!.action!
    expect(previousAction.label).toBe('Show in folder')
    previousAction.onClick()
    previousAction.onClick()
    expect(reveal).toHaveBeenCalledOnce()
    expect(store.getSnapshot().notice).toBeNull()
    ctx.contextMenus.notify('Saved again', true, { label: 'Show in folder', run: reveal, failureLabel: 'Reveal failed' })
    const replaced = store.getSnapshot().notice!.action!
    ctx.contextMenus.notify('New notice')
    replaced.onClick()
    expect(reveal).toHaveBeenCalledOnce()
    for (const fail of [() => { throw new Error('denied') }, async () => { throw new Error('offline') }]) {
      ctx.contextMenus.notify('Saved', true, { label: 'Show in folder', run: fail, failureLabel: 'Reveal failed' })
      store.getSnapshot().notice!.action!.onClick()
      await vi.waitFor(() => { expect(store.getSnapshot().notice).toMatchObject({ text: 'Reveal failed', success: false }) })
    }
    const removeFailure = ctx.contextMenus.register({ target: 'pluginDocument', id: 'failure', order: 0,
      resolve: () => { throw new Error('Metadata unavailable') } })
    ctx.contextMenus.open({ kind: 'pluginDocument', value: { id: 'failed' } }, { x: 0, y: 0 })
    expect(store.getSnapshot().notice?.text).toBe('failed')
    removeFailure()
    const removeAction = ctx.contextMenus.register({ target: 'pluginDocument', id: 'action', order: 0,
      resolve: () => [{ id: 'copy', label: 'Copy', failureLabel: 'Copy failed', run: () => { throw new Error('Denied') } }] })
    ctx.contextMenus.open({ kind: 'pluginDocument', value: { id: 'failed-action' } }, { x: 0, y: 0 })
    overlay.select('action/copy')
    expect(store.getSnapshot().notice?.text).toBe('Copy failed')
    removeAction()
  } finally { await contribution.dispose(); await menuFiber.dispose() }
})

it('waits for metadata, toggles nearby repeated gestures, replaces occurrences, and cancels pending openings', async () => {
  vi.useFakeTimers()
  const ctx = new Context()
  ctx.provide('shortcuts', { catalog: createSnapshotStore([]) } as never)
  let store!: ReturnType<ReturnType<typeof createMenuStore>['create']>
  ctx.provide('slots', { provideRoot: () => () => {},
    inject: (_name: string, register: Parameters<SlotRegistry['inject']>[1]) => ctx.effect(register),
    register: (entry: { store: ReturnType<typeof createMenuStore> }) => { store = entry.store.create(); return () => {} },
  } as never)
  ctx.provide('locale', { register: () => () => {}, bind: () => (key: string) => key } as never)
  const fiber = ctx.plugin({ inject, apply })
  await fiber.await()
  let finish!: (actions: readonly MenuAction[]) => void
  ctx.contextMenus.register({ target: 'pluginDocument', id: 'slow', order: 0,
    resolve: () => new Promise((resolve) => { finish = resolve }) })
  const target = { kind: 'pluginDocument' as const, value: { id: 'file' } }
  try {
    ctx.contextMenus.open(target, { x: 20, y: 30 })
    await vi.advanceTimersByTimeAsync(100)
    expect(store.getSnapshot().target).toBeNull()
    finish([{ id: 'open', label: 'Open' }])
    await vi.advanceTimersByTimeAsync(0)
    expect(store.getSnapshot().items.map(item => item.label)).toEqual(['Open'])
    const first = store.getSnapshot().occurrence
    ctx.contextMenus.open(target, { x: 22, y: 31 })
    expect(ctx.contextMenus.active.getSnapshot()).toBeNull()
    expect(store.getSnapshot().closing).toBe(true)
    await vi.advanceTimersByTimeAsync(80)
    expect(store.getSnapshot().target).toBeNull()
    ctx.contextMenus.open(target, { x: 80, y: 30 })
    finish([{ id: 'second', label: 'Second' }])
    await vi.advanceTimersByTimeAsync(40)
    expect(store.getSnapshot().occurrence).toBe(first + 1)
    ctx.contextMenus.open(target, { x: 180, y: 30 })
    expect(store.getSnapshot().replacing).toBe(true)
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    finish([{ id: 'late', label: 'Late' }])
    await vi.advanceTimersByTimeAsync(100)
    expect(store.getSnapshot().target).toBeNull()
    ctx.contextMenus.open(target, { x: 20, y: 30 })
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    finish([{ id: 'escape', label: 'Escape' }])
    await vi.advanceTimersByTimeAsync(100)
    expect(store.getSnapshot().target).toBeNull()
  } finally { await fiber.dispose() }
})

it('keeps trigger focus through replacement and ignores non-dismissal events and late feedback', async () => {
  vi.useFakeTimers()
  const ctx = new Context()
  ctx.provide('shortcuts', { catalog: createSnapshotStore([]) } as never)
  let overlay!: MenuOverlayInjected
  ctx.provide('slots', { provideRoot: () => () => {},
    inject: (_name: string, register: Parameters<SlotRegistry['inject']>[1]) => ctx.effect(register),
    register: (entry: { inject: () => MenuOverlayInjected }) => { overlay = entry.inject(); return () => {} },
  } as never)
  ctx.provide('locale', { register: () => () => {}, bind: () => (key: string) => key } as never)
  const fiber = ctx.plugin({ inject, apply })
  await fiber.await()
  const notify = ctx.contextMenus.notify.bind(ctx.contextMenus)
  ctx.contextMenus.register({ target: 'pluginDocument', id: 'plain', order: 0, resolve: () => [{ id: 'copy', label: 'Copy' }] })
  const trigger = document.createElement('button'), menu = document.createElement('button')
  menu.setAttribute('data-context-menu', '')
  menu.setAttribute('role', 'menu')
  document.body.append(trigger, menu)
  try {
    trigger.focus()
    ctx.contextMenus.open({ kind: 'pluginDocument', value: { id: 'first' } }, { x: 10, y: 10 })
    await vi.advanceTimersByTimeAsync(40)
    expect(overlay.returnFocus?.()).toBe(trigger)
    menu.focus()
    ctx.contextMenus.open({ kind: 'pluginDocument', value: { id: 'second' } }, { x: 80, y: 80 })
    await vi.advanceTimersByTimeAsync(40)
    expect(overlay.returnFocus?.()).toBe(trigger)
    menu.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 2 }))
    menu.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }))
    expect(ctx.contextMenus.active.getSnapshot()).not.toBeNull()
    document.dispatchEvent(new MouseEvent('contextmenu', { cancelable: true }))
    expect(ctx.contextMenus.active.getSnapshot()).toBeNull()
    const handled = new MouseEvent('contextmenu', { cancelable: true }); handled.preventDefault()
    document.dispatchEvent(handled)
    document.dispatchEvent(new Event('pointerdown'))
    expect(ctx.contextMenus.active.getSnapshot()).toBeNull()
    const active = vi.spyOn(document, 'activeElement', 'get').mockReturnValue(null)
    ctx.contextMenus.open({ kind: 'pluginDocument', value: { id: 'third' } }, { x: 80, y: 80 })
    active.mockRestore()
    expect(overlay.returnFocus?.()).toBeNull()
  } finally { trigger.remove(); menu.remove(); await fiber.dispose() }
  notify('late')
})

it('leaves unbound keyboard gestures native', async () => {
  const ctx = new Context()
  ctx.provide('shortcuts', { catalog: createSnapshotStore([]) } as never)
  ctx.provide('slots', { provideRoot: () => () => {}, inject: () => () => {} } as never)
  ctx.provide('locale', { register: () => () => {}, bind: () => (key: string) => key } as never)
  const fiber = ctx.plugin({ inject, apply })
  await fiber.await()
  try {
    const event = new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true, cancelable: true })
    document.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
  } finally { await fiber.dispose() }
})
