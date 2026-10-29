// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { bindSnapshotSelector, SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'
import { ShortcutRegistry } from '../../shortcuts/src/client/registry.ts'
import type { ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { createMenuStore } from '../src/client/store.ts'
import { MenuOverlay } from '../src/client/View.tsx'
import { apply, inject } from '../src/client/index.ts'
import type { ContextMenuTarget } from '../src/client/types.ts'

afterEach(() => { cleanup(); vi.useRealTimers() })

it('renders legacy Session actions before data contributions and restores More focus after dismissal', async () => {
  const store = createMenuStore().create(), run = vi.fn()
  const close = () => { store.actions.close() }
  const useStore = bindSnapshotSelector(store)
  const view = render(<>
    <button onClick={() => { store.actions.open({ kind: 'session', value: { sessionId: SessionId('clicked'), displayTitle: 'Clicked' } }, { x: 20, y: 30 }) }}>More</button>
    <MenuOverlay useCatalog={select => select([])} useStore={useStore} actions={store.actions} close={close} select={run}
      renderSlot={(_key, owner: object) => {
        const { target, dismiss } = owner as { target: ContextMenuTarget; dismiss: () => void }
        return <MenuItemButton onSelect={() => {
          if (target.kind === 'session') run(target.value.sessionId)
          dismiss()
        }}>Export</MenuItemButton>
      }} />
  </>)
  const trigger = view.getByRole('button', { name: 'More' })
  trigger.focus(); fireEvent.click(trigger)
  await waitFor(() =>{  expect(view.getByRole('menuitem', { name: 'Export' })).toBe(document.activeElement) })
  fireEvent.click(view.getByRole('menuitem', { name: 'Export' }))
  await waitFor(() =>{  expect(document.activeElement).toBe(trigger) })
  expect(run).toHaveBeenCalledExactlyOnceWith('clicked')
  expect(view.queryByRole('menu')).toBeNull()
  fireEvent.click(trigger)
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(view.queryByRole('menu')).toBeNull()
  fireEvent.click(trigger)
  fireEvent.pointerDown(document.body)
  expect(view.queryByRole('menu')).toBeNull()
})

it('renders disabled, grouped and nested data actions and keeps feedback after menu dismissal', () => {
  vi.useFakeTimers()
  const store = createMenuStore().create(), select = vi.fn()
  store.actions.open({ kind: 'session', value: { sessionId: SessionId('clicked'), displayTitle: 'Clicked' } }, { x: 20, y: 30 })
  store.actions.items([
    { id: 'plain', label: 'Open' },
    { id: 'blocked', label: 'Unavailable', disabled: true, danger: true, separatorBefore: true },
    { id: 'parent', label: 'Export', children: [{ id: 'child', label: 'Original' }, { id: 'other', label: 'Other', separatorBefore: true }] },
    { id: 'footer', label: 'Folder', afterContent: true },
  ])
  const view = render(<MenuOverlay useCatalog={select => select([])} useStore={bindSnapshotSelector(store)} actions={store.actions}
    close={() => { store.actions.close() }} select={select} renderSlot={() => null} />)
  expect(view.getByRole('menuitem', { name: 'Unavailable' }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(view.getByRole('menuitem', { name: 'Open' }))
  expect(select).toHaveBeenCalledWith('plain')
  fireEvent.click(view.getByRole('menuitem', { name: 'Export' }))
  expect(view.getAllByRole('separator')).toHaveLength(2)
  fireEvent.click(view.getByRole('menuitem', { name: 'Original' }))
  expect(select).toHaveBeenCalledWith('child')
  act(() => { store.actions.exit(true) })
  expect(document.querySelector('[data-menu-phase="replace"]')).not.toBeNull()
  act(() => { store.actions.exit(false) })
  expect(document.querySelector('[data-menu-phase="dismiss"]')).not.toBeNull()
  const reveal = vi.fn()
  act(() => { store.actions.close(); store.actions.notify({ id: 1, text: 'Saved', success: true,
    action: { label: 'Show in Finder', onClick: reveal } }) })
  expect(view.queryByRole('menu')).toBeNull()
  expect(view.getByRole('alert').textContent).toBe('SavedShow in Finder')
  fireEvent.click(view.getByRole('button', { name: 'Show in Finder' }))
  expect(reveal).toHaveBeenCalledOnce()
  act(() => { store.actions.notify({ id: 2, text: 'Copy failed', success: false }) })
  expect(view.getByRole('alert').textContent).toBe('Copy failed')
  expect(view.queryByRole('button', { name: 'Show in Finder' })).toBeNull()
  act(() => { vi.advanceTimersByTime(4000) })
  expect(view.queryByRole('alert')).toBeNull()
})

function PluginIcon({ icon }: PropsRuntime<'contextMenu.icon'>) {
  return <img data-testid="plugin-icon" src={icon.src} alt="" />
}

it('dispatches captured icon keys in rows, submenus and footers and retires renderer registrations on unload', async () => {
  const runtime = await SlotTestRuntime.create()
  onTestFinished(() => runtime.dispose())
  runtime.ctx.provide('shortcuts', { catalog: createSnapshotStore([]) } as never)
  runtime.ctx.provide('locale', { register: () => () => {}, bind: () => (key: string) => key } as never)
  await runtime.root.declare({ 'shell.overlay': { kind: 'list', scope: 'root' } }, ({ renderSlot }) =>
    <>{renderSlot('shell.overlay', {})}</>)
  const menuPlugin = await runtime.mount({ inject, apply })
  const run = vi.fn()
  const contribution = await runtime.mount({ inject: ['contextMenus'], apply(ctx) {
    ctx.effect(() => ctx.contextMenus.register({ id: 'icons', target: 'session', order: 0, resolve: () => [
      { id: 'row', label: 'Open', icon: { key: 'example.icon', src: '/captured.png' }, run },
      { id: 'parent', label: 'Export', children: [{ id: 'child', label: 'Original', icon: { key: 'example.icon' } }] },
      { id: 'footer', label: 'Footer', afterContent: true, icon: { key: 'example.icon' } },
    ] }))
  } })
  const icons = await runtime.mount({ inject: ['slots'], apply(ctx) {
    ctx.slots.inject('contextMenu.icon', function* () {
      yield ctx.slots.register({ name: 'contextMenu.icon', key: 'example.icon' }, PluginIcon)
      yield ctx.slots.register({ name: 'contextMenu.icon', key: 'example.unused' }, () => <span>Unused icon</span>)
    })
  } })
  const view = runtime.renderRoot()
  const open = () => { runtime.ctx.contextMenus.open({ kind: 'session', value: {
    sessionId: SessionId('icons'), displayTitle: 'Icons',
  } }, { x: 20, y: 30 }) }
  act(open)
  await waitFor(() => { expect(view.getAllByTestId('plugin-icon')).toHaveLength(2) })
  expect(view.getByRole('menuitem', { name: 'Open' }).querySelector('img')?.getAttribute('src')).toBe('/captured.png')
  expect(view.queryByText('Unused icon')).toBeNull()
  fireEvent.click(view.getByRole('menuitem', { name: 'Export' }))
  expect(view.getByRole('menuitem', { name: 'Original' }).querySelector('img')).not.toBeNull()
  await icons.dispose()
  expect(view.queryAllByTestId('plugin-icon')).toHaveLength(0)
  fireEvent.click(view.getByRole('menuitem', { name: 'Open' }))
  expect(run).toHaveBeenCalledOnce()
  await contribution.dispose()
  await menuPlugin.dispose()
  expect(runtime.slots.spec('contextMenu.icon')).toBeUndefined()
})

it('tracks configured shortcuts for nested and footer actions without invoking command dispatch', () => {
  const shortcuts = new ShortcutRegistry('desktop', 'macos')
  const commandId = 'session.rename' as ShortcutCommandId
  const resolveCommand = vi.fn(() => ({ status: 'pass' as const }))
  const remove = shortcuts.register({ id: commandId, label: () => 'Rename', aliases: [],
    defaults: { 'desktop:macos': { code: 'KeyG', modifiers: ['primary', 'alt'] } },
    regions: ['page'], modals: [], resolve: resolveCommand })
  const store = createMenuStore().create()
  store.actions.open({ kind: 'session', value: { sessionId: SessionId('captured'), displayTitle: 'Captured' } }, { x: 30, y: 40 })
  store.actions.items([
    { id: 'rename', label: 'Rename', commandId },
    { id: 'missing', label: 'Unknown command', commandId: 'absent' as ShortcutCommandId },
    { id: 'parent', label: 'Submenu', children: [{ id: 'nested', label: 'Nested', commandId }] },
    { id: 'footer', label: 'Footer', commandId, afterContent: true },
  ])
  const select = vi.fn()
  const view = render(<MenuOverlay useStore={bindSnapshotSelector(store)} actions={store.actions}
    useCatalog={bindSnapshotSelector(shortcuts.catalog)} close={vi.fn()} select={select} renderSlot={() => null} />)
  const item = view.getByRole('menuitem', { name: 'Rename' })
  expect(item.getAttribute('aria-keyshortcuts')).toBe('Alt+Meta+G')
  expect(view.getByRole('menuitem', { name: 'Unknown command' }).getAttribute('aria-keyshortcuts')).toBeNull()
  act(() => { shortcuts.configure({ ...shortcuts.config.getSnapshot(), revision: 'custom' as never,
    document: { schemaVersion: 2, profiles: { 'desktop:macos': { 'session.rename': { code: 'KeyR', modifiers: ['primary', 'shift'] } } } } }) })
  expect(item.getAttribute('aria-keyshortcuts')).toBe('Shift+Meta+R')
  expect(view.getByRole('menuitem', { name: 'Footer' }).getAttribute('aria-keyshortcuts')).toBe('Shift+Meta+R')
  fireEvent.click(view.getByRole('menuitem', { name: 'Submenu' }))
  expect(view.getByRole('menuitem', { name: 'Nested' }).getAttribute('aria-keyshortcuts')).toBe('Shift+Meta+R')
  act(() => { shortcuts.configure({ ...shortcuts.config.getSnapshot(), revision: 'unbound' as never,
    document: { schemaVersion: 2, profiles: { 'desktop:macos': { 'session.rename': null } } } }) })
  expect(item.getAttribute('aria-keyshortcuts')).toBeNull()
  expect(item.querySelector('kbd')).toBeNull()
  act(remove)
  expect(item.getAttribute('aria-keyshortcuts')).toBeNull()
  fireEvent.click(item)
  expect(select).toHaveBeenCalledWith('rename')
  expect(resolveCommand).not.toHaveBeenCalled()
})
