// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { ShortcutRegistry } from '../../shortcuts/src/client/registry.ts'
import { bindingIssue, initialShortcutConfig, normalizeBinding, overlappingBindings, presentBinding, ShortcutPersistence } from '@deepseek-ai/dsh-client-shortcuts/protocol'
import type { ShortcutCommandId, ShortcutSaveResult } from '@deepseek-ai/dsh-client-shortcuts/protocol'
import { ShortcutEditor } from '../src/client/Editor.tsx'
import type {} from '../src/client/index.ts'
import { en } from '../src/client/locales.ts'
import { fixedCommands } from '../src/client/fixed.ts'

afterEach(cleanup)
it('ignores repeated Escape and drops a pending Desktop key after focus leaves', async () => {
  const f = await mount()
  const recorder = screen.getByRole('button', { name: en.record })
  recorder.blur()
  fireEvent.keyDown(document, { code: 'Escape', key: 'Escape', repeat: true })
  expect(f.onClose).not.toHaveBeenCalled()
  recorder.focus()
  fireEvent.keyDown(recorder, { code: 'KeyJ', key: 'j' })
  recorder.blur()
  fireEvent.keyUp(document, { code: 'KeyJ' })
  expect(f.storage.write).not.toHaveBeenCalled()
})
it('clears a pending Desktop key when a modifier changes', async () => {
  const f = await mount()
  const recorder = screen.getByRole('button', { name: en.record })
  recorder.focus()
  fireEvent.keyDown(recorder, { code: 'KeyA', key: 'a' })
  fireEvent.keyDown(recorder, { code: 'ControlLeft', key: 'Control', ctrlKey: true })
  fireEvent.keyUp(recorder, { code: 'KeyA' })
  expect(f.storage.write).not.toHaveBeenCalled()
})

it.each(['web', 'desktop'] as const)('describes Linux recording constraints in %s', async (runtime) => {
  const f = await mount({ runtime, platform: 'linux' })
  expect(f.view.container.textContent).toContain(en[runtime === 'web' ? 'web-help' : 'record-help'])
})

it('ignores a Web dead-key composition before capturing another combination', async () => {
  const f = await mount({ runtime: 'web' })
  const recorder = screen.getByRole('button', { name: en.record })
  recorder.focus()
  fireEvent.keyDown(recorder, { code: 'KeyE', key: 'Dead', altKey: true })
  fireEvent.keyDown(recorder, { code: 'KeyE', key: 'é' })
  fireEvent.keyUp(recorder, { code: 'KeyE' })
  expect(f.storage.write).not.toHaveBeenCalled()
})

it('identifies a conflicting command that has left the displayed catalog', async () => {
  const missing = 'unloaded.command' as ShortcutCommandId
  const f = await mount({ describe: binding => ({ binding: binding === null ? null : normalizeBinding(binding, 'macos'),
    keys: [], issue: null, conflicts: [missing] }) })
  press('KeyJ')
  expect(f.onError).toHaveBeenCalledWith(expect.stringContaining(missing))
  expect(f.storage.write).not.toHaveBeenCalled()
})

