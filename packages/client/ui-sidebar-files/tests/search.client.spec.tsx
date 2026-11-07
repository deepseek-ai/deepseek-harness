// @vitest-environment jsdom
/**
 * The navigator's search: the bar above the tree, the results drawn in the
 * tree's place, the settings panel, the hidden-entry control, the keyboard,
 * and the Escape order. A scripted search stands in for the Host's: it
 * answers every query with fixed matches, or leaves a query open.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, within } from '@testing-library/react'
import { sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import { zh } from '../src/client/locales.ts'
import { defaultRules, enabledPaths } from '../src/client/search-rules.ts'
import type { WorkspaceSearchPreferences } from '../src/client/search-rules.ts'
import type { DirLevel } from '../src/client/store.ts'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { mountNavigator, PANE, ROOT, SESSION } from './mount.client.tsx'
import type { Mounted } from './mount.client.tsx'
import { answer, memoryBook, searchesSettled } from './search-fixture.client.ts'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'

const ROOT_LEVEL: DirLevel = {
  entries: [
    { name: 'src', type: 'directory' }, { name: 'node_modules', type: 'directory' },
    { name: '.env', type: 'file', size: 1 }, { name: 'README.md', type: 'file', size: 1 },
  ],
  truncated: false,
}
const SRC_LEVEL: DirLevel = { entries: [{ name: 'a.ts', type: 'file', size: 1 }, { name: 'b.ts', type: 'file', size: 1 }], truncated: false }
const A = sessionFileAddress(SESSION, 'src/a.ts')
const t = makeTranslate(zh)

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(() => {
  cleanup()
  Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
})

/** Show the navigator on a page-less tab and answer the root listing. */
async function shown(h: Mounted): Promise<void> {
  act(() => { h.instance.actions.shown(PANE, true) })
  await act(() => h.script.watches.ready(ROOT))
  await act(() => h.script.settle({ ok: true, value: ROOT_LEVEL }))
}

/** Show the navigator beside `src/a.ts` and answer the root and `src` listings. */
async function revealed(h: Mounted): Promise<void> {
  await shown(h)
  await act(() => h.script.watches.ready(`${ROOT}/src`))
  await act(() => h.script.settle({ ok: true, value: SRC_LEVEL }))
}

const field = (h: Mounted): HTMLInputElement => within(h.view.container).getByRole<HTMLInputElement>('searchbox', { name: zh['search.placeholder'] })
const body = (h: Mounted): HTMLElement => h.view.container.querySelector<HTMLElement>('[data-files-body]')!

/**
 * The tooltip text of the empty result's information button, read by pinning
 * the tooltip with a click and closing it again; `undefined` without the button.
 */
const emptyHint = (h: Mounted): string | undefined => {
  const button = body(h).querySelector<HTMLElement>('[data-files-search-hint]')
  if (button === null) return undefined
  expect(button.getAttribute('aria-label')).toBe(zh['search.emptyHint.label'])
  fireEvent.click(button)
  const text = document.querySelector('[role="tooltip"]')?.textContent
  fireEvent.click(button)
  expect(document.querySelector('[role="tooltip"]')).toBeNull()
  return text
}
const status = (h: Mounted): string | null | undefined => h.view.container.querySelector('[data-files-search-status]')?.textContent
const paths = (h: Mounted): string[] => [...body(h).querySelectorAll('[data-files-entry]')].map(li => li.getAttribute('data-files-path')!)
const dialog = (h: Mounted): HTMLElement | null => h.view.queryByRole('dialog')
const settingsButton = (h: Mounted): HTMLElement => h.view.getByRole('button', { name: zh['search.settings'] })

/** jsdom omits mousedown's focus default; honor its cancellation before clicking. */
function pointerClick(target: HTMLElement): void {
  act(() => {
    fireEvent.pointerDown(target, { button: 0, pointerType: 'mouse' })
    if (fireEvent.mouseDown(target, { button: 0 })) target.focus()
    fireEvent.pointerUp(target, { button: 0, pointerType: 'mouse' })
    fireEvent.mouseUp(target, { button: 0 })
    fireEvent.click(target, { button: 0 })
  })
}

/** Supply the focused button's native keyboard activation that jsdom omits. */
function keyboardClick(target: HTMLElement, key: 'Enter' | ' '): void {
  act(() => {
    target.focus()
    const allowed = fireEvent.keyDown(target, { key })
    if (allowed && key === 'Enter') target.click()
    const released = fireEvent.keyUp(target, { key })
    if (allowed && released && key === ' ') target.click()
  })
}

/**
 * Type into the search field and let the search's answer draw.
 * @param h - the mounted navigator.
 * @param text - the field's new text.
 * @param matches - what the search answers, as `answer` takes them; the previous answer when omitted.
 */
