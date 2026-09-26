// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ShortcutCatalogEntry, ShortcutCommandId, ShortcutFixedCatalogEntry } from '@deepseek-ai/dsh-client-shortcuts/client'
import { ShortcutReference, ShortcutsRow } from '../src/client/Reference.tsx'
import { createShortcutsStore } from '../src/client/store.ts'
import { en, zh } from '../src/client/locales.ts'
import { initialShortcutConfig, bindingIssue, normalizeBinding, presentBinding } from '@deepseek-ai/dsh-client-shortcuts/protocol'
import type { ShortcutConfigSnapshot } from '@deepseek-ai/dsh-client-shortcuts/protocol'
import { ShortcutRegistry } from '../../shortcuts/src/client/registry.ts'
import { apply as hostApply } from '../src/index.ts'
import { fixedCommands } from '../src/client/fixed.ts'

const describeBinding: Parameters<typeof ShortcutReference>[0]['describeBinding'] = (binding) => {
  const normalized = binding === null ? null : normalizeBinding(binding, 'macos')
  return { binding: normalized, keys: presentBinding(normalized, 'macos').keys,
    issue: normalized === null ? null : bindingIssue(normalized, 'web', 'macos'), conflicts: [] }
}
afterEach(cleanup)
it('ignores reset completion after the reference unmounts', async () => {
  const f = referenceFixture()
  act(() => { f.config.set({ ...f.config.getSnapshot(), document: {
    schemaVersion: 1, profiles: { 'web:macos': { 'settings.open': null } },
  } }) })
  const pending = Promise.withResolvers<Awaited<ReturnType<typeof f.edit>>>()
  f.edit.mockReturnValueOnce(pending.promise)
  fireEvent.click(screen.getByRole('button', { name: en['reset-all'] }))
  fireEvent.click(within(screen.getByRole('dialog', { name: en['reset-title'] })).getByRole('button', { name: en.reset }))
  expect(f.edit).toHaveBeenCalledOnce()
  f.view.unmount()
  await act(async () => { pending.resolve({ status: 'saved', snapshot: f.config.getSnapshot() }); await pending.promise })
  expect(screen.queryByRole('alert')).toBeNull()
})