it('explains an unreadable preference result returned while saving', async () => {
  const f = await mount({ result: async () => ({ status: 'unreadable', snapshot: {
    ...initialShortcutConfig(), status: 'unreadable', error: 'invalid',
  } }) })
  press('KeyJ')
  await waitFor(() => { expect(f.onError).toHaveBeenCalledWith(expect.stringContaining('keybindings.json')) })
})
const id = 'test.toggle' as ShortcutCommandId
async function mount(options: {
  recording?: (active: boolean) => Promise<void>
  result?: () => Promise<ShortcutSaveResult>
  runtime?: 'web' | 'desktop'
  platform?: 'macos' | 'windows' | 'linux'
  describe?: Parameters<typeof ShortcutEditor>[0]['describeBinding']
  setup?: (registry: ShortcutRegistry) => void
} = {}) {
  const platform = options.platform ?? 'macos'
  const runtime = options.runtime ?? 'desktop'
  const registry = new ShortcutRegistry(runtime, platform)
  registry.register({ id, label: () => 'Toggle sidebar', aliases: [], defaults: {
    [`${runtime}:${platform}`]: platform === 'linux' && runtime === 'web'
      ? { code: 'Slash', modifiers: ['primary'] }
      : { code: 'KeyB', modifiers: runtime === 'desktop' ? ['primary'] : ['primary', 'alt'] },
  },
  regions: ['page'], modals: [], resolve: () => ({ status: 'handled', run() {} }) })
  const describeBinding: Parameters<typeof ShortcutEditor>[0]['describeBinding'] = (binding) => {
    const normalized = binding === null ? null : normalizeBinding(binding, platform)
    return { binding: normalized,
      keys: presentBinding(normalized, platform).keys,
      issue: normalized === null ? null : bindingIssue(normalized, runtime, platform),
      conflicts: normalized === null ? [] : [...registry.catalog.getSnapshot().filter(row => row.binding !== null
        && overlappingBindings(row.binding, normalized)).map(row => row.id),
      ...registry.fixedCatalog.getSnapshot().filter(row => row.bindings.some(binding => overlappingBindings(binding, normalized)))
        .map(row => row.id)] }
  }
  for (const command of fixedCommands(makeTranslate(en))) registry.registerFixed(command)
  registry.registerFixed({ id: 'composer.inputs' as ShortcutCommandId, label: () => 'Composer input', keys: ['Enter'], group: 'input',
    bindings: [{ code: 'Enter', modifiers: ['shift'] }, { code: 'Enter', modifiers: ['control'] },
      { code: 'Enter', modifiers: ['meta'] }, { code: 'Slash', modifiers: [] }, { code: 'Digit2', modifiers: ['shift'] }] })
  let raw: string | null = null
  const storage = { read: vi.fn(async () => raw), write: vi.fn(async (next: string) => { raw = next }) }
  const persistence = new ShortcutPersistence(storage, runtime, platform, false, (value) => { registry.configure(value) })
  persistence.setDefinitions(registry.definitions()); await persistence.readCurrent()
  options.setup?.(registry)
  const onClose = vi.fn(), onSaved = vi.fn(), onError = vi.fn(), recording = vi.fn(options.recording ?? (async () => {}))
  const view = render(<ShortcutEditor target={registry.catalog.getSnapshot()[0]!}
    useFixedCatalog={bindSnapshotSelector(registry.fixedCatalog)}
    useCatalog={bindSnapshotSelector(registry.catalog)} useConfig={bindSnapshotSelector(registry.config)}
    runtime={runtime} platform={platform}
    edit={(edit, revision) => options.result?.() ?? persistence.edit(edit, revision)}
    describeBinding={options.describe ?? describeBinding}
    recording={recording} t={makeTranslate(en)}
    onClose={onClose} onSaved={onSaved} onError={onError} />)
  if (options.recording === undefined) await waitFor(() => { expect((screen.getByRole('button', { name: 'Press a shortcut' })).hasAttribute('disabled')).toBe(false) })
  return { registry, persistence, storage, onClose, onSaved, onError, recording, view }
}
const press = (code: string, extra: KeyboardEventInit = {}) => {
  const recorder = screen.getByRole('button', { name: 'Press a shortcut' }); recorder.focus()
  fireEvent.keyDown(recorder, { code, key: code.replace('Key', ''), metaKey: true, ...extra })
  fireEvent.keyUp(recorder, { code, ...extra })
}

it.each([
  { platform: 'windows', code: 'KeyC', key: 'c', ctrlKey: true, keys: ['Ctrl', '+', 'C'] },
  { platform: 'windows', code: 'KeyN', key: 'N', shiftKey: true, keys: ['Shift', '+', 'N'] },
  { platform: 'windows', code: 'Tab', key: 'Tab', ctrlKey: true, keys: ['Ctrl', '+', 'Tab'] },
  { platform: 'macos', code: 'KeyC', key: 'c', metaKey: true, keys: ['⌘', 'C'] },
  { platform: 'macos', code: 'KeyQ', key: 'q', metaKey: true, keys: ['⌘', 'Q'] },
  { platform: 'macos', code: 'ArrowLeft', key: 'ArrowLeft', altKey: true, keys: ['⌥', '←'] },
  { platform: 'macos', code: 'Tab', key: 'Tab', metaKey: true, keys: ['⌘', 'Tab'] },
  { platform: 'macos', code: 'Tab', key: 'Tab', shiftKey: true, keys: ['⇧', 'Tab'] },
] as const)('records $platform $code combinations without invoking their editing action', async ({ platform, keys, ...input }) => {
  const f = await mount({ platform })
  const recorder = screen.getByRole('button', { name: 'Press a shortcut' })
  recorder.focus()
  expect(fireEvent.keyDown(recorder, input)).toBe(false)
  fireEvent.keyUp(recorder, input)
  await waitFor(() => { expect(f.onSaved).toHaveBeenCalledOnce() })
  expect(f.registry.catalog.getSnapshot()[0]?.keys).toEqual(keys)
})