async function type(h: Mounted, text: string, matches?: readonly string[]): Promise<void> {
  if (matches !== undefined) h.searches.answerWith(answer(matches))
  await act(async () => {
    fireEvent.change(field(h), { target: { value: text } })
    await searchesSettled()
  })
}
/** Run a store or face write and let a search it starts draw its answer. */
async function settled(write: () => void): Promise<void> {
  await act(async () => {
    write()
    await searchesSettled()
  })
}
/** The requests the search received, oldest first. */
const requests = (h: Mounted) => h.search.mock.calls.map(([, request]) => request)

describe('the search bar', () => {
  it('searches as the reader types and draws the matches as a highlighted tree with its count', async () => {
    const h = mountNavigator('sidebar://files')
    await shown(h)
    expect(h.view.queryByRole('button', { name: zh['search.clear'] })).toBeNull()
    await type(h, ' Ab ', ['src/tab.ts', 'lib/AB/', 'lib/AB/x.ts'])
    expect(requests(h)).toEqual([{ query: 'Ab', excludedPaths: enabledPaths(defaultRules()), includeHidden: false, respectGitignore: true }])
    expect(status(h)).toBe(t('search.results', { count: '3' }))
    expect(paths(h)).toEqual([`${ROOT}/lib`, `${ROOT}/lib/AB`, `${ROOT}/lib/AB/x.ts`, `${ROOT}/src`, `${ROOT}/src/tab.ts`])
    expect([...body(h).querySelectorAll('mark')].map(mark => mark.textContent)).toEqual(['AB', 'ab'])
    expect(body(h).querySelector(`[data-files-path="${ROOT}/src/tab.ts"] button`)?.textContent).toBe('tab.ts')
    expect(h.view.getByRole('button', { name: zh['search.clear'] })).toBeTruthy()
    // Whitespace around the same text asks nothing new and keeps the count.
    await type(h, 'Ab')
    expect(requests(h)).toHaveLength(1)
    expect(status(h)).toBe(t('search.results', { count: '3' }))
  })

  it('collapses result directories on their own, and opens a result like a tree row with the tab\'s file marked', async () => {
    const h = mountNavigator(A)
    await revealed(h)
    await type(h, 'a', ['src/a.ts', 'empty/'])
    // A matched directory without matched descendants is not called empty.
    expect(body(h).querySelector('[data-files-row="empty"]')).toBeNull()
    expect(body(h).querySelector('[aria-current="true"]')?.closest('[data-files-path]')?.getAttribute('data-files-path')).toBe(`${ROOT}/src/a.ts`)
    const src = (): HTMLElement => body(h).querySelector<HTMLElement>(`[data-files-path="${ROOT}/src"] > div > button`)!
    act(() => { fireEvent.click(src()) })
    expect(src().getAttribute('aria-expanded')).toBe('false')
    expect(h.instance.getSnapshot().byPane[PANE]?.tree?.expanded).toEqual([ROOT, `${ROOT}/src`])
    act(() => { fireEvent.click(src()) })
    fireEvent.click(body(h).querySelector<HTMLElement>(`[data-files-path="${ROOT}/src/a.ts"] > div > button`)!)
    expect(h.onOpen).toHaveBeenLastCalledWith(A)
  })

  it('draws the tree again as it was — expansion, scroll, and the current file — once the query is cleared', async () => {
    const h = mountNavigator(A)
    await revealed(h)
    fireEvent.scroll(body(h), { target: { scrollTop: 64 } })
    await type(h, 'b', ['src/b.ts'])
    expect(body(h).getAttribute('data-files-view')).toBe('search')
    expect(body(h).scrollTop).toBe(0)
    fireEvent.scroll(body(h), { target: { scrollTop: 12 } })
    act(() => { fireEvent.click(h.view.getByRole('button', { name: zh['search.clear'] })) })
    expect(document.activeElement).toBe(field(h))
    expect(status(h)).toBe('')
    expect(body(h).getAttribute('data-files-view')).toBe('tree')
    expect(body(h).scrollTop).toBe(64)
    expect(h.instance.getSnapshot().byPane[PANE]?.tree?.expanded).toEqual([ROOT, `${ROOT}/src`])
    expect(body(h).querySelector('[aria-current="true"]')?.closest('[data-files-path]')?.getAttribute('data-files-path')).toBe(`${ROOT}/src/a.ts`)
    await type(h, 'b')
    expect(body(h).scrollTop).toBe(0)
    // A remount during a search restores the results' own offset.
    fireEvent.scroll(body(h), { target: { scrollTop: 30 } })
    h.view.unmount()
    const back = h.remount()
    expect(back.container.querySelector('[data-files-body]')?.scrollTop).toBe(30)
    // New results start at their top.
    await settled(() => { h.face.setQuery(PANE, ROOT, 'bb') })
    expect(back.container.querySelector('[data-files-body]')?.scrollTop).toBe(0)
  })

  it('says when nothing matched, with an information button whose tooltip names which of hidden entries, excluded paths, and ignored ones the search left out', async () => {
    const h = mountNavigator('sidebar://files')
    await shown(h)
    await type(h, 'zzz')
    expect(body(h).textContent).toBe(zh['search.empty'])
    expect(emptyHint(h)).toBe(zh['search.emptyHint.all'])
    expect(status(h)).toBe(t('search.results', { count: '0' }))
    const settle = async (preferences: Partial<WorkspaceSearchPreferences>): Promise<string | undefined> => {
      await settled(() => { h.face.setSearchPreferences(ROOT, preferences) })
      expect(body(h).textContent).toBe(zh['search.empty'])
      return emptyHint(h)
    }
    expect(await settle({ showHidden: true })).toBe(zh['search.emptyHint.excludedIgnored'])
    expect(requests(h).at(-1)).toMatchObject({ excludedPaths: enabledPaths(defaultRules()), includeHidden: true })
    expect(await settle({ rules: [] })).toBe(zh['search.emptyHint.ignored'])
    expect(requests(h).at(-1)).toMatchObject({ excludedPaths: [], includeHidden: true })
    expect(await settle({ showHidden: false })).toBe(zh['search.emptyHint.hiddenIgnored'])
    // Turning ignore files off leaves out only what the other two settings take.
    expect(await settle({ respectGitignore: false })).toBe(zh['search.emptyHint.hidden'])
    expect(requests(h).at(-1)).toMatchObject({ respectGitignore: false })
    // With nothing excluded, hidden entries shown, and ignore files not respected, the search left nothing out.
    expect(await settle({ showHidden: true })).toBeUndefined()
    // A rule that is listed but off excludes nothing.
    expect(await settle({ rules: [{ path: 'dist', enabled: false }] })).toBeUndefined()
    // Leaving out hidden entries is the only thing that remains.
    expect(await settle({ showHidden: false })).toBe(zh['search.emptyHint.hidden'])
    expect(await settle({ rules: defaultRules(), showHidden: true })).toBe(zh['search.emptyHint.excluded'])
    expect(await settle({ showHidden: false })).toBe(zh['search.emptyHint.both'])
  })

  it('says below the results, matched or not, when only the first matches are drawn and when some directories were not searched', async () => {
    const h = mountNavigator('sidebar://files')
    await shown(h)
    const note = (row: string): string | null | undefined => body(h).querySelector(`[data-files-row="${row}"]`)?.textContent
    h.searches.answerWith(answer(['src/a.ts', 'src/ab.ts'], { truncated: true }))
    await type(h, 'a')
    expect(note('search-truncated')).toBe(t('search.truncated', { count: '2' }))
    expect(note('search-incomplete')).toBeUndefined()
    expect(note('search-empty')).toBeUndefined()
    h.searches.answerWith(answer(['src/a.ts'], { incomplete: true }))
    await type(h, 'ab')
    expect(note('search-truncated')).toBeUndefined()
    expect(note('search-incomplete')).toBe(zh['search.incomplete'])
    h.searches.answerWith(answer([], { truncated: true, incomplete: true }))
    await type(h, 'zzz')
    expect(body(h).textContent).toBe(`${zh['search.empty']}${t('search.truncated', { count: '0' })}${zh['search.incomplete']}`)
    expect(emptyHint(h)).toBe(zh['search.emptyHint.all'])
  })

  it('keeps the last results drawn with a spinner while the next search runs, and draws only a spinner before the first answer', async () => {
    const h = mountNavigator('sidebar://files')
    await shown(h)
    const spinner = (): Element | null => h.view.container.querySelector('[data-files-search-status] [data-state="ongoing"]')
    expect(spinner()).toBeNull()
    h.searches.answerWith(undefined)
    await type(h, 'a')
    // Before the first answer the results area is empty: no tree, no note.
    expect(body(h).getAttribute('data-files-view')).toBe('search')
    expect(body(h).getAttribute('aria-busy')).toBe('true')
    expect(body(h).textContent).toBe('')
    expect(status(h)).toBe('')
    expect(spinner()).not.toBeNull()
    await settled(() => { h.searches.started[0]!.settle(answer(['src/a.ts'])) })
    expect(spinner()).toBeNull()
    expect(body(h).getAttribute('aria-busy')).toBe('false')
    expect(paths(h)).toEqual([`${ROOT}/src`, `${ROOT}/src/a.ts`])
    // A newer search keeps those results and the count until its answer replaces them.
    await type(h, 'b')
    expect(spinner()).not.toBeNull()
    expect(paths(h)).toEqual([`${ROOT}/src`, `${ROOT}/src/a.ts`])
    expect(status(h)).toBe(t('search.results', { count: '1' }))
    await settled(() => { h.searches.started[1]!.settle(answer([])) })
    expect(spinner()).toBeNull()
    expect(status(h)).toBe(t('search.results', { count: '0' }))
  })

  it('says why a search failed in the results\' place, and searches again from its retry control', async () => {
    const h = mountNavigator('sidebar://files')
    await shown(h)
    h.searches.answerWith({ ok: false, error: new RemoteError('workspace-file/not-found', 'no entry at "/work/app"', { path: '/work/app' }) })
    await type(h, 'a')
    const failed = (): HTMLElement | null => body(h).querySelector('[data-files-row="search-failed"]')
    // A classified failure reads as the tree's own line, not the Host's untranslated message.
    expect(within(failed()!).getByRole('alert').textContent).toBe(t('search.failed', { message: t('error.notFound') }))
    expect(status(h)).toBe('')
    expect(paths(h)).toEqual([])
    h.searches.answerWith(answer(['src/a.ts']))
    const retry = within(failed()!).getByRole('button', { name: zh['search.retry'] })
    await settled(() => { fireEvent.click(retry) })
    expect(requests(h)).toHaveLength(2)
    expect(requests(h)[1]).toEqual(requests(h)[0])
    expect(failed()).toBeNull()
    expect(paths(h)).toEqual([`${ROOT}/src`, `${ROOT}/src/a.ts`])
  })

  it('keeps the status line mounted as a live region while the query is blank, so a screen reader hears the first search', async () => {
    const h = mountNavigator('sidebar://files')
    await shown(h)
    const live = h.view.container.querySelector('[data-files-search-status]')
    expect(live?.getAttribute('aria-live')).toBe('polite')
    expect(live?.textContent).toBe('')
    await type(h, 'a', ['a.ts'])
    expect(h.view.container.querySelector('[data-files-search-status]')).toBe(live)
    expect(live?.textContent).toBe(t('search.results', { count: '1' }))
    await type(h, '')
    expect(h.view.container.querySelector('[data-files-search-status]')).toBe(live)
    expect(live?.textContent).toBe('')
  })
})