it('keeps a reference open while a clear operation is pending', async () => {
  const f = referenceFixture()
  const pending = Promise.withResolvers<Awaited<ReturnType<typeof f.edit>>>()
  f.edit.mockReturnValueOnce(pending.promise)
  fireEvent.click(screen.getByRole('button', { name: 'Edit shortcut for Open settings' }))
  fireEvent.click(screen.getByRole('button', { name: en.clear }))
  fireEvent.click(screen.getByRole('button', { name: en.close }))
  fireEvent.pointerDown(screen.getByRole('heading', { name: en.title }))
  fireEvent.click(screen.getByRole('dialog').previousElementSibling!)
  expect(screen.getByRole('group', { name: 'Open settings' })).toBeTruthy()
  expect(f.store.getSnapshot().open).toBe(true)
  await act(async () => { pending.resolve({ status: 'saved', snapshot: f.config.getSnapshot() }); await pending.promise })
  expect(screen.getByRole('alert').textContent).toBe(en.saved)
})
it.each(['macos', 'windows'] as const)('shows the reference, filters labels and keys, and clears its query on close (%s)', (platform) => {
  hostApply()
  const store = createShortcutsStore().create()
  const catalog = createSnapshotStore<readonly ShortcutCatalogEntry[]>([
    { id: 'shortcuts.open' as ShortcutCommandId, label: 'Open shortcuts', aliases: ['shortcuts'], binding: { code: 'Slash', modifiers: [platform === 'macos' ? 'meta' : 'control'] }, modified: false, conflicts: [], issue: null,
      keys: platform === 'macos' ? ['⌘', '/'] : ['Ctrl', '+', '/'], aria: platform === 'macos' ? 'Meta+/' : 'Control+/' },
    { id: 'settings.open' as ShortcutCommandId, label: 'Open settings', aliases: ['preferences'], binding: null, modified: false, conflicts: [], issue: null, keys: [], aria: undefined },
    { id: 'sidebar.left.toggle' as ShortcutCommandId, label: 'Toggle left sidebar', aliases: ['sidebar', 'toggle left sidebar'],
      binding: { code: 'KeyB', modifiers: [platform === 'macos' ? 'meta' : 'control'] }, modified: false, conflicts: [], issue: null,
      keys: platform === 'macos' ? ['⌘', 'B'] : ['Ctrl', '+', 'B'], aria: platform === 'macos' ? 'Meta+B' : 'Control+B' },
  ])
  const config = createSnapshotStore({ ...initialShortcutConfig(), status: 'ready' as const })
  const describe: typeof describeBinding = (binding) => {
    const normalized = binding === null ? null : normalizeBinding(binding, platform)
    return { ...describeBinding(binding), keys: presentBinding(normalized, platform).keys }
  }
  const registry = new ShortcutRegistry('web', platform)
  for (const command of fixedCommands(makeTranslate(en))) registry.registerFixed(command)
  registry.registerFixed({ id: 'composer.alternate' as ShortcutCommandId, label: () => 'Alternate delivery',
    keys: describe({ code: 'Enter', modifiers: ['primary'] }).keys,
    bindings: [{ code: 'Enter', modifiers: ['primary'] }], group: 'input' })
  const props = { actions: store.actions, useStore: bindSnapshotSelector(store), useCatalog: bindSnapshotSelector(catalog),
    useConfig: bindSnapshotSelector(config), useFixedCatalog: bindSnapshotSelector(registry.fixedCatalog), runtime: 'web', edit: async () => ({ status: 'saved', snapshot: config.getSnapshot() }), recording: async () => {},
    describeBinding: describe, platform, t: makeTranslate(en) } as Parameters<typeof ShortcutReference>[0]
  render(<><ShortcutsRow {...props} /><ShortcutReference {...props} /></>)
  expect(screen.queryByRole('dialog')).toBeNull()
  const opener = screen.getByRole('button', { name: en.view }); opener.focus(); fireEvent.click(opener)
  expect(opener.getAttribute('aria-keyshortcuts')).toBe(platform === 'macos' ? 'Meta+/' : 'Control+/')
  const search = screen.getByRole('searchbox')
  expect(document.activeElement).toBe(search)
  expect(screen.getByText('No shortcut')).toBeTruthy()
  fireEvent.change(search, { target: { value: 'preferences' } })
  expect(screen.getAllByRole('listitem')).toHaveLength(1)
  fireEvent.change(search, { target: { value: platform === 'macos' ? 'cmd+/' : 'control+/' } })
  expect(screen.getAllByRole('listitem')).toHaveLength(1)
  for (const query of ['sidebar', ' sDBr ', 'toggle left', platform === 'macos' ? '⌘B' : 'CtrlB', platform === 'macos' ? 'Cmd+B' : 'Control+B']) {
    fireEvent.change(search, { target: { value: query } })
    expect(screen.getAllByRole('listitem').map(row => row.textContent)).toEqual(['Toggle left sidebar' + (platform === 'macos' ? '⌘B' : 'Ctrl+B')])
  }
  fireEvent.change(search, { target: { value: 's' } })
  expect(screen.getAllByRole('button', { name: /^Edit shortcut for/ }).map(button => button.getAttribute('aria-label')))
    .toEqual(['Edit shortcut for Open shortcuts', 'Edit shortcut for Toggle left sidebar', 'Edit shortcut for Open settings'])
  fireEvent.change(search, { target: { value: platform === 'macos' ? '⌘ Enter' : 'Ctrl + Enter' } })
  expect(screen.getAllByRole('listitem')).toHaveLength(1)
  expect(screen.getByText('Alternate delivery')).toBeTruthy()
  for (const query of ['abc', 'sendEnter', 'not a command']) {
    fireEvent.change(search, { target: { value: query } })
    expect(screen.queryAllByRole('listitem')).toHaveLength(0)
    expect(screen.getByRole('status').textContent).toBe('No matching shortcuts')
  }
  act(() => { store.actions.open() })
  expect(screen.getAllByRole('dialog')).toHaveLength(1)
  fireEvent.keyDown(search, { key: 'Escape' })
  expect(store.getSnapshot().query).toBe('')
  expect(document.activeElement).toBe(opener)
  fireEvent.mouseEnter(opener)
  expect(screen.getByRole('tooltip').getAttribute('aria-label')).toBe(`${en['global-hint']} ${platform === 'macos' ? '⌘ /' : 'Ctrl + /'}`)
  act(() => { catalog.set(catalog.getSnapshot().map(row => row.id === 'shortcuts.open'
    ? { ...row, binding: null, keys: [], aria: undefined } : row)) })
  expect(screen.queryByRole('tooltip')).toBeNull()
  fireEvent.mouseLeave(opener); fireEvent.mouseEnter(opener)
  expect(screen.queryByRole('tooltip')).toBeNull()
  act(() => { catalog.set([]) })
  expect(opener.hasAttribute('aria-keyshortcuts')).toBe(false)
  expect(makeTranslate(zh)('title')).toBe('快捷键')
})


