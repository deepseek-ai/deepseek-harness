// @vitest-environment jsdom
import { useState, type ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { Menu, MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'
import { CreatePluginMenuItem } from '../src/client/CreatePluginMenuItem.tsx'
import type { AgentPresetSettingsState } from '../src/client/settings-store.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)
const translations: ReadonlyMap<string, string> = new Map(Object.entries(en))

function unusedHook(): never {
  throw new Error('Create plugin does not read this slot source')
}

function view(roster: Partial<AgentPresetSettingsState> = {}, inMenu = false) {
  const agentPresets = createSnapshotStore<AgentPresetSettingsState>({
    status: 'ready', error: null, options: [{ id: 'standard' }, { id: 'cordis' }], ...roster,
  })
  const calls: string[] = []
  const startCreatorDraft = vi.fn(() => { calls.push('start') })
  const onDismiss = vi.fn(() => { calls.push('dismiss') })
  const load = vi.fn(async () => {})
  const props: ComponentProps<typeof CreatePluginMenuItem> = {
    t: key => translations.get(key) ?? key,
    useAgentPresets: bindSnapshotSelector(agentPresets),
    usePanelInfo: unusedHook, useSessions: unusedHook, useSessionStatus: unusedHook,
    useSessionRetainInfo: unusedHook, useWorkspaces: unusedHook, useResource: unusedHook,
    load, startCreatorDraft, onDismiss,
  }
  function TestMenu() {
    const [open, setOpen] = useState(true)
    return <Menu open={open} items={[]} autoFocus onClose={() => { setOpen(false) }}
      anchor={<button type="button">Add plugin</button>}>
      <MenuItemButton onSelect={() => {}}>Install a third-party plugin</MenuItemButton>
      <CreatePluginMenuItem {...props} onDismiss={() => { onDismiss(); setOpen(false) }} />
    </Menu>
  }
  render(inMenu ? <TestMenu /> : <CreatePluginMenuItem {...props} />)
  return { agentPresets, load, startCreatorDraft, onDismiss, calls }
}

function item(): HTMLElement {
  return screen.getByRole('menuitem', { name: new RegExp(en.createPlugin) })
}

describe('Create plugin menu item', () => {
  it('explains Creator and dismisses the menu before starting it exactly once', () => {
    const actions = view({}, true)
    expect(actions.load).toHaveBeenCalledOnce()
    expect(item().textContent).toContain(en.createPluginDescription)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(actions.startCreatorDraft).not.toHaveBeenCalled()
    fireEvent.click(item())
    expect(actions.calls).toEqual(['dismiss', 'start'])
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('supports keyboard selection through the shared menu and closes before navigation', () => {
    const actions = view({}, true)
    const trigger = item()
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'Tab' })
    expect(actions.calls).toEqual(['dismiss', 'start'])
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it.each(['idle', 'loading', 'error', 'unavailable'] as const)('keeps a disabled entry while the roster is %s', (status) => {
    const actions = view({ status })
    expect(item()).toHaveProperty('disabled', true)
    const description = status === 'idle' || status === 'loading' ? en.createPluginChecking : en.createPluginUnavailable
    expect(item().textContent).toContain(description)
    fireEvent.click(item())
    expect(actions.calls).toEqual([])
  })

  it('disables the same entry when Creator leaves the roster', () => {
    const actions = view()
    const original = item()
    act(() => { actions.agentPresets.set({ status: 'ready', error: null, options: [{ id: 'standard' }] }) })
    expect(item()).toBe(original)
    expect(item()).toHaveProperty('disabled', true)
    expect(item().textContent).toContain(en.createPluginMissing)
    fireEvent.click(item())
    expect(actions.calls).toEqual([])
  })

  it('keeps the same second menu item through ready, loading, and ready states', () => {
    const actions = view({}, true)
    const menu = screen.getByRole('menu')
    const before = screen.getAllByRole('menuitem')
    const original = item()
    expect(before[1]).toBe(original)
    expect(original).toHaveProperty('disabled', false)

    act(() => { actions.agentPresets.set({ ...actions.agentPresets.getSnapshot(), status: 'loading' }) })
    expect(screen.getByRole('menu')).toBe(menu)
    expect(screen.getAllByRole('menuitem')).toEqual(before)
    expect(item()).toBe(original)
    expect(original).toHaveProperty('disabled', true)
    expect(original.textContent).toContain(en.createPluginChecking)
    fireEvent.click(original)
    expect(actions.calls).toEqual([])

    act(() => { actions.agentPresets.set({ ...actions.agentPresets.getSnapshot(), status: 'ready' }) })
    expect(screen.getByRole('menu')).toBe(menu)
    expect(screen.getAllByRole('menuitem')).toEqual(before)
    expect(item()).toBe(original)
    expect(original).toHaveProperty('disabled', false)
    expect(original.textContent).toContain(en.createPluginDescription)
    fireEvent.click(original)
    expect(actions.calls).toEqual(['dismiss', 'start'])
  })
})
