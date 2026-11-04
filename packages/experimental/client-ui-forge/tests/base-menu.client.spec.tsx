// @vitest-environment jsdom
/** The base branch picker: listing, searching, choosing, failures, and when its search field takes the keyboard. */
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { BaseMenu, type BaseMenuProps } from '../src/client/BaseMenu.tsx'
import css from '../src/client/BaseMenu.module.css'
import { en } from '../src/client/locales.ts'
import type { ForgeBaseBranch, ForgeBaseBranches } from '../src/types.ts'

const t = makeTranslate(en)
const MAIN: ForgeBaseBranch = { ref: 'refs/remotes/origin/main', name: 'origin/main' }
const RELEASE: ForgeBaseBranch = { ref: 'refs/remotes/origin/release/2.4', name: 'origin/release/2.4' }
const TOPIC: ForgeBaseBranch = { ref: 'refs/heads/topic', name: 'topic' }
const BRANCHES: ForgeBaseBranches = { automatic: { name: 'origin/main', worktree: false }, remote: [MAIN, RELEASE], local: [TOPIC] }
const FAILED: RemoteResult<ForgeBaseBranches> = { ok: false, error: new RemoteError('gateway/bad-request', 'failed', {}) }

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function ok(value: ForgeBaseBranches): RemoteResult<ForgeBaseBranches> {
  return { ok: true, value }
}

/** Let the listing reads the menu awaits settle, past the search delay when `ms` is given. */
async function settle(ms = 0): Promise<void> {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) })
}

function mount(props: Partial<BaseMenuProps> = {}) {
  const list = props.list ?? vi.fn<BaseMenuProps['list']>(async () => ok(BRANCHES))
  const choose = vi.fn<BaseMenuProps['choose']>()
  const all: BaseMenuProps = { chosen: null, label: 'origin/main', missing: false, visible: true, t, ...props, list, choose }
  const view = render(<BaseMenu {...all} />)
  const trigger = (): HTMLElement => view.getByRole('button', { name: `Base branch: ${all.label}` })
  const rows = (): string[] => view.queryAllByRole('menuitem').map(row => row.textContent ?? '')
  const search = (): HTMLElement => view.getByRole('textbox', { name: en['diff.base.search'] })
  const rerender = (next: Partial<BaseMenuProps>): void => { view.rerender(<BaseMenu {...all} {...next} />) }
  return { view, list, choose, trigger, rows, search, rerender }
}

describe('BaseMenu listing', () => {
  it('lists the automatic fork point first, then remote-tracking and local branches without repeating the default branch', async () => {
    const m = mount()
    fireEvent.click(m.trigger())
    expect(m.view.getByRole('status').textContent).toBe(en['diff.base.loading'])
    await settle()
    expect(m.list).toHaveBeenCalledWith('', expect.any(AbortSignal))
    expect(m.rows()).toEqual(['origin/mainDefault', 'origin/release/2.4', 'topic'])
    expect(m.view.getAllByRole('group').map(group => group.getAttribute('aria-label')))
      .toEqual([en['diff.base.automatic'], en['diff.base.remote'], en['diff.base.local']])
    expect(m.view.getByRole('menuitem', { name: /^origin\/main/ }).getAttribute('aria-current')).toBe('page')

    fireEvent.click(m.view.getByRole('menuitem', { name: 'topic' }))
    expect(m.choose).toHaveBeenCalledWith(TOPIC)
    expect(m.rows()).toEqual([])
  })

  it('names the start of a created worktree, keeps the branch of the same name, and leaves out a missing automatic fork point', async () => {
    const m = mount({ chosen: TOPIC, label: 'topic', list: vi.fn(async () => ok({ ...BRANCHES, automatic: { name: 'origin/main', worktree: true } })) })
    fireEvent.click(m.trigger())
    await settle()
    expect(m.rows()).toEqual(['origin/mainWorktree start', 'origin/main', 'origin/release/2.4', 'topic'])
    expect(m.view.getByRole('menuitem', { name: 'topic' }).getAttribute('aria-current')).toBe('page')
    fireEvent.click(m.view.getByRole('menuitem', { name: 'topic' }))
    expect(m.choose).not.toHaveBeenCalled()

    const without = mount({ label: 'Default', list: vi.fn(async () => ok({ ...BRANCHES, automatic: null })) })
    fireEvent.click(without.trigger())
    await settle()
    expect(without.rows()).toEqual(['origin/main', 'origin/release/2.4', 'topic'])
  })

  it('reports a failed listing with a retry', async () => {
    const m = mount({ list: vi.fn<BaseMenuProps['list']>().mockResolvedValueOnce(FAILED).mockResolvedValue(ok(BRANCHES)) })
    fireEvent.click(m.trigger())
    await settle()
    const status = m.view.getByRole('status')
    expect(status.textContent).toBe(`${en['toast.branchesFailed']}${en.retry}`)
    fireEvent.click(within(status).getByRole('button', { name: en.retry }))
    await settle()
    expect(m.list).toHaveBeenCalledTimes(2)
    expect(m.rows()).toHaveLength(3)
  })

  it('drops a listing that ends after the menu closed', async () => {
    let finish: (result: RemoteResult<ForgeBaseBranches>) => void = () => {}
    const list = vi.fn<BaseMenuProps['list']>().mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
      .mockImplementation(() => new Promise(() => {}))
    const m = mount({ list })
    fireEvent.click(m.trigger())
    await settle()
    fireEvent.click(m.trigger())
    await act(async () => { finish(ok(BRANCHES)) })
    fireEvent.click(m.trigger())
    await settle()
    expect(list.mock.calls[0]?.[1].aborted).toBe(true)
    expect(m.view.getByRole('status').textContent).toBe(en['diff.base.loading'])
  })
})