describe('the hidden-entry control', () => {
  it('leaves hidden entries out of the tree and the search until pressed, and shows them in both while pressed', async () => {
    const h = mountNavigator('sidebar://files')
    await shown(h)
    const eye = (): HTMLElement => h.view.container.querySelector<HTMLElement>('[data-files-show-hidden]')!
    expect(eye().getAttribute('aria-pressed')).toBe('false')
    expect(eye().getAttribute('aria-label')).toBe(zh['search.showHidden'])
    // The name stays fixed; only `aria-pressed` reports the state.
    expect(paths(h)).not.toContain(`${ROOT}/.env`)
    act(() => { fireEvent.click(eye()) })
    expect(eye().getAttribute('aria-pressed')).toBe('true')
    expect(eye().getAttribute('aria-label')).toBe(zh['search.showHidden'])
    expect(paths(h)).toContain(`${ROOT}/.env`)
    await type(h, 'env', ['.env'])
    expect(requests(h)[0]?.includeHidden).toBe(true)
    expect(paths(h)).toEqual([`${ROOT}/.env`])
    // Changing it during a search searches again at once.
    act(() => { fireEvent.click(eye()) })
    expect(requests(h)[1]?.includeHidden).toBe(false)
  })

  it('says a directory holding only hidden entries holds hidden entries, not that it is empty', async () => {
    const h = mountNavigator('sidebar://files')
    act(() => { h.instance.actions.shown(PANE, true) })
    await act(() => h.script.watches.ready(ROOT))
    await act(() => h.script.settle({ ok: true, value: { entries: [{ name: '.env', type: 'file', size: 1 }], truncated: false } }))
    expect(body(h).querySelector('[data-files-row="empty"]')).toBeNull()
    expect(body(h).querySelector('[data-files-row="hidden-only"]')?.textContent).toBe(zh.emptyHidden)
    act(() => { fireEvent.click(h.view.container.querySelector('[data-files-show-hidden]')!) })
    expect(body(h).querySelector('[data-files-row="hidden-only"]')).toBeNull()
    expect(paths(h)).toEqual([`${ROOT}/.env`])
  })

  it('applies exclusions only to the search, so the tree still lists excluded directories', async () => {
    const h = mountNavigator('sidebar://files')
    await shown(h)
    expect(paths(h)).toContain(`${ROOT}/node_modules`)
    await type(h, 'x')
    expect(requests(h)[0]?.excludedPaths).toContain('node_modules')
    await type(h, '')
    expect(paths(h)).toContain(`${ROOT}/node_modules`)
  })

  it('shares one workspace\'s choice across Sessions rooted there, and not with another workspace', async () => {
    const book = memoryBook()
    const one = mountNavigator('sidebar://files', {}, ROOT, book)
    const two = mountNavigator('sidebar://files', {}, `${ROOT}/`, book)
    const other = mountNavigator('sidebar://files', {}, '/work/other', book)
    act(() => {
      for (const h of [one, two, other]) h.instance.actions.shown(PANE, true)
    })
    const eye = (h: Mounted): string | null => h.view.container.querySelector('[data-files-show-hidden]')!.getAttribute('aria-pressed')
    act(() => { fireEvent.click(one.view.container.querySelector('[data-files-show-hidden]')!) })
    expect([eye(one), eye(two), eye(other)]).toEqual(['true', 'true', 'false'])
  })
})

