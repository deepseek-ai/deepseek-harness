// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { AgentPresetSection, type AgentPresetSectionProps } from '../src/client/AgentPresetSection.tsx'
import type { AgentPresetSectionState } from '../src/client/section-store.ts'
import { en } from '../src/client/locales.ts'
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers() })
const translations: ReadonlyMap<string, string> = new Map(Object.entries(en))
function unusedHook(): never {
  throw new Error('This section does not read global slot sources')
}
function view(partial: Partial<AgentPresetSectionState> = {}, startCreatorDraft?: () => void, developerTools = true,
  outerClose?: () => void) {
  const store = createSnapshotStore<AgentPresetSectionState>({ status: 'ready', error: null,
    saving: false, rows: [{ id: 'standard', isDefault: true }, { id: 'mine', name: 'Mine', isDefault: false }],
    view: null, ...partial })
  const actions = { load: vi.fn(async () => {}), view: vi.fn(async () => {}), closeView: vi.fn(), makeDefault: vi.fn(async () => {}),
    close: vi.fn() }
  const props: AgentPresetSectionProps = { ...actions,
    ...(startCreatorDraft === undefined ? {} : { startCreatorDraft }),
    usePanelInfo: unusedHook, useSessions: unusedHook, useSessionStatus: unusedHook, useSessionRetainInfo: unusedHook,
    useWorkspaces: unusedHook, useResource: unusedHook,
    useAgentPresetSection: bindSnapshotSelector(store),
    useDeveloperTools: bindSnapshotSelector(createSnapshotStore(developerTools)),
    t: key => translations.get(key) ?? key }
  render(outerClose === undefined ? <AgentPresetSection {...props} />
    : <Modal open onClose={outerClose} title="Settings" closeLabel="Close"><AgentPresetSection {...props} /></Modal>)
  return { ...actions, store }
}
function rowFor(id: string): HTMLElement {
  const row = document.querySelector<HTMLElement>(`[data-agent-preset-id="${id}"]`)
  if (row === null) throw new Error(`no card for ${id}`)
  return row
}
it('offers no selection switch and disables the card actions while Developer tools are off', () => {
  view({}, undefined, false)

  expect(screen.queryByRole('switch')).toBeNull()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: `${en.enableDevToolsToSetDefault}: Mine` }).disabled).toBe(true)
})
it('reads the roster once and sets a default from the card body', async () => {
  const actions = view()
  fireEvent.click(screen.getByRole('button', { name: `${en.setDefault}: Mine` }))
  expect(actions.makeDefault).toHaveBeenCalledWith('mine')
  await waitFor(() =>{  expect(actions.load).toHaveBeenCalledOnce() })
  expect(screen.queryByRole('button', { name: /^Edit plugins/ })).toBeNull()
})
it('replaces the default preset group tag with its new-task default status', () => {
  view()
  const standard = rowFor('standard')
  expect(within(standard).queryByText(en.builtInGroup)).toBeNull()
  expect(within(standard).getByText(en.inUse)).toBeTruthy()
  expect(within(standard).queryByText(en.setDefault)).toBeNull()
  expect(within(rowFor('mine')).getByText(en.customGroup)).toBeTruthy()
})
it('omits an empty group instead of leaving a heading behind', () => {
  view({ rows: [{ id: 'standard', isDefault: true }] })
  expect(screen.getByRole('heading', { name: en.builtInGroup })).toBeTruthy()
  expect(screen.queryByRole('heading', { name: en.customGroup })).toBeNull()
})
it('keeps the custom group and its Creator entry while the roster has none', () => {
  view({ rows: [{ id: 'cordis', isDefault: true }] }, vi.fn())
  const group = screen.getByRole('heading', { name: en.customGroup }).closest('section')
  expect(group).not.toBeNull()
  expect(within(group!).queryByRole('list')).toBeNull()
  expect(within(group!).getByRole('button', { name: en.creatorDraft })).toBeTruthy()
})
it('launches a Creator-mode task from the entry and closes the settings dialog', () => {
  const launch = vi.fn()
  const actions = view({ rows: [{ id: 'cordis', isDefault: true }] }, launch)
  fireEvent.click(screen.getByRole('button', { name: en.creatorDraft }))
  expect(launch).toHaveBeenCalledOnce()
  expect(actions.close).toHaveBeenCalledOnce()
})
it('offers no Creator entry without the conversation flow or the cordis preset', () => {
  view({ rows: [{ id: 'cordis', isDefault: true }] })
  expect(screen.queryByRole('button', { name: en.creatorDraft })).toBeNull()
  cleanup()
  view({}, vi.fn())
  expect(screen.queryByRole('button', { name: en.creatorDraft })).toBeNull()
})
it('disables the Creator entry while Developer tools are off', () => {
  const launch = vi.fn()
  view({ rows: [{ id: 'cordis', isDefault: true }] }, launch, false)
  const button = screen.getByRole<HTMLButtonElement>('button', { name: en.creatorDraft })
  expect(button.disabled).toBe(true)
  expect(button.title).toBe(en.enableDevToolsToCreate)
  fireEvent.click(button)
  expect(launch).not.toHaveBeenCalled()
})
it('reads a declared composition read-only from every card, broken ones included', () => {
  const actions = view({ rows: [{ id: 'standard', isDefault: true }, { id: 'broken', isDefault: false, broken: 'Missing plugin' }] })
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(within(rowFor('standard')).getByRole('button', { name: `${en.view}: ${en.presetStandardName}` }))
  expect(actions.view).toHaveBeenCalledWith('standard')
  fireEvent.click(within(rowFor('broken')).getByRole('button', { name: `${en.view}: broken` }))
  expect(actions.view).toHaveBeenLastCalledWith('broken')
  expect(actions.makeDefault).not.toHaveBeenCalled()
})
it('shows the open composition under the preset display name, without copy, and closes it from the footer', () => {
  const actions = view({ view: { id: 'standard', title: 'standard', content: '- id: tool-fs\n  name: fs\n' } })
  const dialog = screen.getByRole('dialog', { name: `${en.view} · ${en.presetStandardName}` })
  expect(dialog.querySelector('pre')?.textContent).toBe('- id: tool-fs\n  name: fs\n')
  expect(within(dialog).queryByRole('textbox')).toBeNull()
  expect(dialog.querySelectorAll('p')).toHaveLength(0)
  fireEvent.click(within(dialog).getAllByRole('button', { name: en.close }).at(-1)!)
  expect(actions.closeView).toHaveBeenCalledOnce()
  cleanup()
  view({ view: { id: 'gone', title: 'Gone', content: '[]\n' } })
  expect(screen.getByRole('dialog', { name: `${en.view} · Gone` })).toBeTruthy()
})
it('keeps Escape inside the composition viewer when Settings is also open', () => {
  const closeSettings = vi.fn()
  const actions = view({}, undefined, true, closeSettings)
  const trigger = within(rowFor('standard')).getByRole('button', { name: `${en.view}: ${en.presetStandardName}` })
  trigger.focus()
  fireEvent.click(trigger)
  act(() => { actions.store.set({ ...actions.store.getSnapshot(), view: { id: 'standard', title: 'standard', content: '[]\n' } }) })
  const dialog = screen.getByRole('dialog', { name: `${en.view} · ${en.presetStandardName}` })
  const [header, footer] = within(dialog).getAllByRole('button', { name: en.close })
  expect(document.activeElement).toBe(footer)
  fireEvent.keyDown(footer!, { key: 'Tab' })
  expect(document.activeElement).toBe(header)
  fireEvent.keyDown(header!, { key: 'Tab', shiftKey: true })
  expect(document.activeElement).toBe(footer)
  fireEvent.keyDown(footer!, { key: 'Escape' })
  expect(actions.closeView).toHaveBeenCalledOnce()
  expect(closeSettings).not.toHaveBeenCalled()
  expect(actions.close).not.toHaveBeenCalled()
  expect(document.activeElement).toBe(trigger)
})
it('clears an open viewer when the settings section unmounts', () => {
  const actions = view({ view: { id: 'standard', title: 'standard', content: '[]\n' } })
  cleanup()
  expect(actions.closeView).toHaveBeenCalledOnce()
})
it('shows roster errors without hiding the roster', () => {
  const actions = view({ error: 'Roster stale', rows: [
    { id: 'broken', isDefault: false, broken: 'Missing plugin' },
    { id: 'mine', name: 'Mine', isDefault: false },
  ] })
  expect(screen.getAllByRole('alert').map(node => node.textContent)).toEqual(['Roster stale', 'Missing plugin'])
  fireEvent.click(screen.getByRole('button', { name: `${en.setDefault}: Mine` }))
  expect(actions.makeDefault).toHaveBeenCalledWith('mine')
})
it('keeps a broken card focusable for diagnostics and refuses to select it', () => {
  const actions = view({ rows: [{ id: 'broken', isDefault: false, broken: 'Missing plugin' }] })
  const card = screen.getByRole<HTMLButtonElement>('button', { name: 'Failed to load: broken' })
  expect(card.disabled).toBe(false)
  expect(card.getAttribute('aria-disabled')).toBe('true')
  fireEvent.click(card)
  expect(actions.makeDefault).not.toHaveBeenCalled()
})
it.each([
  ['standard', en.presetStandardName, 'How it works', 'Fix a bug'],
  ['ptc', en.presetPtcName, 'How tools are called', 'Check a set of configuration files'],
  ['minimal', en.presetMinimalName, 'What is included', 'Compare performance on a small bug fix'],
  ['cordis', en.presetCordisName, 'What you can create', 'Add a UI'],
])('opens both help sections for %s without changing the default', (id, name, heading, exampleTitle) => {
  const actions = view({ rows: [{ id, isDefault: false }] })
  const trigger = within(rowFor(id)).getByRole('button', { name: `${en.modeExplanation}: ${name}` })
  trigger.focus()
  fireEvent.click(trigger)
  const dialog = screen.getByRole('dialog', { name })
  expect(within(dialog).getByRole('heading', { name: heading })).toBeTruthy()
  const usage = within(dialog).getByRole('tab', { name: en.howToUse })
  fireEvent.click(usage)
  expect(usage.getAttribute('aria-selected')).toBe('true')
  expect(within(dialog).getByRole('heading', { name: exampleTitle })).toBeTruthy()
  expect(within(dialog).getAllByText(en.guideExampleTask).length).toBeGreaterThan(0)
  fireEvent.click(within(dialog).getByRole('tab', { name: en.modeExplanation }))
  expect(within(dialog).getByRole('heading', { name: heading })).toBeTruthy()
  fireEvent.click(within(dialog).getByRole('button', { name: en.close }))
  expect(document.activeElement).toBe(trigger)
  fireEvent.click(within(rowFor(id)).getByRole('button', { name: `${en.howToUse}: ${name}` }))
  expect(within(screen.getByRole('dialog')).getByRole('tab', { name: en.howToUse }).getAttribute('aria-selected')).toBe('true')
  expect(actions.makeDefault).not.toHaveBeenCalled()
})
it('keeps keyboard focus in help and dismisses only the reader on Escape', () => {
  const closeSettings = vi.fn()
  const actions = view({}, undefined, true, closeSettings)
  const trigger = within(rowFor('standard')).getByRole('button', { name: `${en.modeExplanation}: ${en.presetStandardName}` })
  trigger.focus()
  fireEvent.click(trigger)
  const dialog = screen.getByRole('dialog', { name: en.presetStandardName })
  const details = within(dialog).getByRole('tab', { name: en.modeExplanation })
  const panel = within(dialog).getByRole('tabpanel', { name: en.modeExplanation })
  const close = within(dialog).getByRole('button', { name: en.close })
  expect(document.activeElement).toBe(details)
  expect(fireEvent.keyDown(details, { key: 'Tab' })).toBe(true)
  panel.focus()
  fireEvent.keyDown(panel, { key: 'Tab' })
  expect(document.activeElement).toBe(close)
  fireEvent.keyDown(close, { key: 'Tab', shiftKey: true })
  expect(document.activeElement).toBe(panel)
  fireEvent.keyDown(panel, { key: 'Escape' })
  expect(screen.queryByRole('dialog', { name: en.presetStandardName })).toBeNull()
  expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy()
  expect(document.activeElement).toBe(trigger)
  expect(closeSettings).not.toHaveBeenCalled()
  expect(actions.close).not.toHaveBeenCalled()
})
it('connects keyboard selection to the visible guide panel', () => {
  view()
  fireEvent.click(within(rowFor('standard')).getByRole('button', { name: `${en.modeExplanation}: ${en.presetStandardName}` }))
  const dialog = screen.getByRole('dialog')
  const details = within(dialog).getByRole('tab', { name: en.modeExplanation })
  const usage = within(dialog).getByRole('tab', { name: en.howToUse })
  expect(details.tabIndex).toBe(0)
  expect(usage.tabIndex).toBe(-1)
  fireEvent.keyDown(details, { key: 'ArrowRight' })
  const panel = within(dialog).getByRole('tabpanel', { name: en.howToUse })
  expect(panel.id).toBe(usage.getAttribute('aria-controls'))
  expect(document.activeElement).toBe(usage)
  expect(usage.getAttribute('aria-selected')).toBe('true')
  expect(details.tabIndex).toBe(-1)
  expect(usage.tabIndex).toBe(0)
  expect(within(dialog).queryByRole('tabpanel', { name: en.modeExplanation })).toBeNull()
})
it('does not attach built-in claims to named or unknown presets', () => {
  view({ rows: [{ id: 'ptc', name: 'My PTC', isDefault: false }, { id: 'third-party', isDefault: false }] })
  expect(screen.queryByRole('button', { name: new RegExp(en.modeExplanation) })).toBeNull()
  expect(screen.queryByRole('button', { name: new RegExp(en.howToUse) })).toBeNull()
})
it('leaves help usable while Developer tools are off', () => {
  const actions = view({}, undefined, false)
  fireEvent.click(within(rowFor('standard')).getByRole('button', { name: `${en.howToUse}: ${en.presetStandardName}` }))
  expect(screen.getByRole('dialog', { name: en.presetStandardName })).toBeTruthy()
  expect(actions.makeDefault).not.toHaveBeenCalled()
})
it('closes help even when the browser reports no previously focused element', () => {
  const descriptor: TypedPropertyDescriptor<Element | null> = Object.getOwnPropertyDescriptor(Document.prototype, 'activeElement')!
  const readActiveElement = descriptor.get!.bind(document)
  // Only the initial unfocused body is absent; modal controls must observe subsequent focus.
  const activeElement = vi.spyOn(document, 'activeElement', 'get').mockImplementation(() => {
    const focused = readActiveElement()
    return focused === document.body ? null : focused
  })
  try {
    view()
    fireEvent.click(within(rowFor('standard')).getByRole('button', { name: `${en.modeExplanation}: ${en.presetStandardName}` }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: en.close }))
    expect(screen.queryByRole('dialog')).toBeNull()
  } finally {
    activeElement.mockRestore()
  }
})
it.each([false, true])('only offers a description tooltip when the card clips it: %s', (overflow) => {
  vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(overflow ? 400 : 80)
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(80)
  const disconnect = vi.spyOn(ResizeObserver.prototype, 'disconnect')
  vi.useFakeTimers()
  view({ rows: [{ id: 'mine', isDefault: false, description: 'Preset description' }] })
  fireEvent.mouseEnter(screen.getByText('Preset description'))
  act(() => { vi.advanceTimersByTime(400) })
  expect(screen.queryByRole('tooltip')?.textContent ?? null).toBe(overflow ? 'Preset description' : null)
  cleanup()
  expect(disconnect).toHaveBeenCalledTimes(overflow ? 2 : 1)
})
it('renders descriptions and allows selection without resize observation', () => {
  vi.stubGlobal('ResizeObserver', undefined)
  const actions = view({ rows: [{ id: 'mine', name: 'Mine', isDefault: false, description: 'Preset description' }] })
  expect(screen.getByText('Preset description')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: `${en.setDefault}: Mine` }))
  expect(actions.makeDefault).toHaveBeenCalledWith('mine')
})