describe('BaseMenu search', () => {
  it('filters listed rows at once, reads the search after a pause, and picks the first match with Enter', async () => {
    const m = mount({
      list: vi.fn(async (query: string) => ok(query === '' ? BRANCHES : { automatic: BRANCHES.automatic, remote: [RELEASE], local: [] })),
    })
    fireEvent.click(m.trigger())
    await settle()
    fireEvent.change(m.search(), { target: { value: ' REL' } })
    expect(m.rows()).toEqual(['origin/release/2.4'])
    expect(m.list).not.toHaveBeenCalledWith(' REL', expect.any(AbortSignal))
    await settle(200)
    expect(m.list).toHaveBeenLastCalledWith(' REL', expect.any(AbortSignal))

    fireEvent.keyDown(m.search(), { key: 'Enter', isComposing: true })
    fireEvent.keyDown(m.search(), { key: 'a' })
    expect(m.choose).not.toHaveBeenCalled()
    fireEvent.keyDown(m.search(), { key: 'Enter' })
    expect(m.choose).toHaveBeenCalledWith(RELEASE)
  })

  it('says when no branch matches and keeps Enter from choosing', async () => {
    const m = mount()
    fireEvent.click(m.trigger())
    await settle()
    fireEvent.change(m.search(), { target: { value: 'hotfix' } })
    expect(m.view.getByText(en['diff.base.empty'])).toBeTruthy()
    fireEvent.keyDown(m.search(), { key: 'Enter' })
    expect(m.choose).not.toHaveBeenCalled()
    expect(m.view.getByText(en['diff.base.empty'])).toBeTruthy()
  })

  it('keeps caret keys in the search field instead of walking the rows', async () => {
    const m = mount()
    fireEvent.click(m.trigger())
    await settle()
    m.search().focus()
    for (const key of ['Home', 'End', 'ArrowLeft', 'ArrowRight']) {
      fireEvent.keyDown(m.search(), { key })
      expect(document.activeElement).toBe(m.search())
    }
  })
})

describe('BaseMenu trigger', () => {
  it('marks a missing branch, closes on a second press, and stays closed while its tab is hidden', async () => {
    const m = mount({ missing: true, label: 'topic', chosen: TOPIC })
    expect(m.trigger().classList.contains(css.missing ?? '')).toBe(true)
    expect(m.trigger().getAttribute('data-forge-base')).toBe(TOPIC.ref)
    fireEvent.click(m.trigger())
    await settle()
    expect(m.trigger().getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(m.trigger())
    expect(m.rows()).toEqual([])

    m.rerender({ visible: false })
    fireEvent.click(m.trigger())
    expect(m.trigger().getAttribute('aria-expanded')).toBe('false')
    expect(m.rows()).toEqual([])
    m.rerender({ visible: true })
    await settle()
    expect(m.rows()).toHaveLength(3)
  })

  it('gives the search field the keyboard one frame after opening, except on a touch screen', async () => {
    let frames = new Map<number, FrameRequestCallback>()
    let next = 0
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.set(++next, callback)
      return next
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => { frames.delete(id) })
    /** Run the frames queued so far; ones they queue wait for the next call. */
    const frame = (): void => {
      const queued = frames
      frames = new Map()
      act(() => { for (const callback of queued.values()) callback(0) })
    }
    const m = mount()
    fireEvent.click(m.trigger())
    expect(document.activeElement).not.toBe(m.search())
    frame()
    expect(document.activeElement).toBe(m.search())
    fireEvent.click(m.trigger())

    const matchMedia = vi.fn((_query: string) => ({ matches: true }))
    vi.stubGlobal('matchMedia', matchMedia)
    m.trigger().focus()
    fireEvent.click(m.trigger())
    frame()
    expect(matchMedia).toHaveBeenCalledWith('(pointer: coarse)')
    expect(document.activeElement).not.toBe(m.search())
    fireEvent.click(m.trigger())

    matchMedia.mockReturnValue({ matches: false })
    fireEvent.click(m.trigger())
    frame()
    expect(document.activeElement).toBe(m.search())
  })

  it('cancels the pending focus when the menu closes before its frame', async () => {
    const cancelled = vi.spyOn(window, 'cancelAnimationFrame')
    const m = mount()
    fireEvent.click(m.trigger())
    fireEvent.click(m.trigger())
    expect(cancelled).toHaveBeenCalled()
    await settle(50)
    expect(m.view.queryByRole('textbox')).toBeNull()
  })
})