it('records macOS Web Option+Command+N reported as Dead and saves on Command release', async () => {
  const f = await mount({ runtime: 'web' })
  const recorder = screen.getByRole('button', { name: en.record })
  recorder.focus()
  expect(fireEvent.keyDown(recorder, { code: 'KeyN', key: 'Dead', metaKey: true, altKey: true })).toBe(false)
  expect(f.storage.write).not.toHaveBeenCalled()
  fireEvent.keyUp(recorder, { code: 'MetaLeft', key: 'Meta' })
  await waitFor(() => { expect(f.onSaved).toHaveBeenCalledOnce() })
  expect(f.registry.catalog.getSnapshot()[0]?.keys).toEqual(['⌥', '⌘', 'N'])
})

it.each(([
  { runtime: 'web', platform: 'macos' }, { runtime: 'web', platform: 'windows' },
  { runtime: 'desktop', platform: 'macos' }, { runtime: 'desktop', platform: 'windows' },
] as const).flatMap(environment => ['KeyX', 'Tab'].map(code => ({ ...environment, code }))))('records four-modifier $code in $runtime on $platform', async ({ code, ...environment }) => {
  const f = await mount(environment)
  press(code, { ctrlKey: true, altKey: true, shiftKey: true })
  await waitFor(() => { expect(f.onSaved).toHaveBeenCalledOnce() })
  expect(f.registry.catalog.getSnapshot()[0]?.binding).toEqual({ code, modifiers: ['control', 'alt', 'shift', 'meta'] })
})

it('retains macOS Web composition and accent guards while recording Option+Command+N', async () => {
  const f = await mount({ runtime: 'web' })
  const recorder = screen.getByRole('button', { name: en.record })
  const key = { code: 'KeyN', key: 'Dead', metaKey: true, altKey: true }
  recorder.focus()
  fireEvent.compositionStart(recorder)
  press('KeyN', key)
  fireEvent.compositionEnd(recorder)
  press('KeyN', key)
  for (const extra of [{ isComposing: true }, { metaKey: false }, { code: 'KeyE' }]) {
    fireEvent.blur(window)
    press('KeyN', { ...key, ...extra })
  }
  fireEvent.blur(window)
  const altGraph = new KeyboardEvent('keydown', { ...key, bubbles: true, cancelable: true })
  vi.spyOn(altGraph, 'getModifierState').mockReturnValue(true)
  act(() => { recorder.dispatchEvent(altGraph) })
  fireEvent.keyUp(recorder, { code: 'KeyN' })
  expect(f.storage.write).not.toHaveBeenCalled()
  expect(f.onSaved).not.toHaveBeenCalled()
})

it('records on release, keeps the draft on write failure, and updates all key labels after retry', async () => {
  const f = await mount()
  expect(f.recording).toHaveBeenCalledWith(true)
  const recorder = screen.getByRole('button', { name: 'Press a shortcut' }); recorder.focus()
  fireEvent.keyDown(recorder, { code: 'KeyJ', key: 'j', metaKey: true })
  expect(f.storage.write).not.toHaveBeenCalled()
  f.storage.write.mockRejectedValueOnce(new Error('disk full'))
  fireEvent.keyUp(recorder, { code: 'KeyJ' })
  await screen.findByText(en['write-failed'])
  expect(f.registry.catalog.getSnapshot()[0]?.keys).toEqual(['⌘', 'B'])
  expect(recorder.getAttribute('aria-invalid')).toBe('true')
  fireEvent.click(screen.getByRole('button', { name: en['retry-save'] }))
  await waitFor(() => { expect(f.onSaved).toHaveBeenCalledOnce() })
  expect(f.registry.catalog.getSnapshot()[0]?.keys).toEqual(['⌘', 'J'])
  f.view.unmount(); expect(f.recording).toHaveBeenLastCalledWith(false)
})

it('ignores modifier-only input, repeat, IME, dead keys, and AltGraph', async () => {
  const f = await mount()
  expect(f.storage.write).not.toHaveBeenCalled()
  for (const extra of [{ repeat: true }, { isComposing: true }]) press('KeyJ', extra)
  press('ControlLeft', { key: 'Control' })
  expect(f.storage.write).not.toHaveBeenCalled()
  const recorder = screen.getByRole('button', { name: 'Press a shortcut' })
  fireEvent.keyDown(recorder, { key: 'Dead' }); press('KeyJ')
  const event = new KeyboardEvent('keydown', { code: 'KeyJ', metaKey: true, bubbles: true })
  vi.spyOn(event, 'getModifierState').mockReturnValue(true)
  act(() => { recorder.dispatchEvent(event) })
  expect(f.storage.write).not.toHaveBeenCalled()
})

