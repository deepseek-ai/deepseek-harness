// @vitest-environment jsdom
/** The workspace search preferences kept in browser storage, read back without trusting what storage holds. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { createSearchPreferenceBook, SEARCH_PREFERENCES_KEY, workspaceKey } from '../src/client/search-preferences.ts'
import { defaultSearchPreferences } from '../src/client/search-rules.ts'

/** A book over browser storage, as the plugin's `apply` builds it. */
function persisted() {
  return createSearchPreferenceBook(createSnapshotStore<unknown>({}, { persist: { name: SEARCH_PREFERENCES_KEY } }))
}
const stored = (): unknown => JSON.parse(localStorage.getItem(SEARCH_PREFERENCES_KEY) ?? 'null')

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('workspaceKey', () => {
  it.each([
    ['/work/app', '/work/app'],
    ['/work/app/', '/work/app'],
    ['/work/app//', '/work/app'],
    ['/', '/'],
    ['C:\\work\\', 'C:\\work'],
    ['C:\\', 'C:\\'],
    ['C:/', 'C:/'],
    ['C:', 'C:'],
  ])('keys %s as %s', (cwd, key) => {
    expect(workspaceKey(cwd)).toBe(key)
  })
})

describe('createSearchPreferenceBook', () => {
  it('writes only the roots the reader changed, and drops a root changed back to the defaults', () => {
    const book = persisted()
    const chosen = { rules: [{ path: 'out', enabled: false }], showHidden: true, respectGitignore: false }
    book.update('/work/app/', chosen)
    book.update('/work/lib', { ...defaultSearchPreferences(), showHidden: true })
    expect(stored()).toEqual({ '/work/app': chosen, '/work/lib': { showHidden: true } })
    expect(book.source('/work/app').getSnapshot()).toEqual(chosen)
    book.update('/work/lib', defaultSearchPreferences())
    expect(stored()).toEqual({ '/work/app': chosen })
    expect(book.source('/work/never').getSnapshot()).toEqual(defaultSearchPreferences())
  })

  it('changes only the fields a patch names, over the root\'s preferences at the time of the change', () => {
    const book = persisted()
    book.update('/work/app', { showHidden: true })
    book.update('/work/app', { rules: [{ path: 'out', enabled: true }] })
    expect(book.source('/work/app').getSnapshot()).toEqual({ rules: [{ path: 'out', enabled: true }], showHidden: true, respectGitignore: true })
    book.update('/work/app', { showHidden: false })
    book.update('/work/app', { respectGitignore: false })
    expect(book.source('/work/app').getSnapshot()).toEqual({ rules: [{ path: 'out', enabled: true }], showHidden: false, respectGitignore: false })
    // A `.gitignore` choice alone differs from the defaults, so only it is stored.
    book.update('/work/app', { rules: defaultSearchPreferences().rules })
    expect(stored()).toEqual({ '/work/app': { respectGitignore: false } })
  })

  it('leaves the rules out of an entry whose rules the reader did not change, so the running build\'s default list applies', () => {
    persisted().update('/work/app', { showHidden: true })
    expect(stored()).toEqual({ '/work/app': { showHidden: true } })
    // An entry another build stored without rules reads the default list of this build.
    localStorage.setItem(SEARCH_PREFERENCES_KEY, JSON.stringify({ '/work/app': { showHidden: true, respectGitignore: false } }))
    expect(persisted().source('/work/app').getSnapshot()).toEqual({ ...defaultSearchPreferences(), showHidden: true, respectGitignore: false })
  })

  it('keeps each root\'s snapshot until that root changes', () => {
    const book = persisted()
    const app = book.source('/work/app')
    const first = app.getSnapshot()
    expect(app.getSnapshot()).toBe(first)
    const heard = vi.fn()
    const stop = app.subscribe(heard)
    book.update('/work/other', { rules: [], showHidden: false })
    expect(heard).toHaveBeenCalledTimes(1)
    expect(app.getSnapshot()).toBe(first)
    book.update('/work/app', { rules: [], showHidden: false })
    expect(app.getSnapshot()).not.toBe(first)
    stop()
  })

  it('reads back what an earlier session stored, and the default for each missing or malformed field', () => {
    localStorage.setItem(SEARCH_PREFERENCES_KEY, JSON.stringify({
      '/work/app': { rules: [{ path: 'out', enabled: true }, { path: '../x', enabled: true }], showHidden: true },
      '/work/lib': { rules: [], showHidden: false, respectGitignore: false },
      '/work/full': { ...defaultSearchPreferences(), showHidden: true },
      '/work/bad': { rules: 'dist', showHidden: true },
      '/work/odd': 7,
    }))
    const book = persisted()
    expect(book.source('/work/app').getSnapshot()).toEqual({ rules: [{ path: 'out', enabled: true }], showHidden: true, respectGitignore: true })
    expect(book.source('/work/lib').getSnapshot()).toEqual({ rules: [], showHidden: false, respectGitignore: false })
    // Saving an entry that stored every field keeps only those that differ from the defaults.
    book.update('/work/full', { showHidden: true })
    expect(stored()).toMatchObject({ '/work/full': { showHidden: true } })
    expect(book.source('/work/bad').getSnapshot()).toEqual({ ...defaultSearchPreferences(), showHidden: true })
    expect(book.source('/work/odd').getSnapshot()).toEqual(defaultSearchPreferences())
  })

  it.each([
    ['a JSON array', '[]'],
    ['a JSON string', '"oops"'],
    ['a JSON null', 'null'],
  ])('reads %s in storage as no preferences, and replaces it on the first change', (_label, raw) => {
    localStorage.setItem(SEARCH_PREFERENCES_KEY, raw)
    const book = persisted()
    expect(book.source('/work/app').getSnapshot()).toEqual(defaultSearchPreferences())
    book.update('/work/app', { rules: [], showHidden: false })
    expect(stored()).toEqual({ '/work/app': { rules: [] } })
  })

  it('reads storage that is not JSON as no preferences', () => {
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})
    localStorage.setItem(SEARCH_PREFERENCES_KEY, '{nope')
    expect(persisted().source('/work/app').getSnapshot()).toEqual(defaultSearchPreferences())
    expect(report).toHaveBeenCalledTimes(1)
  })
})
