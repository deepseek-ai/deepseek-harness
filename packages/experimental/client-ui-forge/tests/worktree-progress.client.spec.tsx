// @vitest-environment jsdom
/**
 * Worktree card: a running creation, which can be stopped while a message waits for it; the failed or stopped attempt a
 * message waits after; and a removed worktree.
 */
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en } from '../src/client/locales.ts'
import type { PanelSnapshot } from '../src/client/source.ts'
import { WorktreeProgress } from '../src/client/WorktreeProgress.tsx'
import css from '../src/client/WorktreeProgress.module.css'
import type { ForgePanelState } from '../src/types.ts'
import { created, creation, failure, ready, removed, requested, worktree } from './client-fixtures.client.ts'

afterEach(cleanup)

const t = makeTranslate(en)

function card(state: ForgePanelState | null) {
  const panel = createSnapshotStore<PanelSnapshot>({ state, disconnected: false })
  const stop = vi.fn<() => void>()
  const retry = vi.fn<() => void>()
  const withdraw = vi.fn<() => void>()
  const restore = vi.fn(async (): Promise<string | undefined> => undefined)
  const leave = vi.fn<() => void>()
  const view = render(
    <WorktreeProgress
      usePanel={bindSnapshotSelector(panel)}
      stop={stop}
      retry={retry}
      withdraw={withdraw}
      restore={restore}
      leave={leave}
      t={t}
    />,
  )
  const root = (): HTMLElement | null => view.container.querySelector<HTMLElement>('[data-forge-creation]')
  const publish = (next: ForgePanelState | null): void => {
    act(() => { panel.set({ state: next, disconnected: false }) })
  }
  return { view, stop, retry, withdraw, restore, leave, root, publish }
}

/** Glyph a step shows for its state. */
function glyph(step: Element): string {
  if (step.querySelector('svg[data-state="ongoing"]') !== null) return 'spinner'
  if (step.querySelector(`.${css.done}`) !== null) return 'check'
  if (step.querySelector(`.${css.failed}`) !== null) return 'cross'
  if (step.querySelector(`.${css.waiting}`) !== null) return 'ring'
  return 'none'
}

/** Label, state, and glyph of each step, in order. */
function steps(view: ReturnType<typeof render>): string[][] {
  return [...view.container.querySelectorAll('li')].map(step => [step.textContent, step.getAttribute('data-state') ?? '', glyph(step)])
}

/** Term and description pairs of the details, or null while they are hidden. */
function details(view: ReturnType<typeof render>): string[][] | null {
  const list = view.container.querySelector('dl')
  if (list === null) return null
  return [...list.querySelectorAll('dt')].map(term => [term.textContent, term.nextElementSibling?.textContent ?? ''])
}

/** Names of the action buttons the card offers, in order. */
function actions(view: ReturnType<typeof render>): string[] {
  const names = [en['creation.retry'], en['creation.skip'], en['creation.cancel']]
  return view.getAllByRole('button').map(button => button.textContent).filter(name => names.includes(name))
}

/** Whether a button rejects clicks. */
function disabled(button: HTMLElement): boolean {
  return button instanceof HTMLButtonElement && button.disabled
}

describe('WorktreeProgress visibility', () => {
  it.each([
    ['before the first state', null],
    ['while a request waits for the first message', requested()],
    ['while the Session works in the worktree it created', ready({ directory: '/work/repo-dsh', worktree: worktree({ created: created() }) })],
    ['for a removal the panel reports without the worktree record', ready({ worktree: worktree({ missing: { branchExists: true } }) })],
    ['for a failed attempt no message waits after', requested('main', { failure: failure() })],
  ])('renders nothing %s', (_label, state) => {
    expect(card(state).view.container.innerHTML).toBe('')
  })
})