it.each(['macos', 'windows'] as const)('ignores the accent character after a %s dead key is released', async (platform) => {
  const f = await mount({ platform })
  const recorder = screen.getByRole('button', { name: en.record })
  await act(async () => {
    fireEvent.keyDown(recorder, { code: 'KeyE', key: 'Dead', altKey: true })
    fireEvent.keyUp(recorder, { code: 'KeyE', altKey: true })
    fireEvent.keyUp(recorder, { code: 'AltLeft', key: 'Alt' })
    fireEvent.keyDown(recorder, { code: 'KeyA', key: 'á' })
    fireEvent.keyUp(recorder, { code: 'KeyA' })
  })
  expect(f.storage.write).not.toHaveBeenCalled()
  expect(f.onSaved).not.toHaveBeenCalled()
  expect(f.onError).not.toHaveBeenCalled()
})

it('requires review after an external update and cancels Escape outside the recorder', async () => {
  const f = await mount()
  const recorder = screen.getByRole('button', { name: en.record }); recorder.focus()
  fireEvent.keyDown(recorder, { code: 'KeyJ', key: 'j', metaKey: true })
  await act(async () => { await f.persistence.edit({ type: 'set', id, binding: null }, f.registry.config.getSnapshot().revision) })
  fireEvent.keyUp(recorder, { code: 'KeyJ' })
  expect(screen.getAllByText(en.stale).length).toBeGreaterThan(0)
  expect(f.onSaved).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: en.review }))
  expect(screen.getByRole('button', { name: en['retry-save'] }).hasAttribute('disabled')).toBe(false)
  screen.getByRole('button', { name: en.reset }).focus()
  fireEvent.keyDown(document.activeElement!, { code: 'Escape', key: 'Escape' })
  expect(f.onClose).toHaveBeenCalledOnce(); expect(f.onSaved).not.toHaveBeenCalled()
})

it('requires review when available commands change during recording', async () => {
  const f = await mount()
  const recorder = screen.getByRole('button', { name: en.record })
  fireEvent.keyDown(recorder, { code: 'KeyJ', key: 'j', metaKey: true })
  await act(async () => {
    f.registry.register({ id: 'other.command' as ShortcutCommandId, label: () => 'Other command', aliases: [], defaults: {},
      regions: ['page'], modals: [], resolve: () => ({ status: 'pass' }) })
    f.persistence.setDefinitions(f.registry.definitions())
    await f.persistence.readCurrent()
  })
  fireEvent.keyUp(recorder, { code: 'KeyJ' })
  expect(screen.getAllByText('Shortcut configuration or available commands changed. Review the latest bindings before saving.').length).toBeGreaterThan(0)
  expect(f.storage.write).not.toHaveBeenCalled()
  expect(f.onSaved).not.toHaveBeenCalled()
})

it.each(['Remove', 'Restore default'])('performs %s through the same persistence operation', async (name) => {
  const f = await mount()
  fireEvent.click(screen.getByRole('button', { name }))
  await waitFor(() => { expect(f.onSaved).toHaveBeenCalledOnce() })
  expect(f.registry.catalog.getSnapshot()[0]?.modified).toBe(name === 'Remove')
})

it('reports unsupported codes, abandons unreleased keys on blur, and previews Tab', async () => {
  const f = await mount()
  press('Unidentified')
  expect(screen.getByText(en['unsupported-key'])).toBeTruthy()
  const recorder = screen.getByRole('button', { name: en.record })
  fireEvent.click(recorder)
  expect(screen.queryByText(en['unsupported-key'])).toBeNull()
  fireEvent.keyDown(recorder, { code: 'KeyJ', key: 'j', metaKey: true })
  fireEvent.blur(window); fireEvent.keyUp(recorder, { code: 'KeyJ' })
  expect(f.storage.write).not.toHaveBeenCalled()
  fireEvent.keyDown(recorder, { code: 'Tab', key: 'Tab' })
  expect(recorder.textContent).toBe('Tab')
})

it('shows conflicting command labels and preserves a blocked draft', async () => {
  const f = await mount({ setup: (registry) => {
    registry.register({ id: 'other.toggle' as ShortcutCommandId, label: () => 'Other action', aliases: [], defaults: {},
      regions: ['page'], modals: [], resolve: () => ({ status: 'pass' }) })
    registry.configure({ ...registry.config.getSnapshot(), revision: 'conflict' as ReturnType<typeof registry.config.getSnapshot>['revision'],
      document: { schemaVersion: 1, profiles: { 'desktop:macos': {
        [id]: { code: 'KeyJ', modifiers: ['primary'] }, 'other.toggle': { code: 'KeyJ', modifiers: ['primary'] },
      } } } })
  } })
  press('KeyJ')
  expect(screen.getByText('Already used by “Other action”')).toBeTruthy()
  expect(f.storage.write).not.toHaveBeenCalled()
  expect(f.onError).toHaveBeenCalledWith('Already used by “Other action”')
})