it('saves individual edits and disables changes when configuration cannot be read', async () => {
  const store = createShortcutsStore().create()
  const catalog = createSnapshotStore<readonly ShortcutCatalogEntry[]>([
    { id: 'shortcuts.open' as ShortcutCommandId, label: 'Open shortcuts', aliases: [], binding: null, modified: true,
      conflicts: ['other.action' as ShortcutCommandId], issue: null, keys: [], aria: undefined },
    { id: 'settings.open' as ShortcutCommandId, label: 'Open settings', aliases: [], binding: null, modified: true,
      conflicts: [], issue: 'reserved', keys: [], aria: undefined },
  ])
  const config = createSnapshotStore<ShortcutConfigSnapshot>(initialShortcutConfig())
  const edit = vi.fn(async () => ({ status: 'saved' as const, snapshot: config.getSnapshot() }))
  const props = { actions: store.actions, useStore: bindSnapshotSelector(store), useCatalog: bindSnapshotSelector(catalog),
    useConfig: bindSnapshotSelector(config), useFixedCatalog: bindSnapshotSelector(createSnapshotStore([])), runtime: 'web', platform: 'macos', edit, recording: async () => {},
    describeBinding, t: makeTranslate(en) } as Parameters<typeof ShortcutReference>[0]
  store.actions.open()
  render(<ShortcutReference {...props} />)
  expect(screen.getByRole('button', { name: en['reset-all'] }).hasAttribute('disabled')).toBe(true)
  expect(screen.queryByText('Unavailable')).toBeNull()
  expect(screen.getByRole('button', { name: 'Edit shortcut for Open shortcuts' }).hasAttribute('disabled')).toBe(true)
  act(() => { config.set({ ...config.getSnapshot(), status: 'ready' }) })
  fireEvent.click(screen.getByRole('button', { name: 'Edit shortcut for Open shortcuts' }))
  expect(screen.getAllByRole('dialog')).toHaveLength(1)
  expect(screen.getByRole('group', { name: 'Open shortcuts' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: en.clear })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: en.reset }))
  await screen.findByText(en.saved)
  expect(screen.getAllByRole('dialog')).toHaveLength(1)
  act(() => { config.set({ ...config.getSnapshot(), status: 'unreadable', error: null }) })
  expect(screen.getByRole('alert').textContent).toContain('this site’s localStorage entry dsh.keybindings.v1')
  expect(screen.getByRole('alert').textContent).toContain('Check access permissions, then reload the page.')
  expect(screen.getByRole('alert').textContent).toContain(en['using-defaults'])
  act(() => { config.set({ ...config.getSnapshot(), error: 'future', usingDefaults: false }) })
  expect(screen.getByRole('alert').textContent).toContain('Upgrade Harness and try again.')
  expect(screen.getByRole('alert').textContent).toContain(en['using-accepted'])
  expect(screen.getByRole('dialog').contains(screen.getByRole('alert'))).toBe(false)
  expect(screen.getByRole('button', { name: en['reset-all'] }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole('button', { name: 'Edit shortcut for Open shortcuts' }).hasAttribute('disabled')).toBe(true)
})

function referenceFixture({ runtime = 'web', dictionary = en }: { runtime?: 'web' | 'desktop'; dictionary?: typeof en } = {}) {
  const store = createShortcutsStore().create()
  const catalog = createSnapshotStore<readonly ShortcutCatalogEntry[]>([
    { id: 'settings.open' as ShortcutCommandId, label: 'Open settings', aliases: [],
      binding: { code: 'Comma', modifiers: ['shift', 'meta'] }, modified: false,
      conflicts: [], issue: null, keys: ['⇧', '⌘', ','], aria: 'Shift+Meta+,' },
  ])
  const config = createSnapshotStore<ShortcutConfigSnapshot>({ ...initialShortcutConfig(), status: 'ready' })
  const fixedCatalog = createSnapshotStore<readonly ShortcutFixedCatalogEntry[]>([])
  const edit = vi.fn<Parameters<typeof ShortcutReference>[0]['edit']>(async () => ({ status: 'saved', snapshot: config.getSnapshot() }))
  store.actions.open()
  const props = { actions: store.actions, useStore: bindSnapshotSelector(store), useCatalog: bindSnapshotSelector(catalog),
    useConfig: bindSnapshotSelector(config), useFixedCatalog: bindSnapshotSelector(fixedCatalog), runtime, platform: 'macos', edit,
    recording: async () => {}, describeBinding, t: makeTranslate(dictionary) } as Parameters<typeof ShortcutReference>[0]
  const view = render(<ShortcutReference {...props} />)
  return { store, catalog, fixedCatalog, config, edit, view }
}

