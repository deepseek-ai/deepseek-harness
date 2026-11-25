// @vitest-environment jsdom
/** The head picker: its groups, searching, choosing, failures, and which branches it leaves to a checkout's row. */
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { HeadMenu, type HeadMenuProps } from '../src/client/HeadMenu.tsx'
import type { ChangesHead } from '../src/client/changes-store.ts'
import css from '../src/client/BaseMenu.module.css'
import { en } from '../src/client/locales.ts'
import type { ForgeBaseBranch, ForgeBaseBranches, ForgeRelatedCheckout } from '../src/types.ts'

const t = makeTranslate(en)
const RELEASE: ForgeBaseBranch = { ref: 'refs/remotes/origin/release/2.4', name: 'origin/release/2.4' }
const TOPIC: ForgeBaseBranch = { ref: 'refs/heads/topic', name: 'topic' }
/** `cache` and `fix` are checked out by related Sessions; a remote-tracking branch may share a related checkout's short name. */
const BRANCHES: ForgeBaseBranches = {
  automatic: { name: 'origin/main', worktree: false },
  remote: [RELEASE, { ref: 'refs/remotes/cache', name: 'cache' }],
  local: [TOPIC, { ref: 'refs/heads/cache', name: 'cache' }],
}
const CACHE: ForgeRelatedCheckout = {
  sessionId: brandString<SessionId>('child-1'), root: '/work/repo/.agents/worktrees/cache', branch: 'cache', commit: 'abc1234',
  labels: ['Add a cache', 'Check the cache'],
}
const DETACHED: ForgeRelatedCheckout = {
  sessionId: brandString<SessionId>('child-2'), root: '/work/elsewhere', branch: null, commit: 'def5678', labels: ['Bisect the failure'],
}
const UNBORN: ForgeRelatedCheckout = { sessionId: brandString<SessionId>('child-3'), root: '/work/new', branch: null, commit: null, labels: ['Start over'] }
const CACHE_HEAD: ChangesHead = { kind: 'session', sessionId: CACHE.sessionId, name: 'cache', root: CACHE.root }
const TOPIC_HEAD: ChangesHead = { kind: 'branch', ref: TOPIC.ref, name: 'topic' }
const failed = <T,>(): RemoteResult<T> => ({ ok: false, error: new RemoteError('gateway/bad-request', 'failed', {}) })

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function ok<T>(value: T): RemoteResult<T> {
  return { ok: true, value }
}

/** Let the reads the menu awaits settle, past the search delay when `ms` is given. */
async function settle(ms = 0): Promise<void> {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) })
}

function mount(props: Partial<HeadMenuProps> = {}) {
  const list = props.list ?? vi.fn<HeadMenuProps['list']>(async () => ok(BRANCHES))
  const related = props.related ?? vi.fn<HeadMenuProps['related']>(async () => ok([CACHE, DETACHED]))
  const choose = vi.fn<HeadMenuProps['choose']>()
  const all: HeadMenuProps = { chosen: null, own: 'main', missing: false, visible: true, t, ...props, list, related, choose }
  const view = render(<HeadMenu {...all} />)
  const trigger = (): HTMLElement => view.getByRole('button', { name: `Branch shown: ${all.chosen?.name ?? all.own}` })
  const rows = (): string[] => view.queryAllByRole('menuitem').map(row => row.textContent ?? '')
  const groups = (): (string | null)[] => view.queryAllByRole('group').map(group => group.getAttribute('aria-label'))
  const search = (): HTMLElement => view.getByRole('searchbox', { name: en['diff.head.search'] })
  const rerender = (next: Partial<HeadMenuProps>): void => { view.rerender(<HeadMenu {...all} {...next} />) }
  return { view, list, related, choose, trigger, rows, groups, search, rerender }
}