it.each(['reserved', 'conflict', 'unknown-conflict', 'empty-conflict'] as const)('shows the save-time %s diagnosis', async (status) => {
  const f = await mount({ result: async () => ({ status: 'conflict', snapshot: f.registry.config.getSnapshot(),
    ...(status === 'reserved' ? { issue: 'reserved' as const }
      : status === 'conflict' ? { conflicts: [id] }
        : status === 'unknown-conflict' ? { conflicts: ['dormant.action' as ShortcutCommandId] } : {}) }) })
  press('KeyJ')
  const message = status === 'reserved' ? en.reserved : `Already used by “${status === 'conflict' ? 'Toggle sidebar' : status === 'unknown-conflict' ? 'dormant.action' : ''}”`
  await screen.findByText(message)
  expect(f.onClose).not.toHaveBeenCalled(); expect(f.onSaved).not.toHaveBeenCalled()
})

it('keeps Desktop recording disabled on bridge failure and tolerates a rejected release', async () => {
  const f = await mount({ recording: async () => { throw new Error('disconnected') } })
  await screen.findByText(en['native-failed'])
  expect(screen.getByRole('button', { name: en.record }).hasAttribute('disabled')).toBe(true)
  f.view.unmount()
  await waitFor(() => { expect(f.recording).toHaveBeenLastCalledWith(false) })
})

it.each([true, false])('ignores a late native recording acknowledgement (success=%s)', async (success) => {
  let settle!: () => void
  const reply = new Promise<void>((resolve, reject) => { settle = success ? resolve : () => { reject(new Error('closed')) } })
  const f = await mount({ recording: active => active ? reply : Promise.resolve() })
  f.view.unmount()
  await act(async () => { settle(); await reply.catch(() => {}) })
  expect(f.onClose).not.toHaveBeenCalled()
})

it('blocks dismissal during a write and ignores completion after unmount', async () => {
  let settle!: (result: ShortcutSaveResult) => void
  const reply = new Promise<ShortcutSaveResult>((resolve) => { settle = resolve })
  const f = await mount({ result: () => reply })
  press('KeyJ')
  expect(screen.getByRole('button', { name: en.record }).getAttribute('aria-disabled')).toBe('true')
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
  expect(f.onClose).not.toHaveBeenCalled()
  f.view.unmount()
  await act(async () => { settle({ status: 'saved', snapshot: f.registry.config.getSnapshot() }); await reply })
  expect(f.onClose).not.toHaveBeenCalled(); expect(f.onSaved).not.toHaveBeenCalled()
})

it('offers the Web allowlist while recording without a native acknowledgement', async () => {
  await mount({ runtime: 'web' })
  expect(screen.getByText(en['macos-web-help'])).toBeTruthy()
})


it('finishes a Command combination on modifier release when macOS omits the letter keyup', async () => {
  const f = await mount()
  const recorder = screen.getByRole('button', { name: en.record }); recorder.focus()
  fireEvent.keyDown(recorder, { code: 'KeyJ', key: 'j', metaKey: true })
  fireEvent.keyUp(recorder, { code: 'ShiftLeft', key: 'Shift', metaKey: true })
  expect(f.storage.write).not.toHaveBeenCalled()
  fireEvent.keyUp(recorder, { code: 'MetaLeft', key: 'Meta' })
  await waitFor(() => { expect(f.onSaved).toHaveBeenCalledOnce() })
  expect(f.registry.catalog.getSnapshot()[0]?.keys).toEqual(['⌘', 'J'])
})

it.each(['loading', 'unreadable'] as const)('retains the binding if configuration becomes %s during recording', async (status) => {
  const f = await mount()
  act(() => { f.registry.configure({ ...f.registry.config.getSnapshot(), status }) })
  press('KeyJ')
  if (status === 'loading') expect(f.onError).toHaveBeenCalledWith(en['not-ready'])
  else expect(f.onError).toHaveBeenCalledWith(expect.stringContaining('userData/keybindings.json'))
  expect(f.storage.write).not.toHaveBeenCalled()
})