describe('the settings panel', () => {
  /** Open the panel from the magnifier. */
  function open(h: Mounted): HTMLElement {
    pointerClick(settingsButton(h))
    expect(settingsButton(h).getAttribute('aria-expanded')).toBe('true')
    return dialog(h)!
  }
  const stored = (h: Mounted) => h.book.source(ROOT).getSnapshot()

  it.each(['pointer', 'Enter', ' '] as const)('saves checkbox edits when the magnifier is activated with %j and searches with the saved rules', async (gesture) => {
    const h = mountNavigator('sidebar://files')
    await shown(h)
    await type(h, 'a')
    const toggle = (): void => {
      if (gesture === 'pointer') pointerClick(settingsButton(h))
      else keyboardClick(settingsButton(h), gesture)
    }
    toggle()
    const checkbox = within(dialog(h)!).getByRole<HTMLInputElement>('checkbox', { name: t('settings.toggle', { path: 'dist' }) })
    pointerClick(checkbox)
    expect(document.activeElement).toBe(checkbox)
    expect(checkbox.checked).toBe(false)
    expect(stored(h).rules.find(rule => rule.path === 'dist')?.enabled).toBe(true)
    expect(requests(h)).toHaveLength(1)

    toggle()
    expect(dialog(h)).toBeNull()
    expect(settingsButton(h).getAttribute('aria-expanded')).toBe('false')
    expect(stored(h).rules.find(rule => rule.path === 'dist')?.enabled).toBe(false)
    expect(document.activeElement).toBe(settingsButton(h))
    expect(requests(h)).toEqual([requests(h)[0], {
      query: 'a', excludedPaths: enabledPaths(defaultRules()).filter(path => path !== 'dist'), includeHidden: false, respectGitignore: true,
    }])

    toggle()
    expect(within(dialog(h)!).getByRole('checkbox', { name: t('settings.toggle', { path: 'dist' }) })).toHaveProperty('checked', false)
  })

  it('keeps added and removed paths when the magnifier closes a panel without a query', async () => {
    const h = mountNavigator('sidebar://files')
    await shown(h)
    pointerClick(settingsButton(h))
    const panel = dialog(h)!
    const add = within(panel).getByRole('textbox', { name: zh['settings.add'] })
    act(() => {
      fireEvent.change(add, { target: { value: './cache/' } })
      fireEvent.keyDown(add, { key: 'Enter' })
    })
    pointerClick(within(panel).getByRole('button', { name: t('settings.remove', { path: 'build' }) }))
    expect(document.activeElement).toBe(add)
    expect(stored(h).rules.map(rule => rule.path)).not.toContain('cache')
    expect(stored(h).rules.map(rule => rule.path)).toContain('build')

    pointerClick(settingsButton(h))
    expect(dialog(h)).toBeNull()
    expect(stored(h).rules[0]).toEqual({ path: 'cache', enabled: true })
    expect(stored(h).rules.map(rule => rule.path)).not.toContain('build')
    pointerClick(settingsButton(h))
    expect(within(dialog(h)!).getByRole('checkbox', { name: t('settings.toggle', { path: 'cache' }) })).toHaveProperty('checked', true)
    expect(within(dialog(h)!).queryByRole('checkbox', { name: t('settings.toggle', { path: 'build' }) })).toBeNull()
    expect(h.search).not.toHaveBeenCalled()
  })

  it('opens from the magnifier with the add field focused, and saves on its close control, on Escape, and when focus leaves it', async () => {
    const h = mountNavigator('sidebar://files')
    h.row.width = 480
    await shown(h)
    // Pressing the magnifier on a closed panel takes the keyboard as any button does.
    expect(fireEvent.mouseDown(settingsButton(h))).toBe(true)
    let panel = open(h)
    expect(within(panel).getByText(zh['settings.title'])).toBeTruthy()
    expect(document.activeElement).toBe(within(panel).getByRole('textbox', { name: zh['settings.add'] }))
    expect(h.view.container.querySelectorAll('[data-files-show-hidden]')).toHaveLength(1)
    pointerClick(within(panel).getByRole('checkbox', { name: t('settings.toggle', { path: 'dist' }) }))
    // Nothing is written while the panel is open.
    expect(stored(h).rules.find(rule => rule.path === 'dist')?.enabled).toBe(true)
    pointerClick(within(panel).getByRole('button', { name: zh['settings.close'] }))
    expect(dialog(h)).toBeNull()
    expect(document.activeElement).toBe(settingsButton(h))
    expect(stored(h).rules.find(rule => rule.path === 'dist')?.enabled).toBe(false)

    panel = open(h)
    pointerClick(within(panel).getByRole('button', { name: t('settings.remove', { path: 'build' }) }))
    expect(dialog(h)).not.toBeNull()
    act(() => { fireEvent.keyDown(within(panel).getByRole('textbox'), { key: 'Escape' }) })
    expect(dialog(h)).toBeNull()
    // The overlaying navigator stays: the panel kept the Escape.
    expect(h.view.container.querySelector('[data-files-navigator]')).not.toBeNull()
    expect(stored(h).rules.map(rule => rule.path)).not.toContain('build')

    panel = open(h)
    pointerClick(within(panel).getByRole('checkbox', { name: t('settings.toggle', { path: 'coverage' }) }))
    act(() => { body(h).focus() })
    expect(dialog(h)).toBeNull()
    expect(stored(h).rules.find(rule => rule.path === 'coverage')?.enabled).toBe(false)

    // Closing without an edit writes nothing; the magnifier closes it too.
    const before = stored(h)
    open(h)
    pointerClick(settingsButton(h))
    expect(dialog(h)).toBeNull()
    expect(stored(h)).toBe(before)
  })

  it('shows the restore control whenever the list differs from the defaults, and replaces the list with the defaults', async () => {
    const h = mountNavigator('sidebar://files')
    await shown(h)
    const panel = open(h)
    const restore = (): HTMLElement | null => within(panel).queryByRole('button', { name: zh['settings.restore'] })
    const add = within(panel).getByRole('textbox', { name: zh['settings.add'] })
    const rules = (): string[] => [...panel.querySelectorAll('[data-files-rule]')].map(row => row.getAttribute('data-files-rule')!)
    const defaults = rules()
    const type = (value: string): void => {
      act(() => { fireEvent.change(add, { target: { value } }) })
      act(() => { fireEvent.keyDown(add, { key: 'Enter' }) })
    }
    expect(restore()).toBeNull()
    // A custom path alone differs from the defaults.
    type('out')
    expect(restore()).not.toBeNull()
    act(() => { fireEvent.click(within(panel).getByRole('button', { name: t('settings.remove', { path: 'out' }) })) })
    expect(document.activeElement).toBe(add)
    expect(restore()).toBeNull()
    // A default added again moves to the top, so the order differs.
    type('dist')
    expect(rules()[0]).toBe('dist')
    expect(restore()).not.toBeNull()
    act(() => { fireEvent.click(within(panel).getByRole('button', { name: t('settings.remove', { path: 'node_modules' }) })) })
    act(() => { fireEvent.click(within(panel).getByRole('checkbox', { name: t('settings.toggle', { path: '.git' }) })) })
    type('out')
    act(() => { fireEvent.click(restore()!) })
    expect(document.activeElement).toBe(add)
    expect(restore()).toBeNull()
    expect(rules()).toEqual(defaults)
    expect(within(panel).getByRole('checkbox', { name: t('settings.toggle', { path: '.git' }) })).toHaveProperty('checked', true)
  })

  it('refuses an invalid path where it was typed, and adds a valid one at the top', async () => {
    const h = mountNavigator('sidebar://files')
    await shown(h)
    const panel = open(h)
    const add = within(panel).getByRole<HTMLInputElement>('textbox', { name: zh['settings.add'] })
    act(() => { fireEvent.change(add, { target: { value: '../x' } }) })
    act(() => { fireEvent.keyDown(add, { key: 'Enter' }) })
    expect(within(panel).getByRole('alert').textContent).toBe(zh['settings.invalid.parent'])
    expect(add.getAttribute('aria-invalid')).toBe('true')
    act(() => { fireEvent.change(add, { target: { value: 'tmp/' } }) })
    expect(within(panel).queryByRole('alert')).toBeNull()
    act(() => { fireEvent.keyDown(add, { key: 'a' }) })
    act(() => { fireEvent.keyDown(add, { key: 'Enter' }) })
    expect(add.value).toBe('')
    expect(panel.querySelector('[data-files-rule]')?.getAttribute('data-files-rule')).toBe('tmp')
  })

  it('saves only the rules on close, keeping a hidden-entry choice made while the panel was open', async () => {
    const h = mountNavigator('sidebar://files')
    await shown(h)
    const panel = open(h)
    act(() => { h.face.setSearchPreferences(ROOT, { showHidden: true }) })
    pointerClick(within(panel).getByRole('checkbox', { name: t('settings.toggle', { path: 'dist' }) }))
    pointerClick(within(panel).getByRole('button', { name: zh['settings.close'] }))
    expect(stored(h).showHidden).toBe(true)
    expect(stored(h).rules.find(rule => rule.path === 'dist')?.enabled).toBe(false)
  })

  it('saves the draft when the eye is clicked without losing the hidden-entry change', async () => {
    const h = mountNavigator('sidebar://files')
    await shown(h)
    const panel = open(h)
    pointerClick(within(panel).getByRole('checkbox', { name: t('settings.toggle', { path: 'dist' }) }))
    const eye = h.view.getByRole('button', { name: zh['search.showHidden'] })
    pointerClick(eye)
    expect(dialog(h)).toBeNull()
    expect(document.activeElement).toBe(eye)
    expect(eye.getAttribute('aria-pressed')).toBe('true')
    expect(stored(h).showHidden).toBe(true)
    expect(stored(h).rules.find(rule => rule.path === 'dist')?.enabled).toBe(false)
    expect(paths(h)).toContain(`${ROOT}/.env`)
    expect(within(open(h)).getByRole('checkbox', { name: t('settings.toggle', { path: 'dist' }) })).toHaveProperty('checked', false)
  })

  it('respects .gitignore until its checkbox is cleared, saving the choice at once and searching again with it', async () => {
    const h = mountNavigator('sidebar://files')
    await shown(h)
    await type(h, 'a')
    expect(requests(h)[0]?.respectGitignore).toBe(true)
    const panel = open(h)
    const gitignore = within(panel).getByRole<HTMLInputElement>('checkbox', { name: zh['settings.respectGitignore'] })
    expect(gitignore.checked).toBe(true)
    pointerClick(within(panel).getByRole('checkbox', { name: t('settings.toggle', { path: 'dist' }) }))
    pointerClick(gitignore)
    // Saved while the panel is open, unlike the rules, which wait for it to close.
    expect(gitignore.checked).toBe(false)
    expect(stored(h).respectGitignore).toBe(false)
    expect(stored(h).rules.find(rule => rule.path === 'dist')?.enabled).toBe(true)
    expect(requests(h)[1]).toMatchObject({ respectGitignore: false, excludedPaths: enabledPaths(defaultRules()) })
    expect(dialog(h)).not.toBeNull()
    pointerClick(within(panel).getByRole('button', { name: zh['settings.close'] }))
    expect(stored(h)).toMatchObject({ respectGitignore: false })
    expect(stored(h).rules.find(rule => rule.path === 'dist')?.enabled).toBe(false)
    expect(within(open(h)).getByRole('checkbox', { name: zh['settings.respectGitignore'] })).toHaveProperty('checked', false)
  })

  it('searches again with the saved rules when the panel closes during a search', async () => {
    const h = mountNavigator('sidebar://files')
    await shown(h)
    await type(h, 'a')
    const panel = open(h)
    pointerClick(within(panel).getByRole('checkbox', { name: t('settings.toggle', { path: 'dist' }) }))
    pointerClick(within(panel).getByRole('button', { name: zh['settings.close'] }))
    expect(requests(h)[1]?.excludedPaths).not.toContain('dist')
  })
})