it('keeps core actions in product order across registration, remount and label changes', () => {
  const { catalog, fixedCatalog, store } = referenceFixture()
  const template = catalog.getSnapshot()[0]!
  const core = [
    ['shortcuts.open', 'Keyboard shortcuts'], ['session.new', 'New session'],
    ['sidebar.left.toggle', 'Toggle left sidebar'], ['session.search', 'Search sessions'],
    ['workspace.add', 'Add workspace'], ['session.rename', 'Rename session'],
    ['session.fork', 'Fork session'], ['session.archive', 'Archive session'],
    ['settings.open', 'Open settings'], ['workspace.openLocal', 'Open workspace locally'],
    ['sidebar.right.toggle', 'Toggle right sidebar'], ['workspace.files', 'Workspace files'],
    ['browser.new', 'Browser'], ['terminal.new', 'New terminal'], ['pane.split', 'Split pane'],
    ['pane.fullscreen.toggle', 'Toggle fullscreen'], ['page.refresh', 'Refresh page'], ['page.close', 'Close page'],
  ] as const
  const commands = core.map(([id, label]) => ({ ...template, id: id as ShortcutCommandId, label }))
  const extensions = ([['extension.alpha', 'Zulu extension'], ['extension.zulu', 'Alpha extension']] as const).map(([id, label]) => ({
    ...template, id: id as ShortcutCommandId, label,
  }))
  const stop: ShortcutFixedCatalogEntry = { id: 'response.stop' as ShortcutCommandId, label: 'Stop reply',
    keys: ['Esc', 'Esc'], bindings: [{ code: 'Escape', modifiers: [] }], group: 'input' }
  const fixed: ShortcutFixedCatalogEntry[] = [
    { ...stop, id: 'fixed.send' as ShortcutCommandId, label: 'Send', keys: ['Enter'], bindings: [{ code: 'Enter', modifiers: [] }], group: 'input' },
    { ...stop, id: 'fixed.newline' as ShortcutCommandId, label: 'Newline', keys: ['Shift', 'Enter'], bindings: [{ code: 'Enter', modifiers: ['shift'] }], group: 'input' },
    { ...stop, id: 'fixed.select' as ShortcutCommandId, label: 'Select', keys: ['Enter'], bindings: [{ code: 'Enter', modifiers: [] }], group: 'menus' },
    { ...stop, id: 'fixed.dismiss' as ShortcutCommandId, label: 'Dismiss', group: 'menus' },
    { ...stop, id: 'approval.accept' as ShortcutCommandId, label: 'Approve', keys: ['Enter'], bindings: [{ code: 'Enter', modifiers: [] }], group: 'approval' },
    stop,
  ]
  const labels = (group: string) => within(screen.getByRole('region', { name: group })).getAllByRole('listitem')
    .map(row => row.querySelector(':scope > span')?.textContent)
  const expected = [...core.map(([, label]) => label), 'Zulu extension', 'Alpha extension']
  for (const reversed of [true, false]) {
    act(() => {
      catalog.set(reversed ? [...extensions, ...commands].reverse() : [...extensions, ...commands])
      fixedCatalog.set(reversed ? [...fixed].reverse() : fixed)
    })
    expect(labels(en.application)).toEqual(expected)
    expect(labels(en.input)).toEqual(['Newline', 'Send', 'Stop reply'])
    expect(labels(en.menus)).toEqual(['Dismiss', 'Select'])
    expect(labels(en.approval)).toEqual(['Approve'])
  }
  const stopRow = screen.getByText('Stop reply').closest('li')!
  expect(within(stopRow).queryByRole('button')).toBeNull()
  fireEvent.click(stopRow)
  expect(screen.queryByRole('button', { name: 'Edit shortcut for Stop reply' })).toBeNull()
  expect(screen.queryByRole('group', { name: 'Stop reply' })).toBeNull()
  act(() => { catalog.set(extensions); fixedCatalog.set(fixed.filter(row => row.id !== stop.id)) })
  expect(labels(en.application)).toEqual(['Zulu extension', 'Alpha extension'])
  act(() => { catalog.set([...extensions, ...[...commands].reverse()]); fixedCatalog.set(fixed) })
  expect(labels(en.application)).toEqual(expected)
  act(() => {
    catalog.set([...commands, ...extensions].map(row => ({ ...row, label: `操作：${row.label}` })))
    fixedCatalog.set(fixed.map(row => ({ ...row, label: `操作：${row.label}` })))
    store.actions.search('操作')
  })
  expect(labels(en.application)).toEqual(expected.map(label => `操作：${label}`))
  expect(labels(en.input)).toEqual(['操作：Newline', '操作：Send', '操作：Stop reply'])
})

it('keeps product order for tied searches while prioritizing stronger matches', () => {
  const { catalog, store } = referenceFixture()
  const template = catalog.getSnapshot()[0]!
  const first = { ...template, id: 'shortcuts.open' as ShortcutCommandId, label: 'Zulu', aliases: ['action', 's-e-a-r-c-h'] }
  const second = { ...template, id: 'session.new' as ShortcutCommandId, label: 'Alpha', aliases: ['action', 's-e-a-r-c-h'] }
  const extension = { ...template, id: 'extension.alpha' as ShortcutCommandId, label: 'Extension', aliases: ['action', 'search'] }
  const labels = () => screen.getAllByRole('button', { name: /^Edit shortcut for/ })
    .map(button => button.getAttribute('aria-label')?.replace('Edit shortcut for ', ''))
  act(() => { catalog.set([extension, second, first]); store.actions.search('action') })
  expect(labels()).toEqual(['Zulu', 'Alpha', 'Extension'])
  act(() => { store.actions.search('search') })
  expect(labels()).toEqual(['Extension', 'Zulu', 'Alpha'])
  act(() => { store.actions.search('') })
  expect(labels()).toEqual(['Zulu', 'Alpha', 'Extension'])
})

it.each((['web', 'desktop'] as const).flatMap(runtime => (['invalid', 'future'] as const)
  .flatMap(error => [{ runtime, error, dictionary: en }, { runtime, error, dictionary: zh }])))