it('accepts only one action while a write is pending', async () => {
  let settle!: (result: ShortcutSaveResult) => void
  const reply = new Promise<ShortcutSaveResult>((resolve) => { settle = resolve })
  const result = vi.fn(() => reply)
  const f = await mount({ result })
  const reset = screen.getByRole('button', { name: en.reset })
  const remove = screen.getByRole('button', { name: en.clear })
  act(() => { reset.click(); remove.click() })
  expect(result).toHaveBeenCalledOnce()
  await act(async () => { settle({ status: 'saved', snapshot: f.registry.config.getSnapshot() }); await reply })
})

it.each((['macos', 'windows'] as const).flatMap(platform =>
  ['KeyA', 'F1', 'ArrowLeft', 'Tab'].map(code => ({ platform, code }))))(
  'records standalone $code on $platform without canceling, moving focus, or clicking recorder actions', async ({ platform, code }) => {
    const f = await mount({ platform })
    const recorder = screen.getByRole('button', { name: en.record }); recorder.focus()
    const key = { code, key: code.replace('Key', '') }
    expect(fireEvent.keyDown(recorder, key)).toBe(false)
    expect(document.activeElement).toBe(recorder)
    expect(f.storage.write).not.toHaveBeenCalled()
    expect(fireEvent.keyUp(recorder, key)).toBe(false)
    await waitFor(() => { expect(f.onSaved).toHaveBeenCalledOnce() })
    expect(f.onClose).not.toHaveBeenCalled()
    expect(f.registry.catalog.getSnapshot()[0]?.binding).toEqual({ code, modifiers: [] })
  })

it.each(['macos', 'windows'] as const)('records %s overlapping keys in either order, including all four modifiers', async (platform) => {
  const f = await mount({ platform })
  const recorder = screen.getByRole('button', { name: en.record }); recorder.focus()
  const modifiers = { ctrlKey: true, altKey: true, shiftKey: true, metaKey: true }
  fireEvent.keyDown(recorder, { code: 'KeyJ', key: 'j', ...modifiers })
  fireEvent.keyDown(recorder, { code: 'KeyA', key: 'a', ...modifiers })
  expect(f.storage.write).not.toHaveBeenCalled()
  expect(recorder.textContent).toContain('A')
  expect(recorder.textContent).toContain('J')
  fireEvent.keyUp(recorder, { code: 'KeyJ', ...modifiers })
  fireEvent.keyUp(recorder, { code: 'KeyA', ...modifiers })
  await waitFor(() => { expect(f.onSaved).toHaveBeenCalledOnce() })
  expect(f.registry.catalog.getSnapshot()[0]?.binding).toEqual({ code: 'KeyA', secondCode: 'KeyJ', modifiers: ['control', 'alt', 'shift', 'meta'] })
})

it.each(['macos', 'windows'] as const)('rejects %s fixed-action keys and their overlapping chords without replacing the current binding', async (platform) => {
  const f = await mount({ platform })
  const recorder = screen.getByRole('button', { name: en.record })
  expect(screen.queryByRole('button', { name: 'Cancel recording' })).toBeNull()
  expect(recorder.getAttribute('aria-describedby')).toBeTruthy()
  expect(document.getElementById(recorder.getAttribute('aria-describedby')!)?.textContent).toBe('')
  for (const input of [
    { code: 'Escape', key: 'Escape' }, { code: 'Enter', key: 'Enter' },
    { code: 'Enter', key: 'Enter', shiftKey: true }, { code: 'Enter', key: 'Enter', ctrlKey: true },
    { code: 'Enter', key: 'Enter', metaKey: true }, { code: 'ArrowUp', key: 'ArrowUp' },
    { code: 'ArrowDown', key: 'ArrowDown' }, { code: 'Slash', key: '/' }, { code: 'Digit2', key: '@', shiftKey: true },
  ]) {
    const errors = f.onError.mock.calls.length
    fireEvent.keyDown(recorder, input); fireEvent.keyUp(recorder, input)
    expect(f.onError).toHaveBeenCalledTimes(errors + 1)
    expect(document.activeElement).toBe(recorder)
    expect(recorder.getAttribute('aria-invalid')).toBe('true')
    expect(f.onError).toHaveBeenLastCalledWith(expect.stringContaining('Already used by'))
  }
  fireEvent.keyDown(recorder, { code: 'KeyA', key: 'a' })
  fireEvent.keyDown(recorder, { code: 'Escape', key: 'Escape' })
  fireEvent.keyUp(recorder, { code: 'Escape' })
  expect(recorder.getAttribute('aria-invalid')).toBe('true')
  expect(f.storage.write).not.toHaveBeenCalled()
  expect(f.onSaved).not.toHaveBeenCalled()
  expect(f.onClose).not.toHaveBeenCalled()
  expect(f.registry.catalog.getSnapshot()[0]?.binding?.code).toBe('KeyB')
})

