// @vitest-environment jsdom
/** The head picker: its groups, the worktree mark, searching, choosing, and a failed listing. */
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { HeadMenu, type HeadMenuProps } from '../src/client/HeadMenu.tsx'
import type { ChangesHead } from '../src/client/changes-store.ts'
import css from '../src/client/BaseMenu.module.css'
import { en } from '../src/client/locales.ts'
import type { ForgeBaseBranch, ForgeBaseBranches } from '../src/types.ts'

const t = makeTranslate(en)
const RELEASE: ForgeBaseBranch = { ref: 'refs/remotes/origin/release/2.4', name: 'origin/release/2.4' }
const TOPIC: ForgeBaseBranch = { ref: 'refs/heads/topic', name: 'topic' }
/** `cache` is checked out in a worktree; the listing leaves out the Session's own checked-out branch. */
const CACHE: ForgeBaseBranch = { ref: 'refs/heads/cache', name: 'cache', worktree: '/work/repo/.agents/worktrees/cache' }
const BRANCHES: ForgeBaseBranches = { automatic: { name: 'origin/main', worktree: false }, remote: [RELEASE], local: [TOPIC, CACHE] }
const CACHE_HEAD: ChangesHead = { ref: CACHE.ref, name: 'cache', worktree: '/work/repo/.agents/worktrees/cache' }
const TOPIC_HEAD: ChangesHead = { ref: TOPIC.ref, name: 'topic', worktree: null }
const FAILED: RemoteResult<ForgeBaseBranches> = { ok: false, error: new RemoteError('gateway/bad-request', 'failed', {}) }

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function ok(value: ForgeBaseBranches): RemoteResult<ForgeBaseBranches> {
  return { ok: true, value }
}

/** Let the listing reads the menu awaits settle, past the search delay when `ms` is given. */
async function settle(ms = 0): Promise<void> {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) })
}

function mount(props: Partial<HeadMenuProps> = {}) {
  const list = props.list ?? vi.fn<HeadMenuProps['list']>(async () => ok(BRANCHES))
  const choose = vi.fn<HeadMenuProps['choose']>()
  const all: HeadMenuProps = { chosen: null, own: 'main', missing: false, visible: true, t, ...props, list, choose }
  const view = render(<HeadMenu {...all} />)
  const trigger = (): HTMLElement => view.getByRole('button', { name: `Branch shown: ${all.chosen?.name ?? all.own}` })
  const rows = (): string[] => view.queryAllByRole('menuitem').map(row => row.textContent ?? '')
  const groups = (): (string | null)[] => view.queryAllByRole('group').map(group => group.getAttribute('aria-label'))
  const search = (): HTMLElement => view.getByRole('searchbox', { name: en['diff.base.search'] })
  const rerender = (next: Partial<HeadMenuProps>): void => { view.rerender(<HeadMenu {...all} {...next} />) }
  return { view, list, choose, trigger, rows, groups, search, rerender }
}

describe('HeadMenu listing', () => {
  it('lists the own checkout, then local and remote branches, marking a branch a worktree has checked out', async () => {
    const m = mount()
    expect(m.trigger().getAttribute('data-forge-head')).toBe('')
    fireEvent.click(m.trigger())
    expect(m.view.getByRole('status').textContent).toBe(en['diff.base.loading'])
    await settle()
    expect(m.list).toHaveBeenCalledWith('', expect.any(AbortSignal))
    expect(m.groups()).toEqual([en['diff.head.own'], en['diff.base.local'], en['diff.base.remote']])
    expect(m.rows()).toEqual(['mainThis session', 'topic', 'cacheWorktree', 'origin/release/2.4'])
    expect(m.view.getByRole('menuitem', { name: /^main/ }).getAttribute('aria-current')).toBe('page')
    // The mark names the directory for the pointer; a branch read from its commits has neither.
    expect(m.view.getByText('Worktree').parentElement?.getAttribute('title')).toBe(CACHE.worktree)
    expect(m.view.getByText('topic').parentElement?.hasAttribute('title')).toBe(false)
    expect(m.view.getByText(en['diff.head.note'])).toBeTruthy()

    fireEvent.click(m.view.getByRole('menuitem', { name: /^cache/ }))
    expect(m.choose).toHaveBeenCalledWith(CACHE_HEAD)
    expect(m.rows()).toEqual([])
  })

  it('chooses a branch without a worktree, the own checkout again, and nothing for the head already shown', async () => {
    const m = mount({ chosen: TOPIC_HEAD })
    expect(m.trigger().getAttribute('data-forge-head')).toBe(TOPIC.ref)
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
    expect(m.choose).toHaveBeenLastCalledWith({ ref: RELEASE.ref, name: RELEASE.name, worktree: null })
  })

  it('marks a head that is gone, and keeps a hidden tab closed', async () => {
    const m = mount({ chosen: CACHE_HEAD, missing: true })
    expect(m.trigger().classList.contains(css.missing ?? '')).toBe(true)
    fireEvent.click(m.trigger())
    await settle()
    expect(m.rows()).toHaveLength(4)
    m.rerender({ chosen: CACHE_HEAD, missing: true, visible: false })
    expect(m.rows()).toEqual([])
  })

  it('reports a failed listing with a retry', async () => {
    const m = mount({ list: vi.fn<HeadMenuProps['list']>().mockResolvedValueOnce(FAILED).mockResolvedValue(ok(BRANCHES)) })
    fireEvent.click(m.trigger())
    await settle()
    const status = m.view.getByRole('status')
    expect(status.textContent).toBe(`${en['toast.branchesFailed']}${en.retry}`)
    fireEvent.click(within(status).getByRole('button', { name: en.retry }))
    await settle()
    expect(m.list).toHaveBeenCalledTimes(2)
    expect(m.rows()).toHaveLength(4)
  })
})

describe('HeadMenu search', () => {
  it('filters listed rows at once, reads the search after a pause, and finds the own checkout by its name', async () => {
    const m = mount({ list: vi.fn(async (query: string) => ok(query === '' ? BRANCHES : { automatic: null, remote: [RELEASE], local: [] })) })
    fireEvent.click(m.trigger())
    await settle()
    fireEvent.change(m.search(), { target: { value: ' REL' } })
    expect(m.rows()).toEqual(['origin/release/2.4'])
    expect(m.list).not.toHaveBeenCalledWith(' REL', expect.any(AbortSignal))
    await settle(200)
    expect(m.list).toHaveBeenLastCalledWith(' REL', expect.any(AbortSignal))

    fireEvent.change(m.search(), { target: { value: 'mai' } })
    expect(m.rows()).toEqual(['mainThis session'])
  })

  it('says when no branch matches, and clears the search when the menu closes', async () => {
    const m = mount()
    fireEvent.click(m.trigger())
    await settle()
    fireEvent.change(m.search(), { target: { value: 'hotfix' } })
    expect(m.view.getByText(en['diff.base.empty'])).toBeTruthy()
    expect(m.rows()).toEqual([])
    fireEvent.click(m.trigger())
    fireEvent.click(m.trigger())
    await settle()
    expect((m.search() as HTMLInputElement).value).toBe('')
    expect(m.rows()).toHaveLength(4)
  })
})