describe('the keyboard', () => {
  it('walks from the field through the rows with ↓ and ↑, back to the field from the first row', async () => {
    const h = mountNavigator('sidebar://files')
    await shown(h)
    act(() => { field(h).focus() })
    const rows = [...body(h).querySelectorAll<HTMLElement>('[data-files-path] > div > button')]
    act(() => { fireEvent.keyDown(field(h), { key: 'ArrowUp' }) })
    expect(document.activeElement).toBe(field(h))
    act(() => { fireEvent.keyDown(field(h), { key: 'ArrowDown' }) })
    expect(document.activeElement).toBe(rows[0])
    act(() => { fireEvent.keyDown(rows[0]!, { key: 'ArrowDown' }) })
    expect(document.activeElement).toBe(rows[1])
    act(() => { fireEvent.keyDown(rows[1]!, { key: 'ArrowDown', shiftKey: true }) })
    expect(document.activeElement).toBe(rows[1])
    act(() => { fireEvent.keyDown(rows[1]!, { key: 'ArrowUp' }) })
    act(() => { fireEvent.keyDown(rows[0]!, { key: 'ArrowUp' }) })
    expect(document.activeElement).toBe(field(h))
    // Past the last row there is nowhere to go; the separator's arrows are its own.
    const last = rows.at(-1)!
    act(() => { last.focus() })
    act(() => { fireEvent.keyDown(last, { key: 'ArrowDown' }) })
    expect(document.activeElement).toBe(last)
    act(() => { fireEvent.keyDown(h.view.getByRole('separator'), { key: 'ArrowDown' }) })
    // The rows are buttons, so Enter opens a file as a click does.
    expect(last.tagName).toBe('BUTTON')
  })

  it('leaves ↓ to an input method composing text, and to a key someone in the navigator already handled', async () => {
    const h = mountNavigator('sidebar://files')
    await shown(h)
    act(() => { field(h).focus() })
    act(() => { fireEvent.keyDown(field(h), { key: 'ArrowDown', isComposing: true }) })
    expect(document.activeElement).toBe(field(h))
    const keep = (event: KeyboardEvent): void => { event.preventDefault() }
    field(h).addEventListener('keydown', keep)
    act(() => { fireEvent.keyDown(field(h), { key: 'ArrowDown' }) })
    field(h).removeEventListener('keydown', keep)
    expect(document.activeElement).toBe(field(h))
    act(() => { fireEvent.keyDown(field(h), { key: 'ArrowDown' }) })
    expect(document.activeElement).not.toBe(field(h))
  })

  it('closes the settings on Escape first, then clears the query, and only then lets the overlay close', async () => {
    const h = mountNavigator('sidebar://files')
    h.row.width = 480
    await shown(h)
    await type(h, 'a')
    act(() => { fireEvent.click(settingsButton(h)) })
    act(() => { fireEvent.keyDown(document.activeElement!, { key: 'Escape' }) })
    expect(dialog(h)).toBeNull()
    expect(field(h).value).toBe('a')
    // An Escape someone in the navigator already kept does not clear it.
    const keep = (event: KeyboardEvent): void => { event.preventDefault() }
    field(h).addEventListener('keydown', keep)
    act(() => { fireEvent.keyDown(field(h), { key: 'Escape' }) })
    field(h).removeEventListener('keydown', keep)
    expect(field(h).value).toBe('a')
    act(() => { fireEvent.keyDown(body(h), { key: 'Escape' }) })
    expect(field(h).value).toBe('')
    expect(document.activeElement).toBe(field(h))
    expect(h.view.container.querySelector('[data-files-navigator]')).not.toBeNull()
    act(() => { fireEvent.keyDown(field(h), { key: 'Escape' }) })
    expect(h.view.container.querySelector('[data-files-navigator]')).toBeNull()
  })

  it('keeps the keyboard where the reader moved it as the view switches to the results and back, each with its own scroll', async () => {
    const h = mountNavigator(A)
    await revealed(h)
    fireEvent.scroll(body(h), { target: { scrollTop: 64 } })
    const first = body(h).querySelector<HTMLElement>('[data-files-path] > div > button')!
    act(() => { first.focus() })
    act(() => { fireEvent.keyDown(first, { key: 'ArrowUp' }) })
    expect(document.activeElement).toBe(field(h))
    await type(h, 'b', ['src/b.ts'])
    await act(async () => { await Promise.resolve() })
    expect(document.activeElement).toBe(field(h))
    expect(body(h).getAttribute('data-files-view')).toBe('search')
    expect(body(h).scrollTop).toBe(0)
    act(() => { fireEvent.keyDown(field(h), { key: 'ArrowDown' }) })
    const result = document.activeElement
    expect(result?.closest('[data-files-path]')?.getAttribute('data-files-path')).toBe(`${ROOT}/src`)
    // Escape on a result row clears the text and hands the keyboard to the field.
    act(() => { fireEvent.keyDown(result!, { key: 'Escape' }) })
    await act(async () => { await Promise.resolve() })
    expect(document.activeElement).toBe(field(h))
    expect(body(h).getAttribute('data-files-view')).toBe('tree')
    expect(body(h).scrollTop).toBe(64)
  })

  it('carries the search field\'s keyboard focus to the pane\'s next drawing in the same task only', async () => {
    const h = mountNavigator('sidebar://files')
    await shown(h)
    act(() => { field(h).focus() })
    h.view.unmount()
    const back = h.remount()
    await act(async () => { await Promise.resolve() })
    expect(document.activeElement).toBe(within(back.container).getByRole('searchbox'))
    back.unmount()
    await act(async () => { await Promise.resolve() })
    h.remount()
    await act(async () => { await Promise.resolve() })
    expect(document.activeElement).toBe(document.body)
  })
})
