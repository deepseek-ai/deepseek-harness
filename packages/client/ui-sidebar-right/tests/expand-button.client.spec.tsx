// @vitest-environment jsdom
import { contextMenuHook } from '@deepseek-ai/dsh-client-test-runtime'
/**
 * Mobile devices preserve the header control's identity; desktops release
 * its header space while open.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import * as uiPrimitives from '@deepseek-ai/dsh-client-ui-primitives'
import type { GlobalStandardProps, SessionStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type { ShortcutCatalogEntry } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { allowAllAccess } from '@deepseek-ai/dsh-client-test-runtime'
import { ExpandButton } from '../src/client/shell/ExpandButton.tsx'
import type { ExpandButtonProps } from '../src/client/shell/ExpandButton.tsx'
import { createSidebarRightStore } from '../src/client/stores.ts'

const SESSION = 's-test' as SessionId
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
const unused = (): never => { throw new Error('This isolated component does not consume framework hooks') }
const standard: GlobalStandardProps & SessionStandardProps = {
  sessionId: SESSION, useSession: unused, useProjection: unused, useConversation: unused,
  useInput: unused, useChat: unused, useTrajectory: unused,
  usePanelInfo: unused, useSessions: unused, useSessionStatus: unused,
  useSessionRetainInfo: unused, useResource: unused, useWorkspaces: unused,
  ...allowAllAccess,
  useContextMenu: contextMenuHook(),
  inputActions: { insertQuote: () => false, captureInsertion: unused, insertText: unused, setDraft: unused, persistDraft: unused,
    addAttachments: unused, removeAttachment: unused, pruneAttachments: unused, submit: unused },
}

/** Test-local selector hook over a framework-neutral store instance. */
function hookOf<T>(inst: { subscribe: (fn: () => void) => () => void; getSnapshot: () => T }) {
  return function useSelector<S>(sel: (s: T) => S): S {
    return sel(useSyncExternalStore(inst.subscribe, inst.getSnapshot))
  }
}

/** Mount the button over its real store and an empty shortcut catalog. */
function mountButton(shortcuts: readonly ShortcutCatalogEntry[] = [], mobile = false) {
  vi.spyOn(uiPrimitives, 'isMobileDevice').mockReturnValue(mobile)
  const instance = createSidebarRightStore(() => ({ kind: 'guide', title: 'Start' })).create()
  const props: ExpandButtonProps = {
    ...standard,
    useShortcuts: <T,>(selector: (entries: readonly ShortcutCatalogEntry[]) => T): T => selector(shortcuts),
    sessionId: SESSION,
    useStore: hookOf(instance),
    actions: instance.actions,
    // Copy is the dictionary's contract; the key stands in for the translation.
    t: (key: string) => key,
  }
  const view = render(<ExpandButton {...props} />)
  const control = (): HTMLButtonElement | null => view.container.querySelector('[data-sidebar-right-expand]')
  return { instance, view, control }
}

describe('ExpandButton', () => {
  it('advertises the configured expand binding', async () => {
    const { instance, control, view } = mountButton([{ id: 'sidebar.right.toggle' as never, label: 'Toggle', aliases: [],
      binding: null, keys: ['Ctrl', 'B'], aria: 'Control+B', modified: true, conflicts: [], issue: null }], true)
    expect(control()?.getAttribute('aria-keyshortcuts')).toBe('Control+B')
    fireEvent.pointerEnter(control()!)
    const tooltip = await view.findByRole('tooltip')
    expect(tooltip.textContent).toContain('chrome.expand')
    expect(Array.from(tooltip.querySelectorAll('kbd'), key => key.textContent)).toEqual(['Ctrl', 'B'])
    act(() => { instance.actions.setExpanded(SESSION, true) })
    expect(view.queryByRole('tooltip')).toBeNull()
  })
  it('offers the way in while the session has no surface yet, and asks the panel to expand', () => {
    const { instance, control } = mountButton()
    const button = control()
    if (button === null) throw new Error('expected the expand control')
    expect(button.getAttribute('aria-label')).toBe('chrome.expandAria')
    fireEvent.click(button)
    expect(instance.getSnapshot().bySession[SESSION]?.layout.expanded).toBe(true)
    expect(control()).toBeNull()
    act(() => { instance.actions.setExpanded(SESSION, false) })
    expect(control()?.disabled).toBe(false)
  })

  it.each(['push', 'fullscreen'] as const)('retains the disabled control through mobile %s panel opening and closing', (mode) => {
    const { instance, control } = mountButton([], true)
    const button = control()
    if (button === null) throw new Error('expected the expand control')
    act(() => {
      instance.actions.setMode(SESSION, mode)
      instance.actions.setExpanded(SESSION, true)
    })
    expect(control()).toBe(button)
    expect(button.disabled).toBe(true)
    act(() => { instance.actions.setExpanded(SESSION, false) })
    expect(control()).toBe(button)
    expect(button.disabled).toBe(false)
  })

  it('releases header space for a manually fullscreen panel on desktop', () => {
    const { instance, control } = mountButton()
    act(() => {
      instance.actions.setMode(SESSION, 'fullscreen')
      instance.actions.setExpanded(SESSION, true)
    })
    expect(instance.getSnapshot().bySession[SESSION]?.layout.mode).toBe('fullscreen')
    expect(control()).toBeNull()
    act(() => { instance.actions.setExpanded(SESSION, false) })
    expect(control()?.disabled).toBe(false)
  })
})