it.each(['macos', 'windows'] as const)('records only the first released key for sequential %s presses', async (platform) => {
  const f = await mount({ platform })
  const recorder = screen.getByRole('button', { name: en.record }); recorder.focus()
  fireEvent.keyDown(recorder, { code: 'KeyA', key: 'a' })
  fireEvent.keyDown(recorder, { code: 'KeyA', key: 'a', repeat: true })
  fireEvent.keyUp(recorder, { code: 'KeyA', key: 'a' })
  fireEvent.keyDown(recorder, { code: 'KeyB', key: 'b' })
  fireEvent.keyUp(recorder, { code: 'KeyB', key: 'b' })
  await waitFor(() => { expect(f.onSaved).toHaveBeenCalledOnce() })
  expect(f.registry.catalog.getSnapshot()[0]?.binding).toEqual({ code: 'KeyA', modifiers: [] })
  expect(f.storage.write).toHaveBeenCalledOnce()
})

it.each(['macos', 'windows'] as const)('accepts a new %s combination after all keys of a rejected three-key draft are released', async (platform) => {
  const f = await mount({ platform })
  const recorder = screen.getByRole('button', { name: en.record }); recorder.focus()
  for (const code of ['KeyA', 'KeyB', 'KeyC']) fireEvent.keyDown(recorder, { code, key: code.slice(3) })
  for (const code of ['KeyA', 'KeyB', 'KeyC']) fireEvent.keyUp(recorder, { code })
  expect(screen.getByText(en['too-many-keys'])).toBeTruthy()
  expect(f.storage.write).not.toHaveBeenCalled()
  expect(document.activeElement).toBe(recorder)
  fireEvent.keyDown(recorder, { code: 'KeyJ', key: 'j' })
  fireEvent.keyUp(recorder, { code: 'KeyJ' })
  await waitFor(() => { expect(f.onSaved).toHaveBeenCalledOnce() })
  expect(f.registry.catalog.getSnapshot()[0]?.binding).toEqual({ code: 'KeyJ', modifiers: [] })
})

it.each(['macos', 'windows'] as const)('retries a %s command conflict while continuing to hold the modifier', async (platform) => {
  const f = await mount({ platform, setup: (registry) => {
    registry.register({ id: 'other.toggle' as ShortcutCommandId, label: () => 'Other action', aliases: [],
      defaults: { [`desktop:${platform}`]: { code: 'KeyK', modifiers: ['primary'] } },
      regions: ['page'], modals: [], resolve: () => ({ status: 'pass' }) })
  } })
  const recorder = screen.getByRole('button', { name: en.record })
  const modifiers = platform === 'macos' ? { metaKey: true } : { ctrlKey: true }
  fireEvent.keyDown(recorder, { code: 'KeyK', key: 'k', ...modifiers })
  fireEvent.keyUp(recorder, { code: 'KeyK', ...modifiers })
  expect(f.onError).toHaveBeenCalledWith('Already used by “Other action”')
  expect(f.storage.write).not.toHaveBeenCalled()
  expect(document.activeElement).toBe(recorder)
  fireEvent.keyDown(recorder, { code: 'KeyJ', key: 'j', ...modifiers })
  expect(recorder.getAttribute('aria-invalid')).toBe('false')
  fireEvent.keyUp(recorder, { code: 'KeyJ', ...modifiers })
  await waitFor(() => { expect(f.onSaved).toHaveBeenCalledOnce() })
  expect(f.registry.catalog.getSnapshot()[0]?.binding).toEqual({ code: 'KeyJ', modifiers: [platform === 'macos' ? 'meta' : 'control'] })
})

it.each(['macos', 'windows'] as const)('waits for the remaining %s chord keys before accepting a retry', async (platform) => {
  const f = await mount({ platform })
  const recorder = screen.getByRole('button', { name: en.record })
  fireEvent.keyDown(recorder, { code: 'KeyA', key: 'a' })
  fireEvent.keyDown(recorder, { code: 'Escape', key: 'Escape' })
  fireEvent.keyUp(recorder, { code: 'Escape' })
  expect(f.onError).toHaveBeenCalledOnce()
  fireEvent.keyDown(recorder, { code: 'KeyA', key: 'a', repeat: true })
  fireEvent.keyDown(recorder, { code: 'KeyJ', key: 'j' })
  fireEvent.keyUp(recorder, { code: 'KeyA' })
  fireEvent.keyDown(recorder, { code: 'KeyK', key: 'k' })
  fireEvent.keyUp(recorder, { code: 'KeyJ' })
  fireEvent.keyUp(recorder, { code: 'KeyK' })
  expect(f.onError).toHaveBeenCalledOnce()
  expect(f.storage.write).not.toHaveBeenCalled()
  fireEvent.keyDown(recorder, { code: 'KeyJ', key: 'j' })
  fireEvent.keyUp(recorder, { code: 'KeyJ' })
  await waitFor(() => { expect(f.onSaved).toHaveBeenCalledOnce() })
  expect(f.registry.catalog.getSnapshot()[0]?.binding).toEqual({ code: 'KeyJ', modifiers: [] })
})

