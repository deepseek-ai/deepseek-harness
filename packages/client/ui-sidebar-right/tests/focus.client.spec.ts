// @vitest-environment jsdom
/** Focus ownership remains separate from layout selection and validates captured lifetimes. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { cleanup, render } from '@testing-library/react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { Context } from '@deepseek-ai/cordis'
import { activeDockPaneId, findTabPane, getPane } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createSidebarRightController } from '../src/client/service.ts'
import { createSidebarRightStore } from '../src/client/stores.ts'
import { SidebarRightTabRegistry } from '../src/client/tab-registry.ts'
import { ShortcutRegistry } from '@deepseek-ai/dsh-client-shortcuts/src/client/registry.ts'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { registerSidebarShortcuts } from '../src/client/shortcuts.ts'
import { en } from '../src/client/locales.ts'
import type { ShortcutCommand, ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'
import { observeSidebarFocus, sidebarTargetFromElement } from '../src/client/focus.ts'

const SESSION = 'focus-session' as SessionId
const releases: Array<() => void> = []
afterEach(() => { cleanup(); for (const release of releases.splice(0).reverse()) release(); document.body.replaceChildren() })

function harness() {
  const ctx = new Context()
  const tabs = new SidebarRightTabRegistry(ctx)
  for (const kind of ['guide', 'files', 'terminal']) tabs.register({ id: kind, kind, title: () => kind, multiple: kind === 'terminal' })
  const { controller, adopt } = createSidebarRightController(tabs, vi.fn())
  const store = createSidebarRightStore(() => ({ kind: 'guide', title: 'guide' })).create()
  releases.push(adopt(SESSION, store), () => { controller.tabDomain.dispose() })
  store.actions.setExpanded(SESSION, true)
  const room = { allowed: true, autoFullscreen: false }
  const bind = (sessionId = SESSION) => controller.bind({ sessionId, actions: store.actions,
    surfaces: store.getSnapshot().bySession,
    closeWithFocus: (_paneId, close) => { close() },
    openWithFocus: (open) => { open() },
    canSplitPane: () => room.allowed, autoFullscreen: room.autoFullscreen })
  releases.push(bind())
  const layout = () => store.getSnapshot().bySession[SESSION]!.layout
  const owner = document.createElement('section')
  owner.dataset.sidebarRightSession = SESSION
  document.body.append(owner)
  const paneElement = (paneId = activeDockPaneId(layout())) => {
    const pane = getPane(layout(), paneId)
    const element = document.createElement('section')
    element.tabIndex = -1
    element.dataset[pane.host === 'dock' ? 'dockkitPane' : 'dockkitFloat'] = paneId
    owner.append(element)
    return element
  }
  const tabElement = (tabId: TabId, parent = paneElement(findTabPane(layout(), tabId).id)) => {
    const element = document.createElement('div')
    element.tabIndex = 0
    element.dataset.dockkitTab = tabId
    element.dataset.sidebarRightOccurrence = controller.tabDomain.occurrence(SESSION, { id: tabId }).id
    parent.append(element)
    return element
  }
  return { controller, store, layout, paneElement, tabElement, room, bind }
}

describe('sidebar focus targets', () => {
  it('ignores floating pane markup outside a Session owner', () => {
    const pane = document.createElement('section')
    pane.tabIndex = -1
    pane.dataset.dockkitFloat = 'orphan'
    document.body.append(pane)
    releases.push(observeSidebarFocus(document))
    pane.focus()
    expect(document.activeElement).toBe(pane)
  })

  it('does not restore a removed editor over focus captured by another component', async () => {
    const h = harness(), pane = h.paneElement()
    pane.parentElement!.setAttribute('data-sidebar-right-open', '')
    const input = document.createElement('input'), outside = document.createElement('button')
    pane.append(input)
    document.body.append(outside)
    releases.push(observeSidebarFocus(document))
    input.focus()
    pane.append(document.createElement('span'))
    await Promise.resolve()
    expect(document.activeElement).toBe(input)
    input.remove()
    document.addEventListener('focusin', (event) => { event.stopImmediatePropagation() }, { capture: true, once: true })
    outside.focus()
    await Promise.resolve()
    expect(document.activeElement).toBe(outside)
  })
  it('uses keyboard-focused inactive tabs and iframe ownership instead of the last selected pane', () => {
    const h = harness()
    const left = activeDockPaneId(h.layout())
    h.controller.openTab('files')
    const files = h.controller.active()!.id
    const right = h.controller.split(left)!
    expect(h.layout().activePaneId).toBe(right)
    const chip = h.tabElement(files)
    chip.focus()
    expect(h.controller.focusedTarget()).toMatchObject({ sessionId: SESSION, paneId: left, tabId: files })
    const iframe = document.createElement('iframe')
    chip.append(iframe)
    iframe.focus()
    expect(h.controller.focusedTarget()).toMatchObject({ paneId: left, tabId: files })
    const composer = document.createElement('textarea')
    document.body.append(composer)
    composer.focus()
    expect(h.controller.focusedTarget()).toBeUndefined()
    expect(h.controller.commandTarget()?.paneId).toBe(right)
  })

  it('rejects collapsed, disconnected, switched-session, moved and reopened targets', () => {
    const h = harness()
    h.controller.openTab('files')
    const files = h.controller.active()!.id
    const chip = h.tabElement(files)
    const target = h.controller.focusedTarget(chip)!
    expect(h.controller.isTargetCurrent(target)).toBe(true)
    h.store.actions.setExpanded(SESSION, false)
    expect(h.controller.splitBlock(target)).toBe('collapsed')
    expect(h.controller.focusedTarget(chip)).toBeUndefined()
    expect(h.controller.commandTarget(chip)).toBeUndefined()
    h.store.actions.setExpanded(SESSION, true)
    releases.push(h.bind('another-session' as SessionId))
    expect(h.controller.isTargetCurrent(target)).toBe(false)
    expect(h.controller.focusedTarget(chip)).toBeUndefined()
    releases.push(h.bind())
    h.controller.float(files)
    expect(h.controller.isTargetCurrent(target)).toBe(false)
    h.controller.dock(findTabPane(h.layout(), files).id)
    h.controller.close(files)
    h.controller._undo()
    expect(h.controller.isTargetCurrent(target)).toBe(false)
    expect(h.controller.focusedTarget(chip)).toBeUndefined()
    chip.remove()
    expect(h.controller.focusedTarget(chip)).toBeUndefined()
  })

  it('rejects a pane removed by closing its final content page', () => {
    const h = harness()
    h.controller.split()
    h.controller.openTabFromTarget('files', h.controller.commandTarget(null)!)
    const captured = h.controller.focusedTarget(h.tabElement(h.controller.active()!.id))!
    h.controller.close(captured.tabId!)
    expect(h.controller.isTargetCurrent(captured)).toBe(false)
    h.controller.openTabFromTarget('terminal', captured)
    expect(Object.values(h.layout().tabs).map(tab => tab.kind)).toEqual(['guide'])
  })

  it('invalidates navigation captures and keeps opens scoped to the target pane', () => {
    const h = harness()
    const first = h.controller.commandTarget(null)!
    h.controller.openTabFromTarget('files', first)
    expect(Object.values(h.layout().tabs).map(tab => tab.kind)).toEqual(['files'])
    const files = h.controller.commandTarget(null)!
    h.controller.openTabFromTarget('files', files)
    expect(Object.values(h.layout().tabs)).toHaveLength(1)
    expect(h.controller.isTargetCurrent(files)).toBe(false)
    h.controller.openTabFromTarget('terminal', h.controller.commandTarget(null)!)
    h.controller.openTabFromTarget('terminal', h.controller.commandTarget(null)!)
    const terminals = Object.values(h.layout().tabs).filter(tab => tab.kind === 'terminal')
    expect(terminals).toHaveLength(2)
    expect(terminals[0]!.contentId).not.toBe(terminals[1]!.contentId)
    h.controller.float(terminals[0]!.id)
    const floating = h.controller.focusedTarget(h.tabElement(terminals[0]!.id))!
    h.controller.openTabFromTarget('terminal', floating)
    expect(Object.values(h.layout().tabs).filter(tab => tab.kind === 'terminal')).toHaveLength(3)
    expect(h.layout().tabs[terminals[0]!.id]).toBeDefined()
    expect(getPane(h.layout(), floating.paneId).tabs).toHaveLength(1)
  })

  it('shares split limits and fullscreen behavior while preserving floating pages', () => {
    const h = harness()
    const target = h.controller.commandTarget(null)!
    h.room.allowed = false
    expect(h.controller.splitBlock(target)).toBe('width')
    h.room.allowed = true
    expect(h.controller.splitBlock(target)).toBeUndefined()
    h.controller.toggleFullscreen(target)
    expect(h.layout().mode).toBe('fullscreen')
    h.controller.toggleFullscreen(target)
    expect(h.layout().mode).toBe('push')
    h.controller.split(target.paneId)
    expect(h.controller.splitBlock(target)).toBe('budget')
    h.controller.openTab('files')
    const files = h.controller.active()!.id
    h.controller.float(files)
    const floated = h.controller.focusedTarget(h.tabElement(files))!
    expect(h.controller.splitBlock(floated)).toBe('float')
    h.controller.toggleFullscreen(floated)
    expect(h.layout().mode).toBe('push')
    h.room.autoFullscreen = true
    releases.push(h.bind())
    h.controller.toggleFullscreen(h.controller.commandTarget(null)!)
    expect(h.layout().expanded).toBe(false)
  })

  it('rejects orphaned markup and preserves an empty pane identity until content arrives', () => {
    const h = harness()
    const pane = h.paneElement()
    const owner = pane.parentElement!
    const orphan = document.createElement('button')
    owner.append(orphan)
    expect(h.controller.focusedTarget(orphan)).toBeUndefined()
    const staleTab = document.createElement('div')
    staleTab.dataset.dockkitTab = 'removed-tab'
    pane.append(staleTab)
    expect(h.controller.focusedTarget(staleTab)).toBeUndefined()
    const stalePane = pane.cloneNode() as HTMLElement
    stalePane.dataset.dockkitPane = 'removed-pane'
    owner.append(stalePane)
    expect(h.controller.focusedTarget(stalePane)).toBeUndefined()
    h.controller.openTabFromTarget('files', h.controller.commandTarget(null)!)
    h.controller.close(h.controller.active()!.id)
    const empty = h.controller.commandTarget(null)!
    expect(empty.tabId).toBeUndefined()
    expect(h.controller.isTargetCurrent(empty)).toBe(true)
    expect(h.controller.closeTarget(empty)).toBe('unavailable')
    const surface = h.store.getSnapshot().bySession[SESSION]!
    h.store.store.set({ bySession: { [SESSION]: { ...surface, layout: { ...surface.layout, expanded: true } } } })
    expect(sidebarTargetFromElement(pane, SESSION, h.layout(), vi.fn())?.tabId).toBeUndefined()
    expect(h.controller.splitBlock(empty)).toBe('empty')
    h.controller.openTabFromTarget('files', empty)
    expect(h.controller.isTargetCurrent(empty)).toBe(false)
    h.controller.openTabFromTarget('terminal', empty)
    expect(Object.values(h.layout().tabs).map(tab => tab.kind)).toEqual(['files'])
    const floatingFile = h.controller.active()!.id
    h.controller.float(floatingFile)
    const floating = h.controller.focusedTarget(h.tabElement(floatingFile))!
    h.store.actions.setExpanded(SESSION, false)
    h.controller.openTabFromTarget('files', floating)
    expect(Object.values(h.layout().tabs).filter(tab => tab.kind === 'files')).toHaveLength(1)
    expect(findTabPane(h.layout(), floatingFile).id).toBe(floating.paneId)
    expect(h.layout().expanded).toBe(true)
    expect(h.controller.splitBlock(floating)).toBe('float')
    releases.push(h.bind('missing-session' as SessionId))
    expect(h.controller.commandTarget(null)).toBeUndefined()
    expect(h.controller.splitBlock(floating)).toBe('stale')
  })

  it('focuses pointer-activated pane contents and releases document listeners', async () => {
    const h = harness()
    const pane = h.paneElement()
    const body = document.createElement('div')
    pane.append(body)
    const release = observeSidebarFocus(document)
    body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    expect(document.activeElement).toBe(pane)
    const button = document.createElement('button')
    pane.append(button)
    button.focus()
    button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    expect(document.activeElement).toBe(button)
    document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    window.dispatchEvent(new Event('blur'))
    await Promise.resolve()
    window.dispatchEvent(new Event('blur'))
    release()
    await Promise.resolve()
    expect(document.activeElement).toBe(button)
    body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    expect(document.activeElement).toBe(button)
  })

  it.each([
    { name: 'outside editor range', inside: false, editable: true, textAnchor: true, collapsed: false },
    { name: 'outside editor caret', inside: false, editable: true, textAnchor: true, collapsed: true },
    { name: 'outside editor element', inside: false, editable: true, textAnchor: false, collapsed: false },
    { name: 'pane editor text', inside: true, editable: true, textAnchor: true, collapsed: false },
    { name: 'outside page text', inside: false, editable: false, textAnchor: true, collapsed: false },
  ])('preserves text selection while focusing a pane: $name', ({ inside, editable, textAnchor, collapsed }) => {
    const h = harness()
    const pane = h.paneElement()
    const selected = document.createElement('div')
    selected.setAttribute('contenteditable', String(editable))
    selected.textContent = 'preserved text'
    ;(inside ? pane : document.body).append(selected)
    releases.push(observeSidebarFocus(document))
    pane.focus()
    const selection = document.getSelection()!
    // Chromium retains the departing editor selection on focus; jsdom moves it to the pane.
    const anchor = textAnchor ? selected.firstChild! : selected
    selection.setBaseAndExtent(anchor, 0, anchor, textAnchor ? 'preserved text'.length : selected.childNodes.length)
    if (collapsed) selection.collapseToEnd()
    pane.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    expect(document.activeElement).toBe(pane)
    expect(selection.rangeCount).toBe(1)
    expect(selection.toString()).toBe(collapsed ? '' : 'preserved text')
    expect(selected.textContent).toBe('preserved text')
  })

  it('follows the active tab when a focused pane is replaced and its tabs move to different panes', async () => {
    const h = harness()
    const pane = h.paneElement()
    const owner = pane.parentElement!
    owner.setAttribute('data-sidebar-right-open', '')
    const tab = (id: string, selected: boolean) => {
      const button = document.createElement('button')
      button.setAttribute('role', 'tab')
      button.setAttribute('aria-selected', String(selected))
      const marker = document.createElement('span')
      marker.dataset.sidebarRightOccurrence = id
      button.append(marker)
      return button
    }
    const first = tab('first', false)
    const selected = tab('selected', true)
    pane.append(first, selected)
    releases.push(observeSidebarFocus(document))
    pane.focus()
    const firstPane = pane.cloneNode() as HTMLElement
    firstPane.dataset.dockkitPane = 'first-destination'
    firstPane.append(first)
    const selectedPane = pane.cloneNode() as HTMLElement
    selectedPane.dataset.dockkitPane = 'selected-destination'
    selectedPane.append(selected)
    pane.replaceWith(firstPane, selectedPane)
    await Promise.resolve()
    expect(document.activeElement).toBe(selectedPane)
  })

  it.each(['input', 'iframe'] as const)('retains the owning pane after its focused %s is remounted', async (kind) => {
    const h = harness()
    const pane = h.paneElement()
    pane.parentElement!.setAttribute('data-sidebar-right-open', '')
    const input = document.createElement(kind)
    pane.append(input)
    const release = observeSidebarFocus(document)
    releases.push(release)
    input.focus()
    input.replaceWith(document.createElement(kind))
    await Promise.resolve()
    expect(document.activeElement).toBe(pane)
  })

  it.each(['outside-pointer', 'other-focus', 'blur', 'hidden', 'session-change', 'dispose'] as const)('does not reclaim focus after %s', async (reason) => {
    const h = harness()
    const pane = h.paneElement()
    const owner = pane.parentElement!
    owner.setAttribute('data-sidebar-right-open', '')
    const input = document.createElement('input')
    pane.append(input)
    const outside = document.createElement('button')
    document.body.append(outside)
    const release = observeSidebarFocus(document)
    releases.push(release)
    input.focus()
    if (reason === 'outside-pointer') outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    else if (reason === 'other-focus') outside.focus()
    else if (reason === 'blur') input.blur()
    else if (reason === 'hidden') owner.removeAttribute('data-sidebar-right-open')
    else if (reason === 'session-change') owner.dataset.sidebarRightSession = 'different-session'
    else release()
    input.remove()
    await Promise.resolve()
    expect(document.activeElement).toBe(reason === 'other-focus' ? outside : document.body)
  })
})


describe('sidebar keyboard commands', () => {
  it('refuses Web close without focus and drops a refresh captured before replacement', () => {
    const h = harness(), commands = new Map<string, ShortcutCommand>()
    releases.push(registerSidebarShortcuts({ runtime: 'web', register: (command) => {
      commands.set(command.id, command); return () => { commands.delete(command.id) }
    } }, h.controller, makeTranslate(en), vi.fn()))
    const context = { target: null, region: 'page', modal: null } as const
    expect(commands.get('page.close')!.resolve(context)).toMatchObject({ status: 'blocked', reason: en['command.noFocus'] })
    h.controller.openTab('files')
    const id = h.controller.active()!.id
    const target = h.tabElement(id), refresh = vi.fn()
    const occurrence = h.controller.tabDomain.occurrence(SESSION, { id })
    const off = occurrence.tabActions.bindCommands({ refresh })
    const pending = commands.get('page.refresh')!.resolve({ ...context, target })
    off()
    if (pending.status !== 'handled') throw new Error('Expected refresh command')
    pending.run()
    expect(refresh).not.toHaveBeenCalled()
  })

  it('closes the Desktop window only while its captured empty pane remains current', () => {
    const h = harness(), commands = new Map<string, ShortcutCommand>(), closeWindow = vi.fn()
    releases.push(registerSidebarShortcuts({ runtime: 'desktop', register: (command) => {
      commands.set(command.id, command); return () => { commands.delete(command.id) }
    } }, h.controller, makeTranslate(en), closeWindow))
    h.controller.openTabFromTarget('files', h.controller.commandTarget(null)!)
    h.controller.close(h.controller.active()!.id)
    const surface = h.store.getSnapshot().bySession[SESSION]!
    h.store.store.set({ bySession: { [SESSION]: { ...surface, layout: { ...surface.layout, expanded: true } } } })
    const target = h.paneElement()
    const context = { target, region: 'page', modal: null } as const
    const pending = commands.get('page.close')!.resolve(context)
    if (pending.status !== 'handled') throw new Error('Expected window-close command')
    pending.run()
    expect(closeWindow).toHaveBeenCalledOnce()
    h.controller.openTab('files')
    pending.run()
    expect(closeWindow).toHaveBeenCalledOnce()
  })
  it.each(['macos', 'windows'] as const)('uses the effective %s binding, blocks collapsed splits and consumes repeats', (platform) => {
    const h = harness()
    const registry = new ShortcutRegistry('desktop', platform)
    releases.push(registerSidebarShortcuts({ register: command => registry.register(command),
      runtime: registry.runtime }, h.controller, makeTranslate(en), vi.fn()))
    const consume = vi.fn()
    const gesture = { code: 'KeyB', meta: platform === 'macos', control: platform === 'windows', alt: true,
      shift: false, repeat: false, composing: false, defaultPrevented: false }
    const context = { target: null, region: 'editable' as const, modal: null }
    expect(registry.dispatch(gesture, context, consume).status).toBe('handled')
    expect(h.layout().expanded).toBe(false)
    expect(registry.dispatch({ ...gesture, code: 'Backslash', alt: false }, context, consume).status).toBe('blocked')
    expect(registry.dispatch({ ...gesture, repeat: true }, context, consume).status).toBe('handled')
    expect(h.layout().expanded).toBe(false)
    registry.dispatch(gesture, context, consume)
    expect(h.layout().expanded).toBe(true)
    expect(registry.dispatch({ ...gesture, code: 'Enter' }, context, consume).status).toBe('blocked')
    expect(h.layout().mode).toBe('push')
    const focused = { ...context, target: h.paneElement() }
    registry.dispatch({ ...gesture, code: 'Enter' }, focused, consume)
    expect(h.layout().mode).toBe('fullscreen')
    registry.dispatch({ ...gesture, code: 'Enter' }, { ...focused, modal: 'settings' }, consume)
    expect(h.layout().mode).toBe('push')
    registry.dispatch({ ...gesture, code: 'Enter', composing: true }, focused, consume)
    expect(h.layout().mode).toBe('push')
    registry.dispatch({ ...gesture, code: 'Enter' }, focused, consume)
    expect(h.layout().mode).toBe('fullscreen')
  })

  it('toggles the current Session while a collapsed pane still owns DOM focus', () => {
    const h = harness()
    const registry = new ShortcutRegistry('desktop', 'windows')
    releases.push(registerSidebarShortcuts({ register: command => registry.register(command),
      runtime: registry.runtime }, h.controller, makeTranslate(en), vi.fn()))
    const pane = h.paneElement()
    pane.focus()
    const context = { target: pane, region: 'page' as const, modal: null }
    const gesture = { code: 'KeyB', control: true, meta: false, alt: true, shift: false,
      repeat: false, composing: false, defaultPrevented: false }
    expect(registry.dispatch(gesture, context, vi.fn()).status).toBe('handled')
    expect(h.layout().expanded).toBe(false)
    expect(document.activeElement).toBe(pane)
    expect(registry.dispatch(gesture, context, vi.fn()).status).toBe('handled')
    expect(h.layout().expanded).toBe(true)
  })

  it('refuses commands without a current eligible pane and captured commands after Session replacement', () => {
    const h = harness()
    const commands = new Map<string, ShortcutCommand>()
    releases.push(registerSidebarShortcuts({ runtime: 'desktop', register: (command) => {
      commands.set(command.id, command)
      return () => { commands.delete(command.id) }
    } }, h.controller, makeTranslate(en), vi.fn()))
    const split = commands.get('pane.split')!
    const fullscreen = commands.get('pane.fullscreen.toggle')!
    const toggle = commands.get('sidebar.right.toggle')!
    const pane = h.paneElement()
    pane.focus()
    const context = { target: pane, region: 'page' as const, modal: null }
    h.room.allowed = false
    expect(split.resolve(context)).toMatchObject({ status: 'blocked', reason: en['command.width'] })
    h.room.allowed = true
    const pendingSplit = split.resolve(context)
    const pendingFullscreen = fullscreen.resolve(context)
    const pendingToggle = toggle.resolve(context)
    releases.push(h.bind('missing-session' as SessionId))
    for (const pending of [pendingSplit, pendingFullscreen, pendingToggle]) {
      expect(pending.status).toBe('handled')
      if (pending.status === 'handled') pending.run()
    }
    expect(h.layout().mode).toBe('push')
    expect(h.layout().expanded).toBe(true)
    expect(toggle.resolve(context).status).toBe('blocked')
    releases.push(h.bind())
    const splitNow = split.resolve(context)
    if (splitNow.status === 'handled') splitNow.run()
    expect(h.controller.splitBlock(h.controller.commandTarget(null)!)).toBe('budget')
    h.controller.openTab('files')
    const files = h.controller.active()!.id
    h.controller.float(files)
    const floated = h.tabElement(files)
    floated.focus()
    expect(fullscreen.resolve({ ...context, target: floated })).toMatchObject({ status: 'blocked', reason: en['command.float'] })
  })

  it.each([
    { platform: 'macos', keys: ['Shift+Meta+B', 'Meta+\\', 'Alt+Meta+Enter', 'Alt+Meta+W', undefined] },
    { platform: 'windows', keys: ['Control+Shift+B', 'Control+\\', 'Control+Alt+Enter', 'Control+Alt+W', 'Control+Alt+R'] },
    { platform: 'linux', keys: [undefined, undefined, undefined, undefined, undefined] },
  ] as const)('publishes the Web defaults and unbound commands on $platform', ({ platform, keys }) => {
    const h = harness()
    const registry = new ShortcutRegistry('web', platform)
    releases.push(registerSidebarShortcuts({ register: command => registry.register(command),
      runtime: registry.runtime }, h.controller, makeTranslate(en), vi.fn()))
    expect(registry.catalog.getSnapshot().map(row => row.id)).toEqual([
      'sidebar.right.toggle', 'pane.split', 'pane.fullscreen.toggle', 'page.close', 'page.refresh',
    ])
    expect(registry.catalog.getSnapshot().map(row => row.aria)).toEqual(keys)
  })
})

describe('page close and refresh', () => {
  it.each(['macos', 'windows'] as const)('closes two guide panes without closing the window on %s', (platform) => {
    const h = harness()
    h.controller.split()
    const registry = new ShortcutRegistry('desktop', platform)
    const closeWindow = vi.fn()
    releases.push(registerSidebarShortcuts({ register: command => registry.register(command), runtime: 'desktop' }, h.controller, makeTranslate(en), closeWindow))
    const gesture = { code: 'KeyW', meta: platform === 'macos', control: platform === 'windows', alt: false,
      shift: false, repeat: false, composing: false, defaultPrevented: false }
    const first = Object.values(h.layout().tabs)[0]!
    const element = h.tabElement(first.id)
    registry.dispatch(gesture, { target: element, region: 'page', modal: null }, vi.fn())
    element.remove()
    expect(Object.values(h.layout().tabs)).toHaveLength(1)
    const remaining = Object.values(h.layout().tabs)[0]!
    expect(remaining.kind).toBe('guide')
    registry.dispatch(gesture, { target: h.tabElement(remaining.id), region: 'page', modal: null }, vi.fn())
    expect(closeWindow).not.toHaveBeenCalled()
    expect(h.layout().expanded).toBe(false)
    expect(h.layout().tabs[remaining.id]).toBeDefined()
  })

  it.each(['macos', 'windows'] as const)('refreshes and closes the focused occurrence on %s without closing behind a modal', (platform) => {
    const h = harness()
    const registry = new ShortcutRegistry('desktop', platform)
    const closeWindow = vi.fn()
    releases.push(registerSidebarShortcuts({ register: command => registry.register(command), runtime: 'desktop' }, h.controller, makeTranslate(en), closeWindow))
    h.controller.openTab('files')
    const files = h.controller.active()!.id
    const element = h.tabElement(files)
    const occurrence = h.controller.tabDomain.occurrence(SESSION, { id: files })
    const refresh = vi.fn()
    const release = occurrence.tabActions.bindCommands({ refresh })
    const gesture = { code: 'KeyR', meta: platform === 'macos', control: platform === 'windows', alt: false,
      shift: false, repeat: false, composing: false, defaultPrevented: false }
    const context = { target: element, region: 'page' as const, modal: null }
    const consume = vi.fn()
    registry.dispatch(gesture, context, consume)
    registry.dispatch({ ...gesture, repeat: true }, context, consume)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(consume).toHaveBeenCalledTimes(2)
    release()
    expect(registry.dispatch(gesture, context, consume).status).toBe('blocked')
    expect(registry.dispatch(gesture, { ...context, modal: 'settings' }, consume)).toMatchObject({ status: 'blocked', reason: en['command.noRefresh'] })
    expect(h.layout().tabs[files]).toBeDefined()
    expect(registry.dispatch(gesture, { ...context, region: 'terminal' }, consume).status).toBe('blocked')
    expect(registry.dispatch({ ...gesture, code: 'KeyW' }, { ...context, region: 'terminal', modal: 'settings' }, consume).status).toBe('handled')
    expect(h.layout().tabs[files]).toBeDefined()
    registry.dispatch({ ...gesture, code: 'KeyW' }, { ...context, region: 'terminal' }, consume)
    expect(h.layout().tabs[files]).toBeUndefined()
    expect(occurrence.signal.aborted).toBe(true)
    registry.dispatch({ ...gesture, code: 'KeyW' }, context, consume)
    expect(closeWindow).not.toHaveBeenCalled()
    registry.dispatch({ ...gesture, code: 'KeyW' }, { ...context, target: null }, consume)
    expect(closeWindow).toHaveBeenCalledTimes(1)
  })

  it.each(['macos', 'windows', 'linux'] as const)('routes the close binding and native menu to the foreground modal on %s', (platform) => {
    const h = harness()
    const registry = new ShortcutRegistry('desktop', platform)
    const closeWindow = vi.fn(), closeModal = vi.fn()
    releases.push(registerSidebarShortcuts({ register: command => registry.register(command), runtime: 'desktop' }, h.controller, makeTranslate(en), closeWindow))
    render(createElement(Modal, { open: true, title: 'Settings', shortcutModal: 'settings', closeLabel: 'Close', onClose: closeModal }))
    const context = { target: document.activeElement, region: 'page' as const, modal: 'settings' }
    const gesture = { code: 'KeyW', meta: platform === 'macos', control: platform !== 'macos', alt: false,
      shift: false, repeat: false, composing: false, defaultPrevented: false }
    registry.dispatch({ ...gesture, composing: true }, context, vi.fn())
    registry.dispatch({ ...gesture, repeat: true }, context, vi.fn())
    expect(closeModal).not.toHaveBeenCalled()
    registry.dispatch(gesture, context, vi.fn())
    expect(closeModal).toHaveBeenCalledTimes(1)
    registry.invoke('page.close' as ShortcutCommandId, context)
    expect(closeModal).toHaveBeenCalledTimes(2)
    expect(closeWindow).not.toHaveBeenCalled()
    expect(h.layout().expanded).toBe(true)
  })

  it('preserves a page when cleanup fails and never falls back to closing the window', () => {
    const h = harness()
    h.controller.openTab('terminal')
    const tab = h.controller.active()!.id
    const closeWindow = vi.fn()
    const registry = new ShortcutRegistry('desktop', 'macos')
    releases.push(registerSidebarShortcuts({ register: command => registry.register(command), runtime: 'desktop' }, h.controller, makeTranslate(en), closeWindow))
    const off = h.controller.registerCloseHandler('terminal', () => { throw new Error('cleanup failed') })
    releases.push(off)
    const context = { target: h.tabElement(tab), region: 'page' as const, modal: null }
    expect(() =>{  registry.invoke('page.close' as ShortcutCommandId, context) }).toThrow('cleanup failed')
    expect(h.layout().tabs[tab]).toBeDefined()
    expect(closeWindow).not.toHaveBeenCalled()
    off()
    registry.invoke('page.close' as ShortcutCommandId, context)
    expect(h.layout().tabs[tab]).toBeUndefined()
  })

  it('releases page capabilities on unmount and abort without removing a newer registration', () => {
    const h = harness()
    h.controller.openTab('files')
    const id = h.controller.active()!.id
    const target = h.controller.focusedTarget(h.tabElement(id))!
    const occurrence = target.occurrence!
    const first = occurrence.tabActions.bindCommands({ refresh: vi.fn() })
    const refresh = vi.fn()
    const second = occurrence.tabActions.bindCommands({ refresh })
    first()
    expect(occurrence.commands.refresh).toBe(refresh)
    expect(h.controller.closeTarget(target)).toBe('closed')
    expect(occurrence.commands.refresh).toBeUndefined()
    second()
    occurrence.tabActions.bindCommands({ refresh })()
    expect(occurrence.commands.refresh).toBeUndefined()
    expect(h.controller.closeTarget(target)).toBe('stale')
    h.controller._undo()
    expect(h.controller.closeTarget(target)).toBe('stale')
  })
})
