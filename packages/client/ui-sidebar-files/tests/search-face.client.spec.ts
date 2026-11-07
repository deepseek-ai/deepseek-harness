/** The face's search: when it runs, the preferences it follows, what it aborts and drops, and the store writes it makes. */
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { PaneId, TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { filesFace } from '../src/client/face.ts'
import type { WorkspaceSearchPreferenceBook } from '../src/client/search-preferences.ts'
import { defaultSearchPreferences, enabledPaths } from '../src/client/search-rules.ts'
import { createSearch } from '../src/client/search-workspace.ts'
import type { WorkspaceFilesSearchRemote } from '../src/client/search-workspace.ts'
import { createFilesStore } from '../src/client/store.ts'
import { scriptedList } from './scripted-list.client.ts'
import { answer, memoryBook, scriptedSearch, searchesSettled } from './search-fixture.client.ts'

const ROOT = '/work/app'
const PANE = 'pane-1' as PaneId
const CAN_OPEN = { getSnapshot: () => () => true, subscribe: () => () => {} }
/** No tab navigates. */
const NO_NAVIGATION = () => ({ getSnapshot: () => ({ address: '', params: undefined, revision: 0 }), subscribe: () => () => {} })

/** One Session's face over a shared book, with its pane attached. */
function session(id: string, book: WorkspaceSearchPreferenceBook) {
  const instance = createFilesStore().create()
  const script = scriptedList()
  const searches = scriptedSearch(['src/a.ts'])
  const face = filesFace(script.list, script.watch, CAN_OPEN, NO_NAVIGATION, searches.search, book)(
    id as SessionId, instance, () => () => {},
  )
  const tab = new AbortController()
  const release = face.attach(PANE, 'tab-1' as TabId, tab.signal)
  onTestFinished(async () => {
    release()
    tab.abort()
    await script.dispose()
  })
  return {
    instance, searches, search: searches.search, face, release, tab,
    state: () => instance.getSnapshot().byPane[PANE]?.search,
    result: () => instance.getSnapshot().byPane[PANE]?.search?.result,
  }
}

describe('the face\'s search', () => {
  it('searches nothing for a pane no navigator attached', () => {
    const h = session('s-1', memoryBook())
    h.face.setQuery('pane-2' as PaneId, ROOT, 'a')
    h.face.retrySearch('pane-2' as PaneId)
    expect(h.search).not.toHaveBeenCalled()
    expect(h.instance.getSnapshot().byPane['pane-2' as PaneId]).toBeUndefined()
    // A search field that goes after its pane was forgotten leaves nothing to record.
    h.face.searchDrawn('pane-2' as PaneId, null)
    expect(h.instance.getSnapshot().byPane['pane-2' as PaneId]).toBeUndefined()
  })

  it('asks the Host with the trimmed query and the workspace\'s preferences, pending until the answer draws the matches as a tree', async () => {
    const h = session('s-1', memoryBook())
    h.searches.answerWith(undefined)
    h.face.setQuery(PANE, ROOT, '  a ')
    expect(h.search).toHaveBeenCalledExactlyOnceWith('s-1', {
      query: 'a', excludedPaths: enabledPaths(defaultSearchPreferences().rules), includeHidden: false, respectGitignore: true,
    }, expect.any(AbortSignal))
    expect(h.state()).toEqual({ pending: true, result: undefined })
    h.searches.started[0]!.settle(answer(['src/a.ts'], { truncated: true, incomplete: true }))
    await searchesSettled()
    expect(h.state()?.pending).toBe(false)
    expect(h.result()).toMatchObject({
      kind: 'found', query: 'a', count: 1, truncated: true, incomplete: true, hiddenLeftOut: true, excluded: true,
      tree: { expanded: [ROOT, `${ROOT}/src`] },
    })
    // Whitespace around the same text searches nothing new.
    h.face.setQuery(PANE, ROOT, 'a')
    expect(h.search).toHaveBeenCalledOnce()
    expect(h.instance.getSnapshot().byPane[PANE]?.query).toBe('a')
  })

  it('aborts the running search when a newer one starts, keeping the last result drawn and dropping the older answer', async () => {
    const h = session('s-1', memoryBook())
    h.face.setQuery(PANE, ROOT, 'a')
    await searchesSettled()
    const first = h.result()
    h.searches.answerWith(undefined)
    h.face.setQuery(PANE, ROOT, 'ab')
    h.face.setQuery(PANE, ROOT, 'abc')
    const [, older, newer] = h.searches.started
    expect(older?.signal.aborted).toBe(true)
    expect(newer?.signal.aborted).toBe(false)
    expect(h.state()).toEqual({ pending: true, result: first })
    // The newer answer draws; the older one, arriving later, is dropped.
    newer!.settle(answer(['abc.ts']))
    await searchesSettled()
    older!.settle(answer(['ab.ts']))
    await searchesSettled()
    expect(h.result()).toMatchObject({ query: 'abc', count: 1 })
    expect(h.state()?.pending).toBe(false)
  })

  it('aborts a running search when the query is cleared or the pane is forgotten, and writes nothing for it', async () => {
    const h = session('s-1', memoryBook())
    h.searches.answerWith(undefined)
    h.face.setQuery(PANE, ROOT, 'a')
    const cleared = h.searches.started[0]!
    h.face.setQuery(PANE, ROOT, '')
    expect(cleared.signal.aborted).toBe(true)
    // Typing the same text again searches anew, and the dropped answer does not draw.
    h.face.setQuery(PANE, ROOT, 'a')
    cleared.settle(answer(['old.ts']))
    await searchesSettled()
    expect(h.state()).toEqual({ pending: true, result: undefined })

    const running = h.searches.started[1]!
    h.release()
    h.tab.abort()
    await searchesSettled()
    expect(running.signal.aborted).toBe(true)
    running.settle(answer(['late.ts']))
    await searchesSettled()
    expect(h.instance.getSnapshot().byPane[PANE]).toBeUndefined()
  })

  it('records a failed search as a failure, and searches again on retry', async () => {
    const h = session('s-1', memoryBook())
    h.searches.answerWith(undefined)
    h.face.setQuery(PANE, ROOT, 'a')
    const failure = new RemoteError('gateway/internal', 'host is gone', {})
    h.searches.started[0]!.settle({ ok: false, error: failure })
    await searchesSettled()
    expect(h.state()).toEqual({ pending: false, result: { kind: 'failed', query: 'a', failure } })
    h.face.retrySearch(PANE)
    expect(h.search).toHaveBeenCalledTimes(2)
    // A failure belongs to the query that failed, so a new search drops it instead of drawing it beside the spinner.
    expect(h.state()).toEqual({ pending: true, result: undefined })
    // A rejected call, which only an assembly fault causes, is reported rather than left pending.
    h.searches.started[1]!.reject(new Error('no search method'))
    await searchesSettled()
    expect(h.state()).toMatchObject({
      pending: false, result: { kind: 'failed', query: 'a', failure: { code: 'gateway/internal', message: 'no search method' } },
    })
    h.face.retrySearch(PANE)
    h.searches.started[2]!.reject('refused')
    await searchesSettled()
    expect(h.result()).toMatchObject({ kind: 'failed', failure: { message: 'refused' } })
    // Without a query there is nothing to retry.
    h.face.setQuery(PANE, ROOT, '')
    h.face.retrySearch(PANE)
    expect(h.search).toHaveBeenCalledTimes(3)
  })

  it('searches again on refresh while the pane has a query, and not once the query is blank', async () => {
    const h = session('s-1', memoryBook())
    h.face.setQuery(PANE, ROOT, 'a')
    await searchesSettled()
    expect(h.search).toHaveBeenCalledTimes(1)
    h.face.refresh(PANE)
    expect(h.search).toHaveBeenCalledTimes(2)
    expect(h.search).toHaveBeenLastCalledWith('s-1', expect.objectContaining({ query: 'a' }), expect.anything())
    h.face.setQuery(PANE, ROOT, '')
    h.face.refresh(PANE)
    expect(h.search).toHaveBeenCalledTimes(2)
  })

  it('follows one workspace\'s preferences, shared by every Session rooted there, until the query is blank', async () => {
    const book = memoryBook()
    const one = session('s-1', book)
    const two = session('s-2', book)
    const elsewhere = session('s-3', book)
    expect(two.face.keyedHooks.searchPreferences(ROOT)).toBe(one.face.keyedHooks.searchPreferences(`${ROOT}/`))
    two.face.setQuery(PANE, ROOT, 'a')
    elsewhere.face.setQuery(PANE, '/work/other', 'a')
    const before = one.face.keyedHooks.searchPreferences('/work/other').getSnapshot()
    one.face.setSearchPreferences(ROOT, { rules: [], showHidden: true })
    expect(two.search).toHaveBeenLastCalledWith(
      's-2', { query: 'a', excludedPaths: [], includeHidden: true, respectGitignore: true }, expect.any(AbortSignal),
    )
    await searchesSettled()
    expect(two.result()).toMatchObject({ hiddenLeftOut: false, excluded: false })
    expect(elsewhere.search).toHaveBeenCalledOnce()
    expect(one.face.keyedHooks.searchPreferences('/work/other').getSnapshot()).toBe(before)
    // The `.gitignore` choice is a preference like the others.
    one.face.setSearchPreferences(ROOT, { respectGitignore: false })
    expect(two.search).toHaveBeenLastCalledWith('s-2', expect.objectContaining({ respectGitignore: false }), expect.any(AbortSignal))
    // A change to another root's entry leaves this root's search alone.
    one.face.setSearchPreferences('/work/other', { ...defaultSearchPreferences(), rules: [] })
    expect(two.search).toHaveBeenCalledTimes(3)

    // A pane that moves to another root follows that root instead.
    two.face.setQuery(PANE, '/work/other', 'a')
    expect(two.search).toHaveBeenCalledTimes(4)
    one.face.setSearchPreferences(ROOT, defaultSearchPreferences())
    expect(two.search).toHaveBeenCalledTimes(4)

    two.face.setQuery(PANE, '/work/other', ' ')
    expect(two.state()).toBeUndefined()
    one.face.setSearchPreferences('/work/other', { ...defaultSearchPreferences(), showHidden: true })
    expect(two.search).toHaveBeenCalledTimes(4)
  })

  it('does not search again when the listed levels change under shown results', async () => {
    const h = session('s-1', memoryBook())
    h.instance.actions.start(PANE, ROOT)
    h.face.setQuery(PANE, ROOT, 'a')
    await searchesSettled()
    const shown = h.result()
    h.instance.actions.loaded(PANE, ROOT, { entries: [{ name: 'src', type: 'directory' }], truncated: false })
    await searchesSettled()
    expect(h.search).toHaveBeenCalledOnce()
    expect(h.result()).toBe(shown)
  })
})

describe('createSearch', () => {
  it('passes the session, the request, and the signal through, and returns the Host\'s answer or failure as it is', async () => {
    const search = vi.fn<WorkspaceFilesSearchRemote['workspaceFiles']['search']>()
    const value = { matches: [{ path: 'src/a.ts', type: 'file' as const }], truncated: false, incomplete: true }
    search.mockResolvedValueOnce({ ok: true, value })
    const request = { query: 'a', excludedPaths: ['dist'], includeHidden: false, respectGitignore: true }
    const signal = new AbortController().signal
    const bound = createSearch({ workspaceFiles: { search } })
    expect(await bound('s-1' as SessionId, request, signal)).toEqual({ ok: true, value })
    expect(search).toHaveBeenCalledWith('s-1', request, signal)
    const error = new RemoteError('gateway/internal', 'down', {})
    search.mockResolvedValueOnce({ ok: false, error })
    expect(await bound('s-1' as SessionId, request, signal)).toEqual({ ok: false, error })
  })
})