it('retries unsupported keys and macOS conflicts whose character keyup is omitted', async () => {
  const f = await mount()
  const recorder = screen.getByRole('button', { name: en.record })
  fireEvent.keyDown(recorder, { code: 'Unidentified', key: 'Unidentified', metaKey: true })
  expect(f.onError).toHaveBeenLastCalledWith(en['unsupported-key'])
  fireEvent.keyUp(recorder, { code: 'MetaLeft', key: 'Meta' })
  fireEvent.keyDown(recorder, { code: 'Enter', key: 'Enter', metaKey: true })
  fireEvent.keyUp(recorder, { code: 'MetaLeft', key: 'Meta' })
  expect(f.onError).toHaveBeenCalledTimes(2)
  expect(f.onError).toHaveBeenLastCalledWith(expect.stringContaining('Already used by'))
  fireEvent.keyDown(recorder, { code: 'KeyJ', key: 'j', metaKey: true })
  fireEvent.keyUp(recorder, { code: 'MetaLeft', key: 'Meta' })
  await waitFor(() => { expect(f.onSaved).toHaveBeenCalledOnce() })
  expect(f.registry.catalog.getSnapshot()[0]?.binding).toEqual({ code: 'KeyJ', modifiers: ['meta'] })
})

it('keeps recorder focus during a write and accepts another combination after failure', async () => {
  const f = await mount()
  let reject!: (error: Error) => void
  const write = new Promise<void>((_resolve, rejectWrite) => { reject = rejectWrite })
  f.storage.write.mockImplementationOnce(() => write)
  const recorder = screen.getByRole('button', { name: en.record })
  fireEvent.keyDown(recorder, { code: 'KeyJ', key: 'j', metaKey: true })
  fireEvent.keyUp(recorder, { code: 'KeyJ' })
  expect(recorder.getAttribute('aria-disabled')).toBe('true')
  expect(recorder.hasAttribute('disabled')).toBe(false)
  fireEvent.click(recorder)
  fireEvent.keyDown(recorder, { code: 'KeyK', key: 'k', metaKey: true })
  fireEvent.keyUp(recorder, { code: 'KeyK' })
  await waitFor(() => { expect(f.storage.write).toHaveBeenCalledOnce() })
  expect(recorder.textContent).toContain('J')
  await act(async () => { reject(new Error('disk full')); await write.catch(() => {}) })
  await screen.findByText(en['write-failed'])
  expect(document.activeElement).toBe(recorder)
  fireEvent.keyDown(recorder, { code: 'KeyK', key: 'k', metaKey: true })
  fireEvent.keyUp(recorder, { code: 'KeyK' })
  await waitFor(() => { expect(f.onSaved).toHaveBeenCalledOnce() })
  expect(f.registry.catalog.getSnapshot()[0]?.binding).toEqual({ code: 'KeyK', modifiers: ['meta'] })
})

it.each(['focus', 'composition'] as const)('abandons an unfinished Desktop recording on %s changes', async (change) => {
  const f = await mount()
  const recorder = screen.getByRole('button', { name: en.record }); recorder.focus()
  fireEvent.keyDown(recorder, { code: 'KeyA', key: 'a' })
  if (change === 'focus') screen.getByRole('button', { name: en.reset }).focus()
  else fireEvent.compositionStart(recorder)
  fireEvent.keyUp(recorder, { code: 'KeyA' })
  expect(f.storage.write).not.toHaveBeenCalled()
})

it.each(['macos', 'windows'] as const)('retains %s Web Escape cancellation, Tab navigation and single-key validation', async (platform) => {
  const f = await mount({ runtime: 'web', platform })
  press('KeyA', { metaKey: false })
  expect(f.onError).toHaveBeenCalledWith(en['modifier-required'])
  const recorder = screen.getByRole('button', { name: en.record })
  expect(fireEvent.keyDown(recorder, { code: 'Tab', key: 'Tab' })).toBe(true)
  fireEvent.keyDown(recorder, { code: 'Escape', key: 'Escape' })
  expect(f.onClose).toHaveBeenCalledOnce()
  expect(f.storage.write).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: 'Cancel recording' })).toBeNull()
})