describe('HeadMenu listing', () => {
  it('lists the own checkout, the related checkouts, then local and remote branches no listed checkout has', async () => {
    const m = mount()
    expect(m.trigger().getAttribute('data-forge-head')).toBe('')
    fireEvent.click(m.trigger())
    expect(m.view.getByRole('status').textContent).toBe(en['diff.base.loading'])
    await settle()
    expect(m.related).toHaveBeenCalledTimes(1)
    expect(m.list).toHaveBeenCalledWith('', expect.any(AbortSignal))
    expect(m.groups()).toEqual([en['diff.head.own'], en['diff.head.related'], en['diff.base.local'], en['diff.base.remote']])
    // The local `cache` branch is the related checkout's row; the remote-tracking branch of that name is another branch.
    expect(m.rows()).toEqual(['mainThis session', 'cacheAdd a cache · Check the cache', 'def5678Bisect the failure', 'topic', 'origin/release/2.4', 'cache'])
    expect(m.view.getByRole('menuitem', { name: /^main/ }).getAttribute('aria-current')).toBe('page')
    expect(m.view.getByText('Add a cache · Check the cache').parentElement?.getAttribute('title')).toBe(CACHE.root)
    expect(m.view.getByText(en['diff.head.note'])).toBeTruthy()

    fireEvent.click(m.view.getByRole('menuitem', { name: /^cache.*Add a cache/ }))
    expect(m.choose).toHaveBeenCalledWith(CACHE_HEAD)
    expect(m.rows()).toEqual([])
  })

  it('chooses a branch, the own checkout again, and nothing for the head already shown', async () => {
    const m = mount({ chosen: TOPIC_HEAD })
    expect(m.trigger().getAttribute('data-forge-head')).toBe('branch:refs/heads/topic')
    fireEvent.click(m.trigger())
    await settle()
    expect(m.view.getByRole('menuitem', { name: 'topic' }).getAttribute('aria-current')).toBe('page')
    fireEvent.click(m.view.getByRole('menuitem', { name: 'topic' }))
    expect(m.choose).not.toHaveBeenCalled()

    fireEvent.click(m.trigger())
    await settle()
    fireEvent.click(m.view.getByRole('menuitem', { name: /^main/ }))
    expect(m.choose).toHaveBeenLastCalledWith(null)

    fireEvent.click(m.trigger())
    await settle()
    fireEvent.click(m.view.getByRole('menuitem', { name: 'origin/release/2.4' }))
    expect(m.choose).toHaveBeenLastCalledWith({ kind: 'branch', ref: RELEASE.ref, name: RELEASE.name })
  })

  it('names a related checkout without a branch by its commit, then by HEAD, and marks a head that is gone', async () => {
    const m = mount({ chosen: CACHE_HEAD, missing: true, related: vi.fn(async () => ok([UNBORN])) })
    expect(m.trigger().classList.contains(css.missing ?? '')).toBe(true)
    expect(m.trigger().getAttribute('data-forge-head')).toBe('session:child-1')
    fireEvent.click(m.trigger())
    await settle()
    expect(m.rows()).toEqual(['mainThis session', 'HEADStart over', 'topic', 'cache', 'origin/release/2.4', 'cache'])
    fireEvent.click(m.view.getByRole('menuitem', { name: /^HEAD/ }))
    expect(m.choose).toHaveBeenCalledWith({ kind: 'session', sessionId: UNBORN.sessionId, name: 'HEAD', root: UNBORN.root })
  })

  it('shows no row until both listings arrived, and keeps a hidden tab closed', async () => {
    let finish: (result: RemoteResult<readonly ForgeRelatedCheckout[]>) => void = () => {}
    const related = vi.fn<HeadMenuProps['related']>(() => new Promise((resolve) => { finish = resolve }))
    const m = mount({ related })
    fireEvent.click(m.trigger())
    await settle()
    expect(m.rows()).toEqual([])
    expect(m.view.getByRole('status').textContent).toBe(en['diff.base.loading'])
    await act(async () => { finish(ok([])) })
    expect(m.groups()).toEqual([en['diff.head.own'], en['diff.base.local'], en['diff.base.remote']])

    m.rerender({ visible: false })
    expect(m.rows()).toEqual([])
    expect(related.mock.calls[0]?.[0].aborted).toBe(true)
  })

  it('reports either failed listing with a retry of both', async () => {
    const related = vi.fn<HeadMenuProps['related']>().mockResolvedValueOnce(failed()).mockResolvedValue(ok([CACHE]))
    const m = mount({ related })
    fireEvent.click(m.trigger())
    await settle()
    const status = m.view.getByRole('status')
    expect(status.textContent).toBe(`${en['toast.branchesFailed']}${en.retry}`)
    fireEvent.click(within(status).getByRole('button', { name: en.retry }))
    await settle()
    expect([related.mock.calls.length, vi.mocked(m.list).mock.calls.length]).toEqual([2, 2])
    expect(m.rows()).toEqual(['mainThis session', 'cacheAdd a cache · Check the cache', 'topic', 'origin/release/2.4', 'cache'])

    cleanup()
    const branches = mount({ list: vi.fn<HeadMenuProps['list']>().mockResolvedValue(failed()) })
    fireEvent.click(branches.trigger())
    await settle()
    expect(branches.view.getAllByRole('status').at(-1)?.textContent).toBe(`${en['toast.branchesFailed']}${en.retry}`)
  })
})

describe('HeadMenu search', () => {
  it('finds branches by name and related checkouts by branch, task, or directory, reading the branches after a pause', async () => {
    const m = mount({ list: vi.fn(async (query: string) => ok(query === '' ? BRANCHES : { automatic: null, remote: [RELEASE], local: [] })) })
    fireEvent.click(m.trigger())
    await settle()
    fireEvent.change(m.search(), { target: { value: ' REL' } })
    expect(m.rows()).toEqual(['origin/release/2.4'])
    expect(m.list).not.toHaveBeenCalledWith(' REL', expect.any(AbortSignal))
    await settle(200)
    expect(m.list).toHaveBeenLastCalledWith(' REL', expect.any(AbortSignal))
    // The related checkouts are read once per opening, whatever the search.
    expect(m.related).toHaveBeenCalledTimes(1)

    fireEvent.change(m.search(), { target: { value: 'bisect' } })
    expect(m.rows()).toEqual(['def5678Bisect the failure'])
    fireEvent.change(m.search(), { target: { value: 'elsewhere' } })
    expect(m.rows()).toEqual(['def5678Bisect the failure'])
    fireEvent.change(m.search(), { target: { value: 'mai' } })
    expect(m.rows()).toEqual(['mainThis session'])
  })

  it('says when nothing matches', async () => {
    const m = mount()
    fireEvent.click(m.trigger())
    await settle()
    fireEvent.change(m.search(), { target: { value: 'hotfix' } })
    expect(m.view.getByText(en['diff.head.empty'])).toBeTruthy()
    expect(m.rows()).toEqual([])
  })

  it('clears the search when the menu closes', async () => {
    const m = mount()
    fireEvent.click(m.trigger())
    await settle()
    fireEvent.change(m.search(), { target: { value: 'topic' } })
    fireEvent.click(m.trigger())
    fireEvent.click(m.trigger())
    await settle()
    expect((m.search() as HTMLInputElement).value).toBe('')
    expect(m.rows()).toHaveLength(6)
  })
})