('identifies the $runtime document and preserves $error data in the selected locale', ({ runtime, error, dictionary }) => {
  const f = referenceFixture({ runtime, dictionary })
  act(() => { f.config.set({ ...f.config.getSnapshot(), status: 'unreadable', error, usingDefaults: false,
    document: { schemaVersion: 1, profiles: { [`${runtime}:macos`]: { 'settings.open': null } } } }) })
  const text = screen.getByRole('alert').textContent
  expect(text).toContain(runtime === 'web' ? 'dsh.keybindings.v1' : 'userData/keybindings.json')
  expect(text).toContain(error === 'future'
    ? dictionary === en ? 'Upgrade Harness' : '升级 Harness'
    : dictionary === en ? 'Back up and repair' : '先备份并修复')
  expect(text).toContain(dictionary['using-accepted'])
  const reset = screen.getByRole('button', { name: dictionary['reset-all'] })
  expect(reset.hasAttribute('disabled')).toBe(true)
  fireEvent.click(reset)
  expect(screen.queryByRole('dialog', { name: dictionary['reset-title'] })).toBeNull()
  expect(f.edit).not.toHaveBeenCalled()
})

it('shows mounted fixed actions as searchable read-only rows and follows their label and lifetime', () => {
  const { fixedCatalog, store } = referenceFixture()
  const send = { id: 'fixed.send' as ShortcutCommandId, label: 'Send from catalog', keys: ['Enter'], bindings: [{ code: 'Enter', modifiers: [] }], group: 'input' as const }
  const stop = { id: 'response.stop' as ShortcutCommandId, label: 'Stop reply', keys: ['Esc', 'Esc'], bindings: [{ code: 'Escape', modifiers: [] }], group: 'application' as const }
  const approve = { id: 'approval.accept' as ShortcutCommandId, label: 'Approve', keys: ['Enter'], bindings: [{ code: 'Enter', modifiers: [] }], group: 'approval' as const }
  expect(screen.queryByText(send.label)).toBeNull()
  act(() => { fixedCatalog.set([send, stop, approve]) })
  expect(within(screen.getByText(send.label).closest('li')!).queryByRole('button')).toBeNull()
  expect(screen.getByRole('region', { name: 'Approval area' }).textContent).toContain('Approve')
  expect(within(screen.getByText(stop.label).closest('li')!).queryByRole('button')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Edit shortcut for Stop reply' })).toBeNull()
  act(() => { store.actions.search('response.stop') })
  expect(screen.getAllByRole('listitem')).toHaveLength(1)
  act(() => { fixedCatalog.set([{ ...stop, label: '停止回复' }]) })
  expect(screen.queryByText('Stop reply')).toBeNull()
  expect(screen.getByText('停止回复')).toBeTruthy()
  act(() => { fixedCatalog.set([]) })
  expect(screen.queryAllByRole('listitem')).toHaveLength(0)
})

it('keeps command labels free of tooltips while retaining binding edits', () => {
  referenceFixture()
  const label = screen.getByText('Open settings', { selector: 'span' })
  expect(label.textContent).toBe('Open settings')
  expect(screen.queryByText('Unavailable')).toBeNull()
  fireEvent.mouseEnter(label)
  expect(screen.queryByRole('tooltip')).toBeNull()
  fireEvent.mouseLeave(label)
  fireEvent.focus(label)
  expect(screen.queryByRole('tooltip')).toBeNull()
  expect(label.hasAttribute('tabindex')).toBe(false)
  expect(screen.getByRole('button', { name: 'Edit shortcut for Open settings' }).hasAttribute('disabled')).toBe(false)
})

it.each(['conflict', 'reserved'] as const)('omits status labels for a %s binding', (failure) => {
  const f = referenceFixture()
  act(() => { f.catalog.set(f.catalog.getSnapshot().map(row => ({ ...row,
    conflicts: failure === 'conflict' ? ['pane.split' as ShortcutCommandId] : [],
    issue: failure === 'reserved' ? 'reserved' : null,
  }))) })
  expect(screen.queryByText('Unavailable')).toBeNull()
  expect(screen.getByRole('button', { name: 'Edit shortcut for Open settings' }).hasAttribute('disabled')).toBe(false)
})

it('removes from the inline editor and replaces failure feedback with a fresh system success toast', async () => {
  vi.useFakeTimers()
  try {
    const f = referenceFixture()
    f.edit.mockResolvedValueOnce({ status: 'write-failed', snapshot: f.config.getSnapshot() })
    fireEvent.click(screen.getByRole('button', { name: 'Edit shortcut for Open settings' }))
    const remove = screen.getByRole('button', { name: en.clear })
    await act(async () => { remove.click() })
    expect(screen.getByRole('alert').textContent).toBe(en['write-failed'])
    expect(screen.getByRole('dialog').contains(screen.getByRole('alert'))).toBe(false)
    act(() => { vi.advanceTimersByTime(2000) })
    await act(async () => { remove.click() })
    expect(f.edit).toHaveBeenLastCalledWith({ type: 'set', id: 'settings.open', binding: null }, f.config.getSnapshot().revision)
    expect(screen.getByRole('alert').textContent).toBe(en.saved)
    act(() => { vi.advanceTimersByTime(2000) })
    expect(screen.getByRole('alert').textContent).toBe(en.saved)
    act(() => { vi.advanceTimersByTime(2000) })
    expect(screen.queryByRole('alert')).toBeNull()
  } finally { vi.useRealTimers() }
})

it('opens the recorder from the application row and retains the editor when restoring defaults fails', async () => {
  const f = referenceFixture()
  f.edit.mockResolvedValueOnce({ status: 'write-failed', snapshot: f.config.getSnapshot() })
  fireEvent.click(screen.getByRole('button', { name: 'Edit shortcut for Open settings' }))
  await act(async () => { screen.getByRole('button', { name: en.reset }).click() })
  expect(f.edit).toHaveBeenLastCalledWith({ type: 'reset', id: 'settings.open' }, f.config.getSnapshot().revision)
  expect(screen.getByRole('alert').textContent).toBe(en['write-failed'])
  expect(screen.getByRole('group', { name: 'Open settings' })).toBeTruthy()
})

it('coalesces repeated recording errors without extending the toast and immediately shows changed feedback', async () => {
  vi.useFakeTimers()
  try {
    const f = referenceFixture()
    fireEvent.click(screen.getByRole('button', { name: 'Edit shortcut for Open settings' }))
    const recorder = screen.getByRole('button', { name: en.record }); recorder.focus()
    const press = (key: string, code: string, modifiers: KeyboardEventInit = {}): void => {
      fireEvent.keyDown(recorder, { key, code, ...modifiers })
      fireEvent.keyUp(recorder, { key, code, ...modifiers })
    }
    press('z', 'KeyZ')
    const firstError = screen.getByRole('alert')
    expect(firstError.textContent).toBe(en['modifier-required'])
    for (const key of 'hongwen') {
      act(() => { vi.advanceTimersByTime(500) })
      press(key, `Key${key.toUpperCase()}`)
      expect(screen.getByRole('alert')).toBe(firstError)
      expect(recorder.getAttribute('aria-invalid')).toBe('true')
    }
    act(() => { vi.advanceTimersByTime(500) })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(f.edit).not.toHaveBeenCalled()
    press('i', 'KeyI')
    const nextError = screen.getByRole('alert')
    expect(nextError.textContent).toBe(en['modifier-required'])
    expect(nextError).not.toBe(firstError)
    press('r', 'KeyR', { metaKey: true })
    expect(screen.getByRole('alert').textContent).toBe(en['unsupported-browser'])
    await act(async () => { press('.', 'Period', { metaKey: true, shiftKey: true }) })
    expect(screen.getByRole('alert').textContent).toBe(en.saved)
    expect(f.edit).toHaveBeenCalledOnce()
    expect(screen.queryByRole('group')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('dialog'))
  } finally { cleanup(); vi.useRealTimers() }
})

it('keeps failed edits open and returns cancelled edits to the dialog', () => {
  referenceFixture()
  fireEvent.click(screen.getByRole('button', { name: 'Edit shortcut for Open settings' }))
  const recorder = screen.getByRole('button', { name: en.record }); recorder.focus()
  fireEvent.keyDown(recorder, { key: 'r', code: 'KeyR', metaKey: true })
  fireEvent.keyUp(recorder, { code: 'KeyR' })
  expect(screen.getByRole('alert').textContent).toBe(en['unsupported-browser'])
  expect(recorder.getAttribute('aria-invalid')).toBe('true')
  fireEvent.click(screen.getByRole('button', { name: en.close }))
  expect(screen.queryByRole('group')).toBeNull()
  expect(screen.getByRole('dialog')).toBeTruthy()
  expect(document.activeElement).toBe(screen.getByRole('dialog'))
})

it('blocks reference dismissal during a removal and ignores its completion after unmount', async () => {
  const f = referenceFixture()
  let settle!: (value: Awaited<ReturnType<typeof f.edit>>) => void
  const reply = new Promise<Awaited<ReturnType<typeof f.edit>>>((resolve) => { settle = resolve })
  f.edit.mockReturnValueOnce(reply)
  fireEvent.click(screen.getByRole('button', { name: 'Edit shortcut for Open settings' }))
  fireEvent.click(screen.getByRole('button', { name: en.clear }))
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
  expect(f.store.getSnapshot().open).toBe(true)
  f.view.unmount()
  await act(async () => { settle({ status: 'saved', snapshot: f.config.getSnapshot() }); await reply })
  expect(screen.queryByRole('alert')).toBeNull()
})

it('counts current-profile overrides even when hidden by search or an unloaded command, and cancels without saving', () => {
  const f = referenceFixture()
  const restore = screen.getByRole('button', { name: en['reset-all'] })
  expect(restore.hasAttribute('disabled')).toBe(true)
  act(() => { f.config.set({ ...f.config.getSnapshot(), document: { schemaVersion: 2, profiles: {
    'desktop:macos': { 'settings.open': null },
  } } }) })
  expect(restore.hasAttribute('disabled')).toBe(true)
  act(() => {
    f.config.set({ ...f.config.getSnapshot(), document: { schemaVersion: 2, profiles: {
      'web:macos': { 'settings.open': null, 'unloaded.command': { code: 'KeyI', modifiers: ['meta', 'alt'] } },
      'web:windows': { 'settings.open': null },
    } } })
    f.store.actions.search('no matching command')
  })
  expect(screen.getByText('2 customized')).toBeTruthy()
  expect(screen.queryAllByRole('listitem')).toHaveLength(0)
  restore.focus(); fireEvent.click(restore)
  const confirmation = screen.getByRole('dialog', { name: en['reset-title'] })
  expect(confirmation.textContent).toContain(en['reset-description'])
  const cancel = within(confirmation).getByRole('button', { name: en.cancel })
  expect(document.activeElement).toBe(cancel)
  act(() => { f.store.actions.open() })
  expect(document.activeElement).toBe(cancel)
  fireEvent.click(cancel)
  expect(screen.queryByRole('dialog', { name: en['reset-title'] })).toBeNull()
  expect(document.activeElement).toBe(restore)
  expect(f.edit).not.toHaveBeenCalled()
  fireEvent.click(restore)
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
  expect(screen.getAllByRole('dialog')).toHaveLength(1)
  expect(f.store.getSnapshot().open).toBe(true)
})

it('restores focus to Reset All when clicking it does not move focus out of the recorder', () => {
  const f = referenceFixture()
  act(() => { f.config.set({ ...f.config.getSnapshot(), document: { schemaVersion: 1, profiles: {
    'web:macos': { 'settings.open': null },
  } } }) })
  fireEvent.click(screen.getByRole('button', { name: 'Edit shortcut for Open settings' }))
  const recorder = screen.getByRole('button', { name: en.record })
  recorder.focus()
  const restore = screen.getByRole('button', { name: en['reset-all'] })
  // Safari mouse clicks do not focus buttons; fireEvent keeps the recorder focused until the handler runs.
  fireEvent.click(restore)
  expect(recorder.isConnected).toBe(false)
  const confirmation = screen.getByRole('dialog', { name: en['reset-title'] })
  const cancel = within(confirmation).getByRole('button', { name: en.cancel })
  expect(document.activeElement).toBe(cancel)
  fireEvent.click(cancel)
  expect(document.activeElement).toBe(restore)
  expect(f.edit).not.toHaveBeenCalled()
})

it('restores defaults after confirmation and retains accepted configuration when the write fails', async () => {
  const f = referenceFixture()
  act(() => { f.config.set({ ...f.config.getSnapshot(), document: { schemaVersion: 1, profiles: {
    'web:macos': { 'settings.open': null },
  } } }) })
  const original = f.config.getSnapshot()
  let settle!: (result: Awaited<ReturnType<typeof f.edit>>) => void
  f.edit.mockReturnValueOnce(new Promise((resolve) => { settle = resolve }))
  const restore = screen.getByRole('button', { name: en['reset-all'] })
  restore.focus(); fireEvent.click(restore)
  const confirmation = screen.getByRole('dialog', { name: en['reset-title'] })
  const confirm = within(confirmation).getByRole('button', { name: en.reset })
  fireEvent.click(confirm)
  expect(f.edit).toHaveBeenCalledWith({ type: 'reset-all' }, original.revision)
  expect(confirm.hasAttribute('disabled')).toBe(true)
  expect(within(confirmation).getByRole('button', { name: en.cancel }).hasAttribute('disabled')).toBe(true)
  fireEvent.keyDown(confirmation, { key: 'Escape' })
  expect(screen.getByRole('dialog', { name: en['reset-title'] })).toBeTruthy()
  await act(async () => { settle({ status: 'write-failed', snapshot: original }) })
  expect(screen.getByRole('alert').textContent).toBe(en['reset-failed'])
  expect(f.config.getSnapshot()).toBe(original)
  expect(screen.getByText('1 customized')).toBeTruthy()
  f.edit.mockImplementationOnce(async () => {
    const snapshot = { ...original, document: { schemaVersion: 1 as const, profiles: {} } }
    f.config.set(snapshot)
    return { status: 'saved', snapshot }
  })
  await act(async () => { confirm.click() })
  expect(screen.queryByRole('dialog', { name: en['reset-title'] })).toBeNull()
  expect(screen.getByRole('alert').textContent).toBe(en['reset-saved'])
  expect(screen.queryByText('0 customized')).toBeNull()
  expect(restore.hasAttribute('disabled')).toBe(true)
  expect(document.activeElement).toBe(screen.getByRole('searchbox'))
})

it('requires a new confirmation when another window changes the configuration', async () => {
  const f = referenceFixture()
  act(() => { f.config.set({ ...f.config.getSnapshot(), document: { schemaVersion: 1, profiles: {
    'web:macos': { 'settings.open': null },
  } } }) })
  const original = f.config.getSnapshot()
  fireEvent.click(screen.getByRole('button', { name: en['reset-all'] }))
  const updated = { ...original, revision: initialShortcutConfig().revision }
  act(() => { f.config.set(updated) })
  f.edit.mockResolvedValueOnce({ status: 'stale', snapshot: updated })
  await act(async () => {
    within(screen.getByRole('dialog', { name: en['reset-title'] })).getByRole('button', { name: en.reset }).click()
  })
  expect(f.edit).toHaveBeenCalledWith({ type: 'reset-all' }, original.revision)
  expect(f.edit).toHaveBeenCalledOnce()
  expect(screen.queryByRole('dialog', { name: en['reset-title'] })).toBeNull()
  expect(screen.getByRole('alert').textContent).toBe(en.stale)
  fireEvent.click(screen.getByRole('button', { name: en['reset-all'] }))
  await act(async () => {
    within(screen.getByRole('dialog', { name: en['reset-title'] })).getByRole('button', { name: en.reset }).click()
  })
  expect(f.edit).toHaveBeenLastCalledWith({ type: 'reset-all' }, updated.revision)
})

it('keeps an active recorder focused when another window resets the profile', () => {
  const f = referenceFixture()
  act(() => { f.config.set({ ...f.config.getSnapshot(), document: { schemaVersion: 1, profiles: {
    'web:macos': { 'settings.open': null },
  } } }) })
  fireEvent.click(screen.getByRole('button', { name: 'Edit shortcut for Open settings' }))
  const recorder = screen.getByRole('button', { name: en.record })
  recorder.focus()
  act(() => { f.config.set({ ...initialShortcutConfig(), status: 'ready' }) })
  expect(document.activeElement).toBe(recorder)
  expect(screen.getByRole('group', { name: 'Open settings' })).toBeTruthy()
})

it('clears a search and returns focus to the search field', () => {
  referenceFixture()
  const search = screen.getByRole('searchbox')
  fireEvent.change(search, { target: { value: 'absent' } })
  expect(screen.queryAllByRole('listitem')).toHaveLength(0)
  fireEvent.click(screen.getByRole('button', { name: en['clear-search'] }))
  expect(screen.getAllByRole('listitem')).toHaveLength(1)
  expect(document.activeElement).toBe(search)
  expect(screen.queryByRole('button', { name: en['clear-search'] })).toBeNull()
})

it('closes the editor and drops a pending recording when blank space is clicked', async () => {
  const f = referenceFixture()
  fireEvent.click(screen.getByRole('button', { name: 'Edit shortcut for Open settings' }))
  const recorder = screen.getByRole('button', { name: en.record })
  expect(document.activeElement).toBe(recorder)
  fireEvent.keyDown(recorder, { key: '.', code: 'Period', metaKey: true, shiftKey: true })
  fireEvent.pointerDown(screen.getByRole('heading', { name: en.title }))
  expect(document.activeElement).toBe(screen.getByRole('dialog'))
  await act(async () => { fireEvent.keyUp(document.activeElement!, { key: '.', code: 'Period' }) })
  expect(f.edit).not.toHaveBeenCalled()
  expect(screen.queryByRole('group', { name: 'Open settings' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Edit shortcut for Open settings' }))
  const reopened = screen.getByRole('button', { name: en.record })
  await act(async () => {
    fireEvent.keyDown(reopened, { key: '.', code: 'Period', metaKey: true, shiftKey: true })
    fireEvent.keyUp(reopened, { key: '.', code: 'Period' })
  })
  expect(f.edit).toHaveBeenCalledOnce()
})

it('preserves a failed draft when its status text is clicked, then retries after reviewing an external change', async () => {
  const f = referenceFixture()
  fireEvent.pointerDown(screen.getByRole('heading', { name: en.title }))
  expect(f.store.getSnapshot().open).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Edit shortcut for Open settings' }))
  f.edit.mockResolvedValueOnce({ status: 'write-failed', snapshot: f.config.getSnapshot() })
  const recorder = screen.getByRole('button', { name: en.record })
  fireEvent.pointerDown(recorder)
  await act(async () => {
    fireEvent.keyDown(recorder, { key: '.', code: 'Period', metaKey: true, shiftKey: true })
    fireEvent.keyUp(recorder, { key: '.', code: 'Period' })
  })
  const editor = screen.getByRole('group', { name: 'Open settings' })
  fireEvent.pointerDown(within(editor).getByText(en['write-failed']))
  expect(within(editor).getByRole('button', { name: en['retry-save'] })).toBeTruthy()
  act(() => { f.config.set({ ...f.config.getSnapshot(), revision: initialShortcutConfig().revision }) })
  fireEvent.pointerDown(within(editor).getByText(en.stale))
  fireEvent.click(within(editor).getByRole('button', { name: en.review }))
  await act(async () => { within(editor).getByRole('button', { name: en['retry-save'] }).click() })
  expect(f.edit).toHaveBeenLastCalledWith({ type: 'set', id: 'settings.open', binding: { code: 'Period', modifiers: ['shift', 'meta'] } }, f.config.getSnapshot().revision)
  expect(screen.queryByRole('group', { name: 'Open settings' })).toBeNull()
})