describe('WorktreeProgress running creation', () => {
  it('follows the branch and steps of a creation a message waits for, which the user can stop', () => {
    const b = card(requested('release', { creation: creation({ from: 'release' }) }))
    expect(b.root()?.getAttribute('data-forge-creation')).toBe('prepare')
    const region = b.view.getByRole('region', { name: en['creation.title'] })
    expect(region.getAttribute('aria-busy')).toBe('true')
    expect(within(region).getByText(en['creation.title'])).toBeTruthy()
    expect(within(region).getByText('dsh/0a1b2c3d')).toBeTruthy()
    expect(steps(b.view)).toEqual([
      [en['creation.prepare'], 'running', 'spinner'],
      [en['creation.checkout'], 'waiting', 'ring'],
    ])
    expect(details(b.view)).toBeNull()
    expect(actions(b.view)).toEqual([en['creation.cancel']])

    b.publish(requested('release', { creation: creation({ from: 'release', phase: 'checkout' }) }))
    expect(b.root()?.getAttribute('data-forge-creation')).toBe('checkout')
    expect(steps(b.view)).toEqual([
      [en['creation.prepare'], 'done', 'check'],
      [en['creation.checkout'], 'running', 'spinner'],
    ])

    fireEvent.click(b.view.getByRole('button', { name: en['creation.cancel'] }))
    expect(b.stop).toHaveBeenCalledOnce()
    expect(b.withdraw).not.toHaveBeenCalled()
  })

  it('shows a creation at the first step without actions, because its message already entered the Session', () => {
    const b = card(requested('main', { creation: creation({ held: false }) }))
    expect(b.root()?.getAttribute('data-forge-creation')).toBe('prepare')
    expect(b.view.getByRole('region', { name: en['creation.title'] }).getAttribute('aria-busy')).toBe('true')
    expect(actions(b.view)).toEqual([])
    expect(b.view.getByRole('button', { name: en['creation.details'] })).toBeTruthy()
  })

  it('shows and hides the branch and its base under the disclosure', () => {
    const b = card(requested('main', { creation: creation() }))
    const disclosure = b.view.getByRole('button', { name: en['creation.details'] })
    expect(disclosure.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(disclosure)
    expect(disclosure.getAttribute('aria-expanded')).toBe('true')
    expect(details(b.view)).toEqual([
      [en['creation.branch'], 'dsh/0a1b2c3d'],
      [en['creation.base'], 'main'],
    ])
    fireEvent.click(disclosure)
    expect(disclosure.getAttribute('aria-expanded')).toBe('false')
    expect(details(b.view)).toBeNull()
  })

  it('names the current HEAD as the base of a creation from it', () => {
    const b = card(requested(null, { creation: creation({ from: null }) }))
    fireEvent.click(b.view.getByRole('button', { name: en['creation.details'] }))
    expect(details(b.view)).toEqual([
      [en['creation.branch'], 'dsh/0a1b2c3d'],
      [en['creation.base'], en['creation.head']],
    ])
  })

  it('disappears once the creation ends', () => {
    const b = card(requested('main', { creation: creation() }))
    b.publish(ready({ directory: '/work/repo-dsh', worktree: worktree({ created: created() }) }))
    expect(b.view.container.innerHTML).toBe('')
  })
})

describe('WorktreeProgress waiting after a failed attempt', () => {
  it.each([
    ['the preparation', 'prepare' as const, [
      [en['creation.prepare'], 'failed', 'cross'],
      [en['creation.checkout'], 'waiting', 'ring'],
    ]],
    ['the checkout', 'checkout' as const, [
      [en['creation.prepare'], 'done', 'check'],
      [en['creation.checkout'], 'failed', 'cross'],
    ]],
  ])('marks failed %s and shows the reason, that the message waits, and another attempt, without the disclosure', (_label, phase, expected) => {
    const b = card(requested('main', { failure: failure({ phase }), waiting: 'creation' }))
    expect(b.root()?.getAttribute('data-forge-creation')).toBe('failed')
    const region = b.view.getByRole('region', { name: en['creation.failed'] })
    expect(region.getAttribute('aria-busy')).toBe('false')
    expect(within(region).getByText(en['creation.failed'])).toBeTruthy()
    expect(steps(b.view)).toEqual(expected)
    expect(details(b.view)).toEqual([
      [en['creation.branch'], 'dsh/0a1b2c3d'],
      [en['creation.base'], 'main'],
      [en['creation.error'], 'fatal: invalid reference: main'],
    ])
    expect(within(region).getByText(en['creation.waiting'])).toBeTruthy()
    expect(b.view.queryByRole('button', { name: en['creation.details'] })).toBeNull()
    expect(actions(b.view)).toEqual([en['creation.retry'], en['creation.skip']])
  })

  it('names no branch for a failure that came before one, and the current HEAD as its base', () => {
    const b = card(requested(null, { failure: failure({ branch: null, from: null, message: 'connection lost' }), waiting: 'creation' }))
    const region = b.view.getByRole('region', { name: en['creation.failed'] })
    expect(within(region).queryByText('dsh/0a1b2c3d')).toBeNull()
    expect(details(b.view)).toEqual([
      [en['creation.base'], en['creation.head']],
      [en['creation.error'], 'connection lost'],
    ])
  })

  it('makes another attempt, or withdraws the request so the message goes on without a worktree', () => {
    const b = card(requested('main', { failure: failure(), waiting: 'creation' }))
    fireEvent.click(b.view.getByRole('button', { name: en['creation.retry'] }))
    fireEvent.click(b.view.getByRole('button', { name: en['creation.skip'] }))
    expect(b.retry).toHaveBeenCalledOnce()
    expect(b.withdraw).toHaveBeenCalledOnce()
    expect(b.stop).not.toHaveBeenCalled()
  })

  it('shows a stopped attempt without steps, with the request\'s base and the same choices', () => {
    const b = card(requested(null, { waiting: 'creation' }))
    expect(b.root()?.getAttribute('data-forge-creation')).toBe('stopped')
    const region = b.view.getByRole('region', { name: en['creation.stopped'] })
    expect(region.getAttribute('aria-busy')).toBe('false')
    expect(steps(b.view)).toEqual([])
    expect(details(b.view)).toBeNull()
    expect(within(region).getByText(en['creation.waiting'])).toBeTruthy()
    expect(actions(b.view)).toEqual([en['creation.retry'], en['creation.skip']])
  })

  it('collapses the details again when another attempt starts', () => {
    const b = card(requested('main', { failure: failure(), waiting: 'creation' }))
    expect(details(b.view)).not.toBeNull()
    b.publish(requested('main', { creation: creation(), waiting: 'creation' }))
    expect(b.root()?.getAttribute('data-forge-creation')).toBe('prepare')
    expect(details(b.view)).toBeNull()
    expect(b.view.getByRole('button', { name: en['creation.details'] }).getAttribute('aria-expanded')).toBe('false')
    expect(actions(b.view)).toEqual([en['creation.cancel']])
  })
})

describe('WorktreeProgress removed worktree', () => {
  it.each([
    ['cannot be inspected', null, t('missing.unknown', { branch: 'dsh/0a1b2c3d' })],
    ['still exists', true, t('missing.kept', { branch: 'dsh/0a1b2c3d' })],
    ['was removed too', false, t('missing.recreated', { branch: 'dsh/0a1b2c3d' })],
  ])('names the worktree and explains restoring it when its branch %s', (_label, branchExists, note) => {
    const b = card(removed(branchExists))
    expect(b.view.container.querySelector('[data-forge-missing]')).not.toBeNull()
    expect(b.root()).toBeNull()
    const region = b.view.getByRole('region', { name: en['missing.title'] })
    expect(within(region).getByText(en['missing.title'])).toBeTruthy()
    expect(within(region).getByText('dsh/0a1b2c3d')).toBeTruthy()
    expect(within(region).getByText(note)).toBeTruthy()
    expect(region.getAttribute('aria-busy')).toBeNull()
  })

  it('follows its own restoration from the click until the Host answers, starting at the first step', async () => {
    const b = card(removed())
    const answer = Promise.withResolvers<string | undefined>()
    b.restore.mockReturnValueOnce(answer.promise)

    fireEvent.click(b.view.getByRole('button', { name: en['missing.restore'] }))
    expect(b.restore).toHaveBeenCalledOnce()
    const region = b.view.getByRole('region', { name: en['restoration.title'] })
    expect(region.getAttribute('aria-busy')).toBe('true')
    expect(within(region).getByText('dsh/0a1b2c3d')).toBeTruthy()
    expect(steps(b.view)).toEqual([
      [en['restoration.prepare'], 'running', 'spinner'],
      [en['creation.checkout'], 'waiting', 'ring'],
    ])
    expect(b.view.queryByRole('button', { name: en['missing.leave'] })).toBeNull()

    await act(async () => { answer.resolve(undefined) })
    expect(b.view.getByRole('button', { name: en['missing.leave'] })).toBeTruthy()
    expect(b.view.container.querySelector(`.${css.error}`)).toBeNull()
  })

  it('follows the steps of a restoration that another surface started', () => {
    const b = card(removed(true, false, { restoration: { phase: 'checkout' } }))
    expect(b.view.container.querySelector('[data-forge-restoration]')?.getAttribute('data-forge-restoration')).toBe('checkout')
    expect(steps(b.view)).toEqual([
      [en['restoration.prepare'], 'done', 'check'],
      [en['creation.checkout'], 'running', 'spinner'],
    ])
    expect(b.view.queryByRole('button', { name: en['missing.restore'] })).toBeNull()
  })

  it('shows why a restore failed until the next attempt starts', async () => {
    const b = card(removed())
    const reason = 'fatal: \'/work/repo-dsh\' already exists'
    b.restore.mockResolvedValueOnce(reason)
    const restore = b.view.getByRole('button', { name: en['missing.restore'] })
    await act(async () => { fireEvent.click(restore) })
    expect(b.view.container.querySelector(`.${css.error}`)?.textContent).toBe(reason)
    expect(disabled(restore)).toBe(false)

    const retry = Promise.withResolvers<string | undefined>()
    b.restore.mockReturnValueOnce(retry.promise)
    fireEvent.click(restore)
    expect(b.view.getByRole('region', { name: en['restoration.title'] })).toBeTruthy()
    await act(async () => { retry.resolve(undefined) })
    expect(b.restore).toHaveBeenCalledTimes(2)
    expect(b.view.container.querySelector(`.${css.error}`)).toBeNull()
  })

  it.each([
    ['an error', new Error('connection lost'), 'connection lost'],
    ['another value', 'offline', 'offline'],
  ])('shows the reason when restoring throws %s and offers both actions again', async (_label, thrown, reason) => {
    const b = card(removed())
    b.restore.mockRejectedValueOnce(thrown)
    const restore = b.view.getByRole('button', { name: en['missing.restore'] })
    const leave = b.view.getByRole('button', { name: en['missing.leave'] })
    await act(async () => { fireEvent.click(restore) })
    expect(b.restore).toHaveBeenCalledOnce()
    expect(b.view.container.querySelector(`.${css.error}`)?.textContent).toBe(reason)
    expect([disabled(restore), disabled(leave)]).toEqual([false, false])
  })

  it('says that a waiting message goes on once the worktree is restored or left', () => {
    const waiting = card(removed(true, true))
    expect(within(waiting.view.getByRole('region', { name: en['missing.title'] })).getByText(en['missing.waiting'])).toBeTruthy()
    waiting.view.unmount()

    const idle = card(removed())
    expect(idle.view.queryByText(en['missing.waiting'])).toBeNull()
  })

  it('continues in the project', () => {
    const b = card(removed())
    fireEvent.click(b.view.getByRole('button', { name: en['missing.leave'] }))
    expect(b.leave).toHaveBeenCalledOnce()
    expect(b.restore).not.toHaveBeenCalled()
  })

  it('disappears once the worktree is back', () => {
    const b = card(removed())
    b.publish(ready({ directory: '/work/repo-dsh', worktree: worktree({ created: created() }) }, { root: '/work/repo-dsh', branch: 'dsh/0a1b2c3d' }))
    expect(b.view.container.innerHTML).toBe('')
  })
})
