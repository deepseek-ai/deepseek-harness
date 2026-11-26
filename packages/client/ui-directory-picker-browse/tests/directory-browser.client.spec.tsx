// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { DirectoryListing } from '@deepseek-ai/dsh-api-remotes/client'
import { DirectoryBrowser } from '../src/client/DirectoryBrowser.tsx'

afterEach(cleanup)

const HOME = '/home/u'
const DOCS = `${HOME}/Documents`
const HARNESS = `${DOCS}/harness`

/**
 * Listing fake over a tiny fixed tree; unknown paths reject like the Host.
 * A trailing separator is dropped the way the Host's own `resolve` drops it,
 * so a directory part typed into the path editor addresses its level.
 */
function listingFor(path?: string): DirectoryListing {
  const asked = path ?? HOME
  const target = asked.length > 1 && asked.endsWith('/') ? asked.slice(0, -1) : asked
  const tree: Record<string, DirectoryListing> = {
    [HOME]: {
      path: HOME,
      home: HOME,
      crumbs: [
        { name: '/', path: '/', hidden: false },
        { name: 'home', path: '/home', hidden: false },
        { name: 'u', path: HOME, hidden: false },
      ],
      entries: [
        { name: '.config', path: `${HOME}/.config`, hidden: true },
        { name: 'Documents', path: DOCS, hidden: false },
      ],
      truncated: false,
    },
    '/': {
      path: '/',
      home: HOME,
      crumbs: [{ name: '/', path: '/', hidden: false }],
      entries: [{ name: 'home', path: '/home', hidden: false }],
      truncated: false,
    },
    [`${HOME}/.config`]: {
      path: `${HOME}/.config`,
      home: HOME,
      crumbs: [
        { name: '/', path: '/', hidden: false },
        { name: 'home', path: '/home', hidden: false },
        { name: 'u', path: HOME, hidden: false },
        { name: '.config', path: `${HOME}/.config`, hidden: true },
      ],
      entries: [],
      truncated: false,
    },
    [DOCS]: {
      path: DOCS,
      home: HOME,
      crumbs: [
        { name: '/', path: '/', hidden: false },
        { name: 'home', path: '/home', hidden: false },
        { name: 'u', path: HOME, hidden: false },
        { name: 'Documents', path: DOCS, hidden: false },
      ],
      entries: [{ name: 'harness', path: HARNESS, hidden: false }],
      truncated: false,
    },
    [HARNESS]: {
      path: HARNESS,
      home: HOME,
      crumbs: [
        { name: '/', path: '/', hidden: false },
        { name: 'home', path: '/home', hidden: false },
        { name: 'u', path: HOME, hidden: false },
        { name: 'Documents', path: DOCS, hidden: false },
        { name: 'harness', path: HARNESS, hidden: false },
      ],
      entries: [],
      truncated: false,
    },
  }
  const found = tree[target]
  if (found === undefined) {
    throw new Error(`cannot list ${target}`)
  }
  return found
}

function mount(overrides: Partial<Parameters<typeof DirectoryBrowser>[0]> = {}) {
  const listDirectory = vi.fn(async (path?: string) => listingFor(path))
  const createDirectory = vi.fn(async (path: string, name: string) => `${path}/${name}`)
  const onOpen = vi.fn()
  const onClose = vi.fn()
  const props = {
    open: true,
    listDirectory,
    createDirectory,
    onOpen,
    onClose,
    busy: false,
    t: (key: string, params?: Record<string, unknown>) => (params === undefined ? key : `${key}:${String(params.name)}`),
    ...overrides,
  }
  const view = render(<DirectoryBrowser {...props} />)
  return { view, props, listDirectory, createDirectory, onOpen, onClose }
}

/** The rendered level columns, left-to-right. */
function columns(): HTMLElement[] {
  return screen.getAllByRole('list')
}

/** The actionable button inside a listitem seat (rows keep native button semantics). */
function rowButton(item: HTMLElement): HTMLButtonElement {
  return within(item).getByRole<HTMLButtonElement>('button')
}

describe('DirectoryBrowser', () => {
  it('renders nothing and launches no listing while initially closed', () => {
    const b = mount({ open: false })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(b.listDirectory).not.toHaveBeenCalled()
  })

  it('opens at the Host home as one wide column, hides hidden entries, and roots the crumbs at Home', async () => {
    const b = mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    expect(b.listDirectory).toHaveBeenCalledWith(undefined, expect.any(AbortSignal))
    expect(columns()).toHaveLength(1)
    expect(screen.getByRole('listitem').textContent).toBe('Documents')
    expect(screen.queryByText('.config')).toBeNull()
    expect(screen.getByRole('button', { name: 'browser.home' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '/' })).toBeNull()
  })

  it('shows hidden entries when the toggle is on and hides them again on close', async () => {
    const b = mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    expect(screen.queryByText('.config')).toBeNull()
    // The fixed-label toggle reports its state through aria-pressed. Its
    // mousedown never steals focus (so it composes with the path editor).
    const toggle = screen.getByRole('button', { name: 'browser.showHidden' })
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    fireEvent.mouseDown(toggle)
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText('.config')).toBeTruthy()
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    expect(screen.queryByText('.config')).toBeNull()
    // Close resets the toggle.
    b.view.rerender(<DirectoryBrowser {...b.props} open={false} />)
    b.view.rerender(<DirectoryBrowser {...b.props} open />)
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    expect(screen.queryByText('.config')).toBeNull()
  })

  it('selects a row into the two-pane view: children preview right, crumbs follow the selection', async () => {
    const b = mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(rowButton(screen.getByRole('listitem')))
    await waitFor(() => { expect(columns()).toHaveLength(2) })
    const [level, preview] = columns()
    const selectedRow = within(level!).getByRole('listitem')
    expect(selectedRow.textContent).toBe('Documents')
    expect(rowButton(selectedRow).getAttribute('aria-current')).toBe('true')
    expect(within(preview!).getByRole('listitem').textContent).toBe('harness')
    expect(b.listDirectory).toHaveBeenLastCalledWith(DOCS, expect.any(AbortSignal))
    expect(within(screen.getByRole('navigation')).getByRole('button', { name: 'Documents' })).toBeTruthy()
  })

  it('advances one level when a right-column row is picked', async () => {
    mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(rowButton(screen.getByRole('listitem')))
    await waitFor(() => { expect(columns()).toHaveLength(2) })
    fireEvent.click(rowButton(within(columns()[1]!).getByRole('listitem')))
    await waitFor(() => { expect(screen.getByRole('button', { name: 'harness' })).toBeTruthy() })
    const [level] = columns()
    const selectedRow = within(level!).getByRole('listitem')
    expect(selectedRow.textContent).toBe('harness')
    expect(rowButton(selectedRow).getAttribute('aria-current')).toBe('true')
  })

  it('aborts a superseded listing on the wire, and the in-flight one on close', async () => {
    const signals: (AbortSignal | undefined)[] = []
    const gates: (() => void)[] = []
    const listDirectory = vi.fn((path?: string, signal?: AbortSignal) => {
      signals.push(signal)
      if (signals.length === 1) return Promise.resolve(listingFor(path))
      // Later listings hang until released: supersession must abort them
      // on the wire, not merely discard their eventual results.
      return new Promise<DirectoryListing>((resolve) => { gates.push(() => { resolve(listingFor(path)) }) })
    })
    const b = mount({ listDirectory })
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(rowButton(screen.getByRole('listitem')))
    expect(signals).toHaveLength(2)
    // A crumb jump supersedes the hanging preview: its request aborts.
    fireEvent.click(screen.getByRole('button', { name: 'browser.home' }))
    expect(signals[1]?.aborted).toBe(true)
    expect(signals[2]?.aborted).toBe(false)
    // Closing the dialog aborts the still-pending navigation too.
    b.view.rerender(<DirectoryBrowser {...b.props} listDirectory={listDirectory} open={false} />)
    expect(signals[2]?.aborted).toBe(true)
  })

  it('a crumb jump to the display root (home) lands the single wide level', async () => {
    mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(rowButton(screen.getByRole('listitem')))
    await waitFor(() => { expect(columns()).toHaveLength(2) })
    fireEvent.click(screen.getByRole('button', { name: 'browser.home' }))
    await waitFor(() => { expect(columns()).toHaveLength(1) })
    expect(screen.getByRole('listitem').textContent).toBe('Documents')
    expect(rowButton(screen.getByRole('listitem')).getAttribute('aria-current')).toBeNull()
  })

  it('a crumb jump away from the root lands two-pane with the target selected', async () => {
    mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(rowButton(screen.getByRole('listitem')))
    await waitFor(() => { expect(columns()).toHaveLength(2) })
    fireEvent.click(rowButton(within(columns()[1]!).getByRole('listitem')))
    await waitFor(() => { expect(screen.getByRole('button', { name: 'harness' })).toBeTruthy() })
    // Jumping to the Documents crumb is a step BACK one pane, not a
    // collapse: Documents stays selected in the home level, its children
    // stay on the right.
    fireEvent.click(screen.getByRole('button', { name: 'Documents' }))
    await waitFor(() => {
      expect(rowButton(within(columns()[0]!).getByRole('listitem')).getAttribute('aria-current')).toBe('true')
    })
    expect(columns()).toHaveLength(2)
    expect(within(columns()[0]!).getByText('Documents')).toBeTruthy()
    expect(within(columns()[1]!).getByText('harness')).toBeTruthy()
  })

  it('a navigation to the filesystem root keeps the single wide level', async () => {
    mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'browser.editPath' }))
    fireEvent.change(screen.getByLabelText<HTMLInputElement>('browser.editPath'), { target: { value: '/' } })
    fireEvent.keyDown(screen.getByLabelText('browser.editPath'), { key: 'Enter' })
    // A one-crumb chain has no parent level to show on the left.
    await waitFor(() => { expect(screen.getByRole('listitem').textContent).toBe('home') })
    expect(columns()).toHaveLength(1)
  })

  it('lands the target single-pane at the wait bound, aborts a superseded parent leg on the wire, and drops its late resolution', async () => {
    vi.useFakeTimers()
    try {
      const signals: (AbortSignal | undefined)[] = []
      const settlers: ((value: DirectoryListing) => void)[] = []
      // Only the FIRST explicit HOME request (the parent leg) hangs; the
      // later home crumb jump lists normally.
      let homeCalls = 0
      const listDirectory = vi.fn((path?: string, signal?: AbortSignal) => {
        signals.push(signal)
        if (path === HOME && ++homeCalls === 1) {
          return new Promise<DirectoryListing>((resolve) => { settlers.push(resolve) })
        }
        return Promise.resolve(listingFor(path))
      })
      mount({ listDirectory })
      await act(async () => {})
      fireEvent.click(screen.getByRole('button', { name: 'browser.editPath' }))
      fireEvent.change(screen.getByLabelText<HTMLInputElement>('browser.editPath'), { target: { value: DOCS } })
      fireEvent.keyDown(screen.getByLabelText('browser.editPath'), { key: 'Enter' })
      // The target settled but the parent leg hangs: inside the wait bound
      // nothing commits yet.
      await act(async () => {})
      expect(settlers).toHaveLength(1)
      expect(screen.getByLabelText('browser.editPath', { selector: 'input' })).toBeTruthy()
      // The wait bound expires: the target commits alone — editor closed,
      // single-pane DOCS level.
      await act(async () => { vi.advanceTimersByTime(200) })
      expect(screen.getByRole('listitem').textContent).toBe('harness')
      expect(screen.queryByLabelText('browser.editPath', { selector: 'input' })).toBeNull()
      expect(columns()).toHaveLength(1)
      // A newer jump aborts the pending parent leg ON THE WIRE, not merely
      // dropping its settlement.
      fireEvent.click(screen.getByRole('button', { name: 'browser.home' }))
      expect(signals[2]?.aborted).toBe(true)
      await act(async () => {})
      expect(screen.getByRole('listitem').textContent).toBe('Documents')
      // Its late resolution changes nothing either.
      await act(async () => { settlers[0]!(listingFor(HOME)) })
      expect(columns()).toHaveLength(1)
      expect(rowButton(screen.getByRole('listitem')).getAttribute('aria-current')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  /**
   * Listing fake whose explicit-path scans stay pending until the test
   * settles them by path; the absent-path form (the initial home listing)
   * resolves normally so mounting is a one-flush setup.
   */
  function manualLister() {
    const settlers = new Map<string, (value: DirectoryListing) => void>()
    const listDirectory = vi.fn((path?: string, _signal?: AbortSignal) => {
      if (path === undefined) return Promise.resolve(listingFor(path))
      return new Promise<DirectoryListing>((resolve) => { settlers.set(path, resolve) })
    })
    return { settlers, listDirectory }
  }

  it('lands a navigation as ONE two-pane frame: the stale view holds until both legs arrive', async () => {
    vi.useFakeTimers()
    try {
      const { settlers, listDirectory } = manualLister()
      mount({ listDirectory })
      await act(async () => {})
      fireEvent.click(screen.getByRole('button', { name: 'browser.editPath' }))
      fireEvent.change(screen.getByLabelText<HTMLInputElement>('browser.editPath'), { target: { value: DOCS } })
      fireEvent.keyDown(screen.getByLabelText('browser.editPath'), { key: 'Enter' })
      // The target settles while the parent leg is still in flight: nothing
      // commits yet — the editor stays open over the stale home level, and no
      // single-pane DOCS frame ever renders.
      await act(async () => { settlers.get(DOCS)!(listingFor(DOCS)) })
      expect(screen.getByLabelText('browser.editPath', { selector: 'input' })).toBeTruthy()
      expect(screen.queryByText('harness')).toBeNull()
      // The parent leg settles inside the wait bound: one commit straight to
      // the two-pane landing, editor closed.
      await act(async () => { settlers.get(HOME)!(listingFor(HOME)) })
      expect(columns()).toHaveLength(2)
      expect(rowButton(within(columns()[0]!).getByRole('listitem')).getAttribute('aria-current')).toBe('true')
      expect(within(columns()[0]!).getByText('Documents')).toBeTruthy()
      expect(within(columns()[1]!).getByText('harness')).toBeTruthy()
      expect(screen.queryByLabelText('browser.editPath', { selector: 'input' })).toBeNull()
      // The wait-bound timer firing after the landing is a no-op.
      await act(async () => { vi.advanceTimersByTime(200) })
      expect(columns()).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a stalled parent leg lands the target alone at the wait bound, then upgrades in place', async () => {
    vi.useFakeTimers()
    try {
      const { settlers, listDirectory } = manualLister()
      mount({ listDirectory })
      await act(async () => {})
      fireEvent.click(screen.getByRole('button', { name: 'browser.editPath' }))
      fireEvent.change(screen.getByLabelText<HTMLInputElement>('browser.editPath'), { target: { value: DOCS } })
      fireEvent.keyDown(screen.getByLabelText('browser.editPath'), { key: 'Enter' })
      // The target can consume most of the outer scan's silence window.
      await act(async () => { vi.advanceTimersByTime(250) })
      await act(async () => { settlers.get(DOCS)!(listingFor(DOCS)) })
      // Its parent leg gets a fresh silence window. Crossing the original
      // scan's 300ms deadline therefore cannot flash the indicator during the
      // bounded landing wait.
      await act(async () => { vi.advanceTimersByTime(199) })
      expect(screen.queryByText('browser.loading')).toBeNull()
      // The parent leg outlives PARENT_LEG_WAIT_MS: the target lands alone.
      await act(async () => { vi.advanceTimersByTime(1) })
      expect(columns()).toHaveLength(1)
      expect(screen.getByRole('listitem').textContent).toBe('harness')
      expect(screen.queryByLabelText('browser.editPath', { selector: 'input' })).toBeNull()
      // The late parent leg still upgrades the landing in place, exactly as
      // if it had made the bound. (Reopening the editor meanwhile would
      // supersede the upgrade — the editor-open handler withdraws pending
      // listings — so a late upgrade can never close a resumed draft.)
      await act(async () => { settlers.get(HOME)!(listingFor(HOME)) })
      expect(columns()).toHaveLength(2)
      expect(rowButton(within(columns()[0]!).getByRole('listitem')).getAttribute('aria-current')).toBe('true')
      expect(within(columns()[1]!).getByText('harness')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('Escape inside the landing window withdraws the submitted navigation', async () => {
    vi.useFakeTimers()
    try {
      const { settlers, listDirectory } = manualLister()
      mount({ listDirectory })
      await act(async () => {})
      fireEvent.click(screen.getByRole('button', { name: 'browser.editPath' }))
      const input = screen.getByLabelText<HTMLInputElement>('browser.editPath')
      fireEvent.change(input, { target: { value: DOCS } })
      fireEvent.keyDown(input, { key: 'Enter' })
      await act(async () => { settlers.get(DOCS)!(listingFor(DOCS)) })
      // Nothing has committed yet; Escape supersedes the landing entirely.
      fireEvent.keyDown(input, { key: 'Escape' })
      await act(async () => { vi.advanceTimersByTime(200) })
      expect(columns()).toHaveLength(1)
      expect(screen.queryByText('harness')).toBeNull()
      expect(within(columns()[0]!).getByText('Documents')).toBeTruthy()
      expect(screen.queryByLabelText('browser.editPath', { selector: 'input' })).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows the loading indicator only once a scan outlives its silence window, floating over the stale view', async () => {
    vi.useFakeTimers()
    try {
      // The home level is truncated so its note is on screen when the slow
      // scan starts: dropping the note's old !loading guard means it must
      // keep rendering through the scan, coexisting with the indicator.
      const settlers = new Map<string, (value: DirectoryListing) => void>()
      const listDirectory = vi.fn((path?: string, _signal?: AbortSignal) => {
        if (path === undefined) return Promise.resolve({ ...listingFor(path), truncated: true })
        return new Promise<DirectoryListing>((resolve) => { settlers.set(path, resolve) })
      })
      mount({ listDirectory })
      await act(async () => {})
      expect(screen.queryByText('browser.loading')).toBeNull()
      expect(screen.getByText('browser.truncated')).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'browser.editPath' }))
      fireEvent.change(screen.getByLabelText<HTMLInputElement>('browser.editPath'), { target: { value: DOCS } })
      fireEvent.keyDown(screen.getByLabelText('browser.editPath'), { key: 'Enter' })
      // In flight but still inside the silence window: no indicator, and the
      // stale level's truncated note stays put (no layout churn on launch).
      expect(screen.queryByText('browser.loading')).toBeNull()
      expect(screen.getByText('browser.truncated')).toBeTruthy()
      await act(async () => { vi.advanceTimersByTime(300) })
      // Past it: the indicator floats while the stale level — truncated note
      // included — keeps rendering beneath it.
      expect(screen.getByText('browser.loading')).toBeTruthy()
      expect(screen.getByText('browser.truncated')).toBeTruthy()
      expect(screen.getByText('Documents')).toBeTruthy()
      // Landing (both legs) retires the indicator with the scan, and the
      // fresh listings' own truncated state replaces the stale note.
      await act(async () => { settlers.get(DOCS)!(listingFor(DOCS)) })
      await act(async () => { settlers.get(HOME)!(listingFor(HOME)) })
      expect(screen.queryByText('browser.loading')).toBeNull()
      expect(screen.queryByText('browser.truncated')).toBeNull()
      expect(columns()).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('restarts the silence window when a row pick supersedes a pending scan', async () => {
    vi.useFakeTimers()
    try {
      const pending: ((value: DirectoryListing) => void)[] = []
      const listDirectory = vi.fn((path?: string, _signal?: AbortSignal) => {
        if (path === undefined) return Promise.resolve(listingFor(path))
        return new Promise<DirectoryListing>((resolve) => { pending.push(resolve) })
      })
      mount({ listDirectory })
      await act(async () => {})
      const documents = rowButton(screen.getByRole('listitem'))
      fireEvent.click(documents)
      await act(async () => { vi.advanceTimersByTime(300) })
      expect(screen.getByText('browser.loading')).toBeTruthy()
      // The same row remains actionable while its preview is pending. A second
      // pick starts a new listing without a false `loading` edge.
      fireEvent.click(documents)
      expect(screen.queryByText('browser.loading')).toBeNull()
      await act(async () => { vi.advanceTimersByTime(299) })
      expect(screen.queryByText('browser.loading')).toBeNull()
      await act(async () => { vi.advanceTimersByTime(1) })
      expect(screen.getByText('browser.loading')).toBeTruthy()
      await act(async () => { pending.at(-1)!(listingFor(DOCS)) })
    } finally {
      vi.useRealTimers()
    }
  })

  it('a close mid-scan resets the slow-scan gate: reopening waits a fresh silence window', async () => {
    vi.useFakeTimers()
    try {
      // Every home listing hangs: the initial open's scan is the one the
      // close interrupts, and the reopen's scan proves the fresh window.
      const settlers: ((value: DirectoryListing) => void)[] = []
      const listDirectory = vi.fn((_path?: string, _signal?: AbortSignal) =>
        new Promise<DirectoryListing>((resolve) => { settlers.push(resolve) }))
      const { view, props } = mount({ listDirectory })
      await act(async () => { vi.advanceTimersByTime(300) })
      expect(screen.getByText('browser.loading')).toBeTruthy()
      // Close while the scan is in flight, then reopen: the first frame must
      // wait out a fresh silence window, not inherit the armed indicator.
      view.rerender(<DirectoryBrowser {...props} open={false} />)
      view.rerender(<DirectoryBrowser {...props} open />)
      await act(async () => {})
      expect(screen.queryByText('browser.loading')).toBeNull()
      await act(async () => { vi.advanceTimersByTime(300) })
      expect(screen.getByText('browser.loading')).toBeTruthy()
      // The reopened scan settles normally.
      await act(async () => { settlers.at(-1)!(listingFor(undefined)) })
      expect(screen.queryByText('browser.loading')).toBeNull()
      expect(screen.getByText('Documents')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the single-pane landing when the truncated parent level lacks the target', async () => {
    const listDirectory = vi.fn(async (path?: string) => {
      // The parent leg names HOME explicitly; serve it a truncated window
      // that misses Documents (the initial open uses the absent-path form).
      if (path === HOME) return { ...listingFor(HOME), entries: [], truncated: true }
      return listingFor(path)
    })
    mount({ listDirectory })
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'browser.editPath' }))
    fireEvent.change(screen.getByLabelText<HTMLInputElement>('browser.editPath'), { target: { value: DOCS } })
    fireEvent.keyDown(screen.getByLabelText('browser.editPath'), { key: 'Enter' })
    await waitFor(() => { expect(screen.getByRole('listitem').textContent).toBe('harness') })
    // The upgrade would orphan the selection (no source row): it stays off.
    await act(async () => {})
    expect(columns()).toHaveLength(1)
    expect(screen.queryByText('browser.truncated')).toBeNull()
  })

  it('anchors the upgrade on the parent level actual entry under Windows case folding', async () => {
    const ROOT = 'C:\\'
    const TYPED = 'c:\\users'
    const winRoot: DirectoryListing = {
      path: ROOT,
      home: ROOT,
      crumbs: [{ name: 'C:\\', path: ROOT, hidden: false }],
      entries: [{ name: 'Users', path: 'C:\\Users', hidden: false }],
      truncated: false,
    }
    const winUsers: DirectoryListing = {
      path: TYPED,
      home: ROOT,
      crumbs: [{ name: 'C:\\', path: ROOT, hidden: false }, { name: 'users', path: TYPED, hidden: false }],
      entries: [],
      truncated: false,
    }
    mount({ listDirectory: vi.fn(async (path?: string) => (path === TYPED ? winUsers : winRoot)) })
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'browser.editPath' }))
    fireEvent.change(screen.getByLabelText<HTMLInputElement>('browser.editPath'), { target: { value: TYPED } })
    fireEvent.keyDown(screen.getByLabelText('browser.editPath'), { key: 'Enter' })
    // The typed case differs from the real entry; the upgrade selects the
    // parent level's ACTUAL entry so aria-current and exemptions hold.
    await waitFor(() => {
      expect(rowButton(within(columns()[0]!).getByRole('listitem')).getAttribute('aria-current')).toBe('true')
    })
    expect(within(columns()[0]!).getByText('Users')).toBeTruthy()
  })

  it('re-parks focus on the edit zone when a failed pick unmounts a dot-revealed row', async () => {
    const listDirectory = vi.fn(async (path?: string) => {
      if (path === `${HOME}/.config`) {
        throw new Error('denied')
      }
      return listingFor(path)
    })
    mount({ listDirectory })
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'browser.editPath' }))
    fireEvent.change(screen.getByLabelText<HTMLInputElement>('browser.editPath'), { target: { value: `${HOME}/.co` } })
    const row = rowButton(screen.getByRole('listitem'))
    fireEvent.mouseDown(row)
    fireEvent.click(row)
    // The failed selection re-hides the picked row; focus fell to body and
    // re-parks on the crumb edit zone.
    await screen.findByRole('alert')
    expect(screen.queryByText('.config')).toBeNull()
    // The refocus effect is passive, so it can run after the commit that shows the alert.
    await waitFor(() => { expect(document.activeElement).toBe(screen.getByRole('button', { name: 'browser.editPath' })) })
  })

  it('leaves focus on a surviving row when its pick fails', async () => {
    const listDirectory = vi.fn(async (path?: string) => {
      if (path === DOCS) {
        throw new Error('denied')
      }
      return listingFor(path)
    })
    mount({ listDirectory })
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'browser.editPath' }))
    fireEvent.change(screen.getByLabelText<HTMLInputElement>('browser.editPath'), { target: { value: `${HOME}/do` } })
    const row = rowButton(screen.getByRole('listitem'))
    row.focus()
    fireEvent.mouseDown(row)
    fireEvent.click(row)
    // Documents survives the cleared selection (it is not hidden): the
    // user's focus on it is not yanked to the edit zone.
    await screen.findByRole('alert')
    expect(document.activeElement).toBe(row)
  })

  it('falls back to the single-pane landing when the parent leg of a navigation fails', async () => {
    const listDirectory = vi.fn(async (path?: string) => {
      // The initial open lists home through the absent-path form; only the
      // parent leg names HOME explicitly.
      if (path === HOME) {
        throw new Error('parent gone')
      }
      return listingFor(path)
    })
    mount({ listDirectory })
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'browser.editPath' }))
    fireEvent.change(screen.getByLabelText<HTMLInputElement>('browser.editPath'), { target: { value: DOCS } })
    fireEvent.keyDown(screen.getByLabelText('browser.editPath'), { key: 'Enter' })
    // The target listed fine; the failed parent leg neither blocks the
    // landing nor surfaces an error for a level nobody asked to see.
    await waitFor(() => { expect(screen.getByRole('listitem').textContent).toBe('harness') })
    expect(columns()).toHaveLength(1)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('opens the selection, else the listed level; Cancel closes; busy freezes Open', async () => {
    const b = mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'browser.open' }))
    expect(b.onOpen).toHaveBeenCalledWith(HOME)
    fireEvent.click(rowButton(screen.getByRole('listitem')))
    await waitFor(() => { expect(columns()).toHaveLength(2) })
    fireEvent.click(screen.getByRole('button', { name: 'browser.open' }))
    expect(b.onOpen).toHaveBeenLastCalledWith(DOCS)
    fireEvent.click(screen.getByRole('button', { name: 'browser.cancel' }))
    expect(b.onClose).toHaveBeenCalled()

    const busy = mount({ busy: true })
    await waitFor(() => { expect(busy.listDirectory).toHaveBeenCalled() })
    expect(screen.getAllByRole<HTMLButtonElement>('button', { name: 'browser.open' }).at(-1)!.disabled).toBe(true)
  })

  it('edits the path from the crumb bar: Enter navigates, Escape restores, blank is ignored', async () => {
    const b = mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'browser.editPath' }))
    const input = screen.getByLabelText<HTMLInputElement>('browser.editPath')
    // The editor seeds with a trailing separator so typing continues into
    // child names.
    expect(input.value).toBe(`${HOME}/`)
    fireEvent.change(input, { target: { value: DOCS } })
    fireEvent.keyDown(input, { key: 'Enter' })
    // Away from the root a navigation lands two-pane: the target selected
    // in its parent level, its own children on the right.
    await waitFor(() => { expect(columns()).toHaveLength(2) })
    expect(rowButton(within(columns()[0]!).getByRole('listitem')).getAttribute('aria-current')).toBe('true')
    expect(within(columns()[1]!).getByText('harness')).toBeTruthy()
    // The submitted navigation unmounted the focused input; focus parks on
    // the crumb edit zone that replaced it.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'browser.editPath' }))
    fireEvent.click(screen.getByRole('button', { name: 'browser.editPath' }))
    const again = screen.getByLabelText<HTMLInputElement>('browser.editPath')
    fireEvent.change(again, { target: { value: '   ' } })
    fireEvent.keyDown(again, { key: 'Enter' })
    // Initial home + the DOCS target leg + its parent leg; the blank draft
    // added none.
    expect(b.listDirectory).toHaveBeenCalledTimes(3)
    fireEvent.keyDown(again, { key: 'Escape' })
    expect(screen.queryByLabelText('browser.editPath', { selector: 'input' })).toBeNull()
    // Escape with focus in the input parks focus on the returning edit zone.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'browser.editPath' }))
  })

  it('prefix-filters the listed level from the draft tail, dot revealing hidden matches', async () => {
    const b = mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'browser.editPath' }))
    const input = screen.getByLabelText<HTMLInputElement>('browser.editPath')
    // The seeded empty segment leaves the level as-is: hidden stays hidden.
    expect(screen.getByRole('listitem').textContent).toBe('Documents')
    // Case-insensitive prefix narrows the rows.
    fireEvent.change(input, { target: { value: `${HOME}/do` } })
    expect(screen.getByRole('listitem').textContent).toBe('Documents')
    // A dot-led prefix names hidden entries, so it reveals the match.
    fireEvent.change(input, { target: { value: `${HOME}/.co` } })
    expect(screen.getByRole('listitem').textContent).toBe('.config')
    // A prefix nobody matches releases the filter: the level shows whole
    // (hidden rows back under the toggle) instead of emptying under a name
    // the operator is still spelling.
    fireEvent.change(input, { target: { value: `${HOME}/zzz` } })
    expect(screen.getAllByRole('listitem').map(item => item.textContent)).toEqual(['Documents'])
    // Its dot-led reveal lapses with it.
    fireEvent.change(input, { target: { value: `${HOME}/.zzz` } })
    expect(screen.getAllByRole('listitem').map(item => item.textContent)).toEqual(['Documents'])
    // A tail inside the listed level names no level to walk to: the wait
    // fires and finds nothing to scan.
    const settled = b.listDirectory.mock.calls.length
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 400) }) })
    expect(b.listDirectory.mock.calls).toHaveLength(settled)
    // A draft naming some other directory (or none) leaves the level whole —
    // and a draft with no separator at all addresses no directory either.
    fireEvent.change(input, { target: { value: 'no-separator' } })
    expect(screen.getByRole('listitem').textContent).toBe('Documents')
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 400) }) })
    expect(b.listDirectory.mock.calls).toHaveLength(settled)
  })

  it('filters the child pane in two-pane mode and follows the draft back up a level', async () => {
    const b = mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(rowButton(screen.getByRole('listitem')))
    await waitFor(() => { expect(columns()).toHaveLength(2) })
    fireEvent.click(screen.getByRole('button', { name: 'browser.editPath' }))
    const input = screen.getByLabelText<HTMLInputElement>('browser.editPath')
    // The seed comes from the selection, so the draft tail addresses the
    // RIGHT pane (the selection's children).
    expect(input.value).toBe(`${DOCS}/`)
    fireEvent.change(input, { target: { value: `${DOCS}/h` } })
    expect(within(columns()[1]!).getByText('harness')).toBeTruthy()
    // The child pane already lists that directory: no scan follows, and both
    // panes stay.
    const settled = b.listDirectory.mock.calls.length
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 400) }) })
    expect(b.listDirectory.mock.calls).toHaveLength(settled)
    expect(columns()).toHaveLength(2)
    // A miss releases the right pane's filter rather than emptying it.
    fireEvent.change(input, { target: { value: `${DOCS}/zzz` } })
    expect(within(columns()[1]!).getByText('harness')).toBeTruthy()
    expect(within(columns()[0]!).getByText('Documents')).toBeTruthy()
    // Erasing back into the parent's own path re-lands on it rather than
    // filtering the LEFT pane: the level being typed is always the last pane,
    // never a pane with a deeper level standing to its right. Home is the
    // display root, so it lands alone.
    fireEvent.change(input, { target: { value: `${HOME}/zz` } })
    await waitFor(() => { expect(columns()).toHaveLength(1) })
    expect(screen.getAllByRole('listitem').map(item => item.textContent)).toEqual(['Documents'])
  })

  it('follows the draft into a directory no pane lists, landing the two-pane Miller view', async () => {
    const b = mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    expect(columns()).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'browser.editPath' }))
    const input = screen.getByLabelText<HTMLInputElement>('browser.editPath')
    // Typing past a separator addresses a level nobody shows: the panes walk
    // to it once the typing rests, landing the ordinary selection-anchored
    // two-pane view (level | its children) with the tail filtering the right
    // pane — a typed path moves the Miller view exactly as a crumb jump does.
    fireEvent.change(input, { target: { value: `${DOCS}/h` } })
    await waitFor(() => { expect(columns()).toHaveLength(2) })
    expect(b.listDirectory).toHaveBeenCalledWith(`${DOCS}/`, expect.anything())
    expect(within(columns()[0]!).getByText('Documents')).toBeTruthy()
    expect(within(columns()[1]!).getByText('harness')).toBeTruthy()
    // Still editing: the panes moved under the draft, the editor stayed.
    expect(screen.getByLabelText<HTMLInputElement>('browser.editPath').value).toBe(`${DOCS}/h`)
    // Typing on inside a level the panes already list costs no scan at all:
    // the prefix filter alone answers the draft, both panes stay.
    const settled = b.listDirectory.mock.calls.length
    fireEvent.change(input, { target: { value: `${DOCS}/ha` } })
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 400) }) })
    expect(b.listDirectory.mock.calls).toHaveLength(settled)
    expect(columns()).toHaveLength(2)
  })

  it('keeps the typed level in the last pane, its parent beside it, as the draft walks', async () => {
    const b = mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'browser.editPath' }))
    const input = screen.getByLabelText<HTMLInputElement>('browser.editPath')
    // Two levels down: the typed level on the right, its parent on the left.
    fireEvent.change(input, { target: { value: `${HARNESS}/` } })
    await waitFor(() => { expect(within(columns()[0]!).getByText('harness')).toBeTruthy() })
    expect(columns()).toHaveLength(2)
    expect(within(columns()[1]!).queryAllByRole('listitem')).toHaveLength(0)
    // Erasing back to the parent's own path re-lands on it: the level being
    // typed moves BACK into the last pane instead of staying on the left with
    // its own child pane still to the right.
    fireEvent.change(input, { target: { value: `${DOCS}/ha` } })
    await waitFor(() => { expect(within(columns()[0]!).getByText('Documents')).toBeTruthy() })
    expect(columns()).toHaveLength(2)
    expect(within(columns()[1]!).getAllByRole('listitem').map(item => item.textContent)).toEqual(['harness'])
    expect(b.listDirectory).toHaveBeenCalledWith(`${DOCS}/`, expect.anything())
  })

  it('holds a stale pane still until its landing, instead of narrowing it first', async () => {
    // Own three-level tree: the level that goes stale needs two rows for the
    // narrowing this pins against to be visible at all.
    const ROOT = '/u'
    const MID = `${ROOT}/mid`
    const LEAF = `${MID}/leaf`
    const chain = [{ name: '/', path: '/', hidden: false }, { name: 'u', path: ROOT, hidden: false }]
    const tree: Record<string, DirectoryListing> = {
      [ROOT]: {
        path: ROOT,
        home: ROOT,
        crumbs: chain,
        entries: [{ name: 'mid', path: MID, hidden: false }, { name: 'other', path: `${ROOT}/other`, hidden: false }],
        truncated: false,
      },
      [MID]: {
        path: MID,
        home: ROOT,
        crumbs: [...chain, { name: 'mid', path: MID, hidden: false }],
        entries: [{ name: 'leaf', path: LEAF, hidden: false }, { name: 'sibling', path: `${MID}/sibling`, hidden: false }],
        truncated: false,
      },
      [LEAF]: {
        path: LEAF,
        home: ROOT,
        crumbs: [...chain, { name: 'mid', path: MID, hidden: false }, { name: 'leaf', path: LEAF, hidden: false }],
        entries: [],
        truncated: false,
      },
    }
    mount({
      listDirectory: vi.fn(async (path?: string) => {
        const asked = path ?? ROOT
        const found = tree[asked.length > 1 && asked.endsWith('/') ? asked.slice(0, -1) : asked]
        if (found === undefined) throw new Error(`cannot list ${asked}`)
        return found
      }),
    })
    await waitFor(() => { expect(screen.getByText('mid')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'browser.editPath' }))
    const input = screen.getByLabelText<HTMLInputElement>('browser.editPath')
    fireEvent.change(input, { target: { value: `${LEAF}/` } })
    await waitFor(() => { expect(columns()).toHaveLength(2) })
    expect(within(columns()[0]!).getAllByRole('listitem').map(item => item.textContent)).toEqual(['leaf', 'sibling'])
    // Deleting the separator names the level the LEFT pane lists. That pane
    // is stale — its landing will move it right — so it must not narrow to
    // the tail first: one deletion, one movement.
    fireEvent.change(input, { target: { value: LEAF } })
    expect(within(columns()[0]!).getAllByRole('listitem').map(item => item.textContent)).toEqual(['leaf', 'sibling'])
    await waitFor(() => { expect(within(columns()[0]!).getByText('other')).toBeTruthy() })
    expect(within(columns()[1]!).getAllByRole('listitem').map(item => item.textContent)).toEqual(['leaf'])
  })

  it('keeps the walked-to panes when the editor is cancelled, Open adopting where the walk ended', async () => {
    const b = mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'browser.editPath' }))
    const input = screen.getByLabelText<HTMLInputElement>('browser.editPath')
    fireEvent.change(input, { target: { value: `${DOCS}/h` } })
    await waitFor(() => { expect(columns()).toHaveLength(2) })
    fireEvent.keyDown(input, { key: 'Escape' })
    // Cancel closes the editor; it does not rewind the walk. The operator
    // watched the panes move, so the crumbs, the panes, and Open's target all
    // stay where the walk ended.
    expect(screen.queryByLabelText('browser.editPath', { selector: 'input' })).toBeNull()
    expect(columns()).toHaveLength(2)
    expect(within(columns()[0]!).getByText('Documents')).toBeTruthy()
    expect(within(columns()[1]!).getByText('harness')).toBeTruthy()
    expect(screen.getByRole('navigation').textContent).toContain('Documents')
    const open = screen.getByRole<HTMLButtonElement>('button', { name: 'browser.open' })
    expect(open.disabled).toBe(false)
    fireEvent.click(open)
    expect(b.onOpen).toHaveBeenCalledWith(DOCS)
  })

  it('waits both legs out for a walk: one keystroke never flashes a single pane', async () => {
    let landParent = (): void => {}
    const listDirectory = vi.fn(async (path?: string) => {
      // The parent leg outlives the submitted-navigation wait bound; a walk
      // has nothing waiting on it, so it holds the stale view instead of
      // landing single-pane and upgrading.
      if (path === HOME) return await new Promise<DirectoryListing>((resolve) => { landParent = () => { resolve(listingFor(HOME)) } })
      return listingFor(path)
    })
    mount({ listDirectory })
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'browser.editPath' }))
    const input = screen.getByLabelText<HTMLInputElement>('browser.editPath')
    fireEvent.change(input, { target: { value: `${DOCS}/h` } })
    await waitFor(() => { expect(listDirectory).toHaveBeenCalledWith(HOME, expect.anything()) })
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 400) }) })
    // Well past the submitted-navigation bound: still the pre-walk view.
    expect(columns()).toHaveLength(1)
    expect(screen.getByText('Documents')).toBeTruthy()
    await act(async () => { landParent() })
    await waitFor(() => { expect(columns()).toHaveLength(2) })
    expect(within(columns()[1]!).getByText('harness')).toBeTruthy()
  })

  it('walks the panes back up when erased segments leave the listed levels', async () => {
    const b = mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'browser.editPath' }))
    const input = screen.getByLabelText<HTMLInputElement>('browser.editPath')
    fireEvent.change(input, { target: { value: `${DOCS}/h` } })
    await waitFor(() => { expect(columns()).toHaveLength(2) })
    // Erasing back to a directory neither pane lists walks up to it; the
    // filesystem root is the display root, so it lands the single wide level
    // with the tail filtering it.
    fireEvent.change(input, { target: { value: '/ho' } })
    await waitFor(() => { expect(columns()).toHaveLength(1) })
    expect(b.listDirectory).toHaveBeenCalledWith('/', expect.anything())
    expect(screen.getAllByRole('listitem').map(item => item.textContent)).toEqual(['home'])
  })

  it('re-arms the draft-following scan after a keystroke superseded one in flight', async () => {
    let started = 0
    const listDirectory = vi.fn(async (path?: string) => {
      if (path !== `${DOCS}/`) return listingFor(path)
      started += 1
      // The first scan never settles: the next keystroke aborts it, and only
      // a re-armed wait can still land the level the draft names.
      if (started === 1) return await new Promise<DirectoryListing>(() => {})
      return listingFor(path)
    })
    mount({ listDirectory })
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'browser.editPath' }))
    const input = screen.getByLabelText<HTMLInputElement>('browser.editPath')
    fireEvent.change(input, { target: { value: `${DOCS}/h` } })
    await waitFor(() => { expect(started).toBe(1) })
    // A further tail keystroke supersedes the in-flight scan; the panes must
    // still follow, not sit on the stale level until a separator is typed.
    fireEvent.change(input, { target: { value: `${DOCS}/ha` } })
    await waitFor(() => { expect(screen.getByText('harness')).toBeTruthy() })
  })

  it('follows the draft again after an edit releases a failed submission hold', async () => {
    const listDirectory = vi.fn(async (path?: string) => {
      if (path === HARNESS) throw new Error('target unreadable')
      return listingFor(path)
    })
    mount({ listDirectory })
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'browser.editPath' }))
    const input = screen.getByLabelText<HTMLInputElement>('browser.editPath')
    // Submitting inside the debounce window holds the pending scan back.
    fireEvent.change(input, { target: { value: HARNESS } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('target unreadable') })
    // Correcting only the final segment leaves the directory part unchanged;
    // the edit must still release the hold and re-arm the wait.
    fireEvent.change(input, { target: { value: `${HARNESS}x` } })
    await waitFor(() => { expect(listDirectory).toHaveBeenCalledWith(`${DOCS}/`, expect.anything()) })
    await waitFor(() => { expect(screen.getByText('harness')).toBeTruthy() })
  })

  it('re-parks focus on the editor when a landed scan unmounts the focused row', async () => {
    mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'browser.editPath' }))
    const input = screen.getByLabelText<HTMLInputElement>('browser.editPath')
    // Two levels down, so the walk replaces the LEFT pane the focused row
    // lives in (a landing that re-lists the same level reuses its rows).
    fireEvent.change(input, { target: { value: `${HARNESS}/` } })
    // The keyboard path: focus Tabbed onto a row of the level about to be
    // replaced. Without a re-park it would fall to body, outside a Modal that
    // has no focus trap.
    rowButton(screen.getByRole('listitem')).focus()
    await waitFor(() => { expect(within(columns()[0]!).getByText('harness')).toBeTruthy() })
    expect(document.activeElement).toBe(screen.getByLabelText('browser.editPath'))
  })

  it('keeps the panes and stays silent when a draft-following scan fails', async () => {
    const b = mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'browser.editPath' }))
    const input = screen.getByLabelText<HTMLInputElement>('browser.editPath')
    fireEvent.change(input, { target: { value: `${HOME}/nope/x` } })
    await waitFor(() => { expect(b.listDirectory).toHaveBeenCalledWith(`${HOME}/nope/`, expect.anything()) })
    // A half-typed directory is unreadable most of the time: the last
    // readable level keeps rendering and no error interrupts the typing.
    expect(screen.getByText('Documents')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('holds the draft-following scan while a submitted path is in flight', async () => {
    const listDirectory = vi.fn(async (path?: string) => {
      // The submitted leg never settles, so the debounce window elapses with
      // the navigation still owning the view.
      if (path === HARNESS) return await new Promise<DirectoryListing>(() => {})
      return listingFor(path)
    })
    mount({ listDirectory })
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'browser.editPath' }))
    const input = screen.getByLabelText<HTMLInputElement>('browser.editPath')
    fireEvent.change(input, { target: { value: HARNESS } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 400) }) })
    // Only the initial home listing and the submitted path — the draft's
    // directory part was never scanned behind the navigation's back.
    expect(listDirectory.mock.calls.map(call => call[0])).toEqual([undefined, HARNESS])
  })

  it('discards draft-following scans that a newer edit superseded', async () => {
    let landDocs = (): void => {}
    let failRoot = (): void => {}
    const listDirectory = vi.fn(async (path?: string) => {
      if (path === `${DOCS}/`) return await new Promise<DirectoryListing>((resolve) => { landDocs = () => { resolve(listingFor(DOCS)) } })
      if (path === '/') {
        return await new Promise<DirectoryListing>((_, reject) => {
          failRoot = () => { reject(new Error('root unreadable')) }
        })
      }
      return listingFor(path)
    })
    mount({ listDirectory })
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'browser.editPath' }))
    const input = screen.getByLabelText<HTMLInputElement>('browser.editPath')
    fireEvent.change(input, { target: { value: `${DOCS}/h` } })
    await waitFor(() => { expect(listDirectory).toHaveBeenCalledWith(`${DOCS}/`, expect.anything()) })
    fireEvent.change(input, { target: { value: '/x' } })
    await waitFor(() => { expect(listDirectory).toHaveBeenCalledWith('/', expect.anything()) })
    // Back onto the listed level: neither pending scan may still land.
    fireEvent.change(input, { target: { value: `${HOME}/D` } })
    await act(async () => { landDocs(); failRoot() })
    expect(screen.getAllByRole('listitem').map(item => item.textContent)).toEqual(['Documents'])
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('keeps the draft and filter through window focus loss and in-dialog focus moves', async () => {
    mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'browser.editPath' }))
    const input = screen.getByLabelText<HTMLInputElement>('browser.editPath')
    fireEvent.change(input, { target: { value: `${HOME}/do` } })
    // A blur while the document itself lost focus (window switch, dev-tools
    // focus) must not discard the draft: value and filter both survive.
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    fireEvent.focusOut(input)
    hasFocus.mockRestore()
    expect(screen.getByLabelText<HTMLInputElement>('browser.editPath', { selector: 'input' }).value).toBe(`${HOME}/do`)
    expect(screen.getByRole('listitem').textContent).toBe('Documents')
    // A keyboard focus move that stays inside the dialog (Tab onto the
    // filtered row) keeps the draft too — the results stay reachable.
    fireEvent.focusOut(input, { relatedTarget: rowButton(screen.getByRole('listitem')) })
    expect(screen.getByLabelText<HTMLInputElement>('browser.editPath', { selector: 'input' }).value).toBe(`${HOME}/do`)
    // Toggling show-hidden mid-edit suppresses focus steal: the draft and
    // its filter survive the toggle in both directions.
    const toggle = screen.getByRole('button', { name: 'browser.showHidden' })
    fireEvent.mouseDown(toggle)
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByLabelText<HTMLInputElement>('browser.editPath', { selector: 'input' }).value).toBe(`${HOME}/do`)
    expect(screen.getByRole('listitem').textContent).toBe('Documents')
    // Focus landing outside the dialog cancels like Escape — even when the
    // departure happens from a row the user had Tabbed onto, not the input
    // (the observer lives on the card scope, not the input).
    fireEvent.focusOut(rowButton(screen.getByRole('listitem')), { relatedTarget: document.body })
    expect(screen.queryByLabelText('browser.editPath', { selector: 'input' })).toBeNull()
    // Outside editing the card-scope observer is inert.
    fireEvent.focusOut(screen.getByRole('button', { name: 'browser.showHidden' }))
    expect(screen.getByRole('button', { name: 'browser.editPath' })).toBeTruthy()
  })

  it('Escape with focus on a filtered row collapses the editor, not the dialog', async () => {
    const b = mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'browser.editPath' }))
    const input = screen.getByLabelText<HTMLInputElement>('browser.editPath')
    fireEvent.change(input, { target: { value: `${HOME}/do` } })
    // Tab parked focus on the result row; Escape must still mean "leave
    // path editing", not "close the whole dialog".
    const row = rowButton(screen.getByRole('listitem'))
    row.focus()
    fireEvent.keyDown(row, { key: 'Escape' })
    expect(screen.queryByLabelText('browser.editPath', { selector: 'input' })).toBeNull()
    expect(b.onClose).not.toHaveBeenCalled()
    // Focus was already on a surviving row, so nothing re-parks it.
    expect(document.activeElement).toBe(row)
    // With no draft left, Escape falls through to the Modal and closes.
    fireEvent.keyDown(row, { key: 'Escape' })
    expect(b.onClose).toHaveBeenCalledTimes(1)
  })

  it('a picked dot-revealed hidden row stays visible as the selection', async () => {
    mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'browser.editPath' }))
    const input = screen.getByLabelText<HTMLInputElement>('browser.editPath')
    fireEvent.change(input, { target: { value: `${HOME}/.co` } })
    const row = rowButton(screen.getByRole('listitem'))
    expect(row.textContent).toBe('.config')
    fireEvent.mouseDown(row)
    fireEvent.click(row)
    // The pick cleared the draft (and with it the dot-reveal), but the
    // selection is exempt from the hidden filter: the anchor row survives.
    expect(screen.queryByLabelText('browser.editPath', { selector: 'input' })).toBeNull()
    await waitFor(() => { expect(columns()).toHaveLength(2) })
    expect(within(columns()[0]!).getByText('.config')).toBeTruthy()
  })

  it('picking a filtered row adopts it and closes the path editor', async () => {
    mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'browser.editPath' }))
    const input = screen.getByLabelText<HTMLInputElement>('browser.editPath')
    fireEvent.change(input, { target: { value: `${HOME}/do` } })
    // The row suppresses focus steal on mousedown (no blur-cancel unmounts
    // the filtered rows mid-gesture), then the click both selects the row
    // and closes the editor.
    const row = rowButton(screen.getByRole('listitem'))
    fireEvent.mouseDown(row)
    fireEvent.click(row)
    expect(screen.queryByLabelText('browser.editPath', { selector: 'input' })).toBeNull()
    // Focus parks on the picked row (the editor's input just unmounted and
    // the Modal has no focus trap to catch a fall to body).
    expect(document.activeElement).toBe(row)
    await waitFor(() => { expect(columns()).toHaveLength(2) })
    expect(screen.getByRole('button', { name: 'browser.home' })).toBeTruthy()
  })

  it('a right-pane pick while editing parks focus on the advanced selection', async () => {
    mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(rowButton(screen.getByRole('listitem')))
    await waitFor(() => { expect(columns()).toHaveLength(2) })
    fireEvent.click(screen.getByRole('button', { name: 'browser.editPath' }))
    const input = screen.getByLabelText<HTMLInputElement>('browser.editPath')
    fireEvent.change(input, { target: { value: `${DOCS}/h` } })
    // The advance replaces BOTH panes (the picked button's own column
    // unmounts), so focus is re-parked on the selection's aria-current row
    // in the freshly rendered left pane rather than the clicked node.
    const row = rowButton(within(columns()[1]!).getByRole('listitem'))
    fireEvent.mouseDown(row)
    fireEvent.click(row)
    expect(screen.queryByLabelText('browser.editPath', { selector: 'input' })).toBeNull()
    await waitFor(() => { expect(document.activeElement?.textContent).toBe('harness') })
    expect(document.activeElement?.getAttribute('aria-current')).toBe('true')
  })

  it('seeds and filters with backslashes on a Windows-rooted listing', async () => {
    const ROOT = 'C:\\'
    const windowsListing: DirectoryListing = {
      path: ROOT,
      home: ROOT,
      crumbs: [{ name: 'C:\\', path: ROOT, hidden: false }],
      entries: [
        { name: 'Program Files', path: `${ROOT}Program Files`, hidden: false },
        { name: 'Users', path: `${ROOT}Users`, hidden: false },
      ],
      truncated: false,
    }
    const listDirectory = vi.fn(async () => windowsListing)
    mount({ listDirectory })
    await waitFor(() => { expect(screen.getAllByRole('listitem')).toHaveLength(2) })
    fireEvent.click(screen.getByRole('button', { name: 'browser.editPath' }))
    const input = screen.getByLabelText<HTMLInputElement>('browser.editPath')
    // The root already ends in its separator: no doubled backslash.
    expect(input.value).toBe(ROOT)
    fireEvent.change(input, { target: { value: `${ROOT}u` } })
    expect(screen.getByRole('listitem').textContent).toBe('Users')
    // Windows separates on a forward slash too (so does the Host's resolve),
    // so a path typed that way names its directory; the level the Host
    // answers with spells it back with a backslash, and once that scan lands
    // the level answers the typed spelling — the tail filters it.
    fireEvent.change(input, { target: { value: 'C:/p' } })
    await waitFor(() => { expect(screen.getByRole('listitem').textContent).toBe('Program Files') })
    // And the same spelling asks for no second scan.
    const settled = listDirectory.mock.calls.length
    fireEvent.change(input, { target: { value: 'C:/pr' } })
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 400) }) })
    expect(listDirectory.mock.calls).toHaveLength(settled)
    expect(screen.getByRole('listitem').textContent).toBe('Program Files')
  })

  it('clicking away from the path editor cancels it back to the crumb view', async () => {
    mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'browser.editPath' }))
    const input = screen.getByLabelText<HTMLInputElement>('browser.editPath')
    fireEvent.change(input, { target: { value: '/somewhere/else' } })
    // Focus moving anywhere outside the editor abandons the draft like Escape.
    fireEvent.focusOut(input)
    expect(screen.queryByLabelText('browser.editPath', { selector: 'input' })).toBeNull()
    // The crumb view is back and the abandoned draft was never navigated to.
    expect(screen.getByRole('button', { name: 'browser.editPath' })).toBeTruthy()
    expect(screen.getByRole('listitem').textContent).toBe('Documents')
  })

  it('restarts the home listing when Escape cancels an edit opened before any level listed', async () => {
    // The initial home listing hangs; Edit Path supersedes it while parent
    // is still null, and Escape must not strand a blank picker.
    let settled = false
    const gate = new Promise<never>(() => {})
    const listDirectory = vi.fn(async (path?: string) => {
      if (!settled) { settled = true; return gate }
      return listingFor(path)
    })
    mount({ listDirectory })
    fireEvent.click(screen.getByRole('button', { name: 'browser.editPath' }))
    const input = screen.getByLabelText<HTMLInputElement>('browser.editPath')
    expect(input.value).toBe('')
    fireEvent.keyDown(input, { key: 'Escape' })
    // Cancellation relaunched the home listing instead of leaving neither
    // rows nor status behind.
    await waitFor(() => { expect(screen.getByRole('listitem').textContent).toBe('Documents') })
    expect(listDirectory).toHaveBeenCalledTimes(2)
    expect(listDirectory).toHaveBeenLastCalledWith(undefined, expect.any(AbortSignal))
  })

  it('passes the entered path to the Host untrimmed (trim only gates blank drafts)', async () => {
    const listDirectory = vi.fn(async (path?: string) => listingFor(path))
    mount({ listDirectory })
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'browser.editPath' }))
    const input = screen.getByLabelText<HTMLInputElement>('browser.editPath')
    fireEvent.change(input, { target: { value: `${DOCS} ` } })
    fireEvent.keyDown(input, { key: 'Enter' })
    // A trailing space may name a real directory; trimming would list its sibling.
    await waitFor(() => { expect(listDirectory).toHaveBeenLastCalledWith(`${DOCS} `, expect.any(AbortSignal)) })
  })

  it('surfaces an unreadable target as an alert and keeps the edit open for correction', async () => {
    mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'browser.editPath' }))
    const input = screen.getByLabelText('browser.editPath')
    fireEvent.change(input, { target: { value: '/nope' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('cannot list /nope') })
    expect(screen.getByLabelText('browser.editPath')).toBeTruthy()
    expect(screen.getByRole('listitem').textContent).toBe('Documents')
  })

  it('folds non-typed failures into readable text (Error message, String otherwise)', async () => {
    const b = mount({ listDirectory: vi.fn(async () => { throw new Error('socket down') }) })
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('socket down') })
    b.view.rerender(<DirectoryBrowser {...b.props} open={false} />)
    const raw = mount({ listDirectory: vi.fn(async () => { throw 'raw failure' }) })
    await waitFor(() => { expect(screen.getAllByRole('alert').at(-1)!.textContent).toBe('raw failure') })
    expect(raw.onOpen).not.toHaveBeenCalled()
  })

  it('renders the full ancestry when the level sits outside the home subtree', async () => {
    const outside: DirectoryListing = {
      path: '/srv/data',
      home: HOME,
      crumbs: [
        { name: '/', path: '/', hidden: false },
        { name: 'srv', path: '/srv', hidden: false },
        { name: 'data', path: '/srv/data', hidden: false },
      ],
      entries: [],
      truncated: false,
    }
    mount({ listDirectory: vi.fn(async () => outside) })
    await waitFor(() => { expect(screen.getByRole('button', { name: 'data' })).toBeTruthy() })
    expect(screen.getByRole('button', { name: '/' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'browser.home' })).toBeNull()
  })

  it('scopes Escape to the topmost dialog: the nested create closes first, the browser only after', async () => {
    const b = mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'browser.newFolder' }))
    expect(screen.getByLabelText('browser.folderName')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    // The nested dialog consumed Escape; the browser stays up.
    expect(screen.queryByLabelText('browser.folderName')).toBeNull()
    expect(b.onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(b.onClose).toHaveBeenCalledOnce()
  })

  it('keeps both dialogs open when Escape lands during an in-flight creation', async () => {
    let resolve!: (path: string) => void
    const createDirectory = vi.fn(() => new Promise<string>((settle) => { resolve = settle }))
    const b = mount({ createDirectory })
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'browser.newFolder' }))
    fireEvent.change(screen.getByLabelText('browser.folderName'), { target: { value: 'pending' } })
    fireEvent.click(screen.getByRole('button', { name: 'browser.create' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    // The in-flight fence holds the nested dialog, and the browser must not
    // fall out from under it either.
    expect(screen.getByLabelText('browser.folderName')).toBeTruthy()
    expect(b.onClose).not.toHaveBeenCalled()
    await act(async () => { resolve(`${HOME}/pending`) })
  })

  it('keeps New folder disabled while the post-create relist is still loading', async () => {
    const pending: (() => void)[] = []
    const b = mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'browser.newFolder' }))
    // Every listing after the create hangs until drained: the button must not
    // offer a second create against a target the pending relist/select
    // sequence is about to change.
    const fresh: DirectoryListing = {
      path: `${HOME}/fresh`, home: HOME,
      crumbs: [...listingFor(HOME).crumbs, { name: 'fresh', path: `${HOME}/fresh`, hidden: false }],
      entries: [],
      truncated: false,
    }
    b.listDirectory.mockImplementation((path?: string) =>
      new Promise<DirectoryListing>((settle) => {
        pending.push(() => { settle(path === `${HOME}/fresh` ? fresh : listingFor(path)) })
      }))
    fireEvent.change(screen.getByLabelText('browser.folderName'), { target: { value: 'fresh' } })
    fireEvent.click(screen.getByRole('button', { name: 'browser.create' }))
    await waitFor(() => { expect(screen.queryByLabelText('browser.folderName')).toBeNull() })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'browser.newFolder' }).disabled).toBe(true)
    // Drain the relist and the follow-up selection listing; only then does
    // the affordance return.
    await act(async () => { for (const settle of pending.splice(0)) settle() })
    await act(async () => { for (const settle of pending.splice(0)) settle() })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'browser.newFolder' }).disabled).toBe(false)
  })

  it('keeps path entry available when the home listing fails', async () => {
    const listDirectory = vi.fn(async (): Promise<DirectoryListing> => {
      throw Object.assign(new Error('directory browse failed: directory-unreadable: home unreadable'), {
        rpcError: { code: 'directory-unreadable', message: 'home unreadable', details: { path: HOME } },
      })
    })
    mount({ listDirectory })
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('home unreadable') })
    // With no listed level, typing an absolute path is the one way forward.
    fireEvent.click(screen.getByRole('button', { name: 'browser.editPath' }))
    const input = screen.getByLabelText('browser.editPath')
    fireEvent.change(input, { target: { value: DOCS } })
    // With no level listed there is no platform separator to read, so the
    // draft-following wait resolves to nothing and the editor types blind.
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 400) }) })
    expect(listDirectory).toHaveBeenCalledTimes(1)
    listDirectory.mockImplementation(async (path?: string) => listingFor(path))
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => { expect(screen.getByText('harness')).toBeTruthy() })
  })

  it('falls back to the thrown message for an invalid RPC error payload', async () => {
    const listDirectory = vi.fn(async (): Promise<DirectoryListing> => {
      throw Object.assign(new Error('home unavailable'), { rpcError: null })
    })
    mount({ listDirectory })
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('home unavailable') })
  })

  it('disables Open and New folder while a path draft is uncommitted', async () => {
    mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'browser.editPath' }))
    // targetPath still names the previous listing; committing actions must
    // not act on it while a different path is displayed in the header.
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'browser.open' }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'browser.newFolder' }).disabled).toBe(true)
    fireEvent.keyDown(screen.getByLabelText('browser.editPath'), { key: 'Escape' })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'browser.open' }).disabled).toBe(false)
  })

  it('ignores Enter while an IME composition is active in either input', async () => {
    const b = mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    // Path editor: a composing Enter confirms the candidate, not the path.
    fireEvent.click(screen.getByRole('button', { name: 'browser.editPath' }))
    const pathInput = screen.getByLabelText('browser.editPath')
    fireEvent.change(pathInput, { target: { value: DOCS } })
    const listCalls = b.listDirectory.mock.calls.length
    fireEvent.compositionStart(pathInput)
    fireEvent.keyDown(pathInput, { key: 'Enter' })
    expect(b.listDirectory.mock.calls.length).toBe(listCalls)
    fireEvent.compositionEnd(pathInput)
    fireEvent.keyDown(pathInput, { key: 'Enter' })
    await waitFor(() => { expect(b.listDirectory).toHaveBeenLastCalledWith(DOCS, expect.any(AbortSignal)) })
    fireEvent.click(screen.getByRole('button', { name: 'browser.newFolder' }))
    const nameInput = screen.getByLabelText('browser.folderName')
    fireEvent.change(nameInput, { target: { value: '新建' } })
    fireEvent.compositionStart(nameInput)
    fireEvent.keyDown(nameInput, { key: 'Enter' })
    expect(b.createDirectory).not.toHaveBeenCalled()
    fireEvent.compositionEnd(nameInput)
    fireEvent.keyDown(nameInput, { key: 'Enter' })
    await waitFor(() => { expect(b.createDirectory).toHaveBeenCalledWith(DOCS, '新建') })
  })

  it('surfaces a two-pane navigation failure as an alert below the columns', async () => {
    const b = mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(rowButton(screen.getByRole('listitem')))
    await waitFor(() => { expect(columns()).toHaveLength(2) })
    b.listDirectory.mockImplementation(async () => {
      throw new Error('denied')
    })
    fireEvent.click(within(screen.getByRole('navigation')).getByRole('button', { name: 'browser.home' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('denied') })
    // Both panes survive the failure; the alert renders in the flow, not as a
    // third column competing for the fixed widths.
    expect(columns()).toHaveLength(2)
  })

  it('keeps the editor open when a pending listing settles right after Edit Path was clicked', async () => {
    const pending: ((listing: DirectoryListing) => void)[] = []
    const b = mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    // A crumb navigation hangs; the user opens the editor before it settles.
    b.listDirectory.mockImplementation(() =>
      new Promise<DirectoryListing>((settle) => { pending.push(settle) }))
    fireEvent.click(within(screen.getByRole('navigation')).getByRole('button', { name: 'browser.home' }))
    fireEvent.click(screen.getByRole('button', { name: 'browser.editPath' }))
    expect(screen.getByLabelText('browser.editPath')).toBeTruthy()
    await act(async () => { pending.shift()!(listingFor(HOME)) })
    // The superseded settlement must not close the editor underneath the user.
    expect(screen.getByLabelText('browser.editPath')).toBeTruthy()
  })

  it('ignores a pending navigation that settles after Escape cancelled the editor', async () => {
    const pending: ((listing: DirectoryListing) => void)[] = []
    const b = mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'browser.editPath' }))
    const input = screen.getByLabelText('browser.editPath')
    b.listDirectory.mockImplementation(() =>
      new Promise<DirectoryListing>((settle) => { pending.push(settle) }))
    fireEvent.change(input, { target: { value: DOCS } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.keyDown(input, { key: 'Escape' })
    // The cancelled navigation settling late must not jump the view to DOCS.
    await act(async () => { pending.shift()!(listingFor(DOCS)) })
    expect(screen.queryByText('harness')).toBeNull()
    expect(screen.getByText('Documents')).toBeTruthy()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('keeps a newer path edit when an older slow navigation settles', async () => {
    const pending: ((listing: DirectoryListing) => void)[] = []
    const b = mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'browser.editPath' }))
    const input = screen.getByLabelText('browser.editPath')
    b.listDirectory.mockImplementation(() =>
      new Promise<DirectoryListing>((settle) => { pending.push(settle) }))
    fireEvent.change(input, { target: { value: DOCS } })
    fireEvent.keyDown(input, { key: 'Enter' })
    // The user keeps typing while the lookup hangs; the older completion must
    // neither clear this newer draft nor swap the view to the older path.
    fireEvent.change(input, { target: { value: `${DOCS}/har` } })
    await act(async () => { pending.shift()!(listingFor(DOCS)) })
    expect(screen.getByLabelText<HTMLInputElement>('browser.editPath').value).toBe(`${DOCS}/har`)
    expect(screen.queryByText('harness')).toBeNull()
  })

  it('keeps an intact selection preview when a path edit is cancelled', async () => {
    mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(rowButton(screen.getByRole('listitem')))
    await waitFor(() => { expect(columns()).toHaveLength(2) })
    fireEvent.click(screen.getByRole('button', { name: 'browser.editPath' }))
    fireEvent.keyDown(screen.getByLabelText('browser.editPath'), { key: 'Escape' })
    // Nothing was superseded: the two-pane view survives the cancel.
    expect(columns()).toHaveLength(2)
  })

  it('falls back to the single-pane level when a path edit superseded the preview and was cancelled', async () => {
    const pending: ((listing: DirectoryListing) => void)[] = []
    const b = mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    // Selection starts a preview that never lands (superseded below).
    b.listDirectory.mockImplementation(() =>
      new Promise<DirectoryListing>((settle) => { pending.push(settle) }))
    fireEvent.click(rowButton(screen.getByRole('listitem')))
    fireEvent.click(screen.getByRole('button', { name: 'browser.editPath' }))
    const input = screen.getByLabelText('browser.editPath')
    fireEvent.change(input, { target: { value: `${DOCS}/x` } })
    fireEvent.keyDown(input, { key: 'Escape' })
    // No half-empty two-pane residue: back to the single wide level.
    expect(columns()).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'browser.editPath' })).toBeTruthy()
  })

  it('drops a creation that settles after the browser unmounted', async () => {
    let settleCreate!: (path: string) => void
    const createDirectory = vi.fn(() => new Promise<string>((settle) => { settleCreate = settle }))
    const b = mount({ createDirectory })
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'browser.newFolder' }))
    fireEvent.change(screen.getByLabelText('browser.folderName'), { target: { value: 'slow' } })
    fireEvent.click(screen.getByRole('button', { name: 'browser.create' }))
    const listCalls = b.listDirectory.mock.calls.length
    b.view.unmount()
    // The dead flow must not issue the post-create relist.
    await act(async () => { settleCreate(`${HOME}/slow`) })
    expect(b.listDirectory.mock.calls.length).toBe(listCalls)
  })

  it('clears the selection when its preview listing fails', async () => {
    const b = mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    b.listDirectory.mockImplementation(async () => {
      throw new Error('denied')
    })
    fireEvent.click(rowButton(screen.getByRole('listitem')))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('denied') })
    // The breadcrumb names the level, so the level must be the committing
    // target: no half-selected two-pane state survives the failure.
    expect(columns()).toHaveLength(1)
    expect(rowButton(screen.getByRole('listitem')).getAttribute('aria-current')).toBeNull()
  })

  it('ignores dismissal while adoption is busy', async () => {
    const b = mount({ busy: true })
    await waitFor(() => { expect(screen.getByRole('dialog')).toBeTruthy() })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(b.onClose).not.toHaveBeenCalled()
  })

  it('makes every parent control inert while the nested create dialog is open', async () => {
    mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'browser.newFolder' }))
    // Modal traps no focus: Shift-Tab/AT reach the parent, so closing,
    // adopting, and retargeting must all disable underneath the child. Both
    // dialogs carry a cancel: the parent's disables, the child's stays live.
    const cancels = screen.getAllByRole<HTMLButtonElement>('button', { name: 'browser.cancel' })
    expect(cancels.map(button => button.disabled).sort()).toEqual([false, true])
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'browser.open' }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'browser.editPath' }).disabled).toBe(true)
    for (const row of screen.getAllByRole('listitem')) {
      expect(rowButton(row).disabled).toBe(true)
    }
  })

  it('drops a creation failure that lands after the flow closed and reopened', async () => {
    let rejectCreate!: (reason: unknown) => void
    const createDirectory = vi.fn(() => new Promise<string>((_settle, reject) => { rejectCreate = reject }))
    const b = mount({ createDirectory })
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'browser.newFolder' }))
    fireEvent.change(screen.getByLabelText('browser.folderName'), { target: { value: 'slow' } })
    fireEvent.click(screen.getByRole('button', { name: 'browser.create' }))
    b.view.rerender(<DirectoryBrowser {...b.props} open={false} />)
    b.view.rerender(<DirectoryBrowser {...b.props} open />)
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    // The stale failure must not surface an alert inside the fresh flow.
    await act(async () => { rejectCreate(new Error('too late')) })
    expect(screen.queryByText('too late')).toBeNull()
  })

  it('drops a creation that settles after the flow closed and reopened', async () => {
    let settleCreate!: (path: string) => void
    const createDirectory = vi.fn(() => new Promise<string>((settle) => { settleCreate = settle }))
    const b = mount({ createDirectory })
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'browser.newFolder' }))
    fireEvent.change(screen.getByLabelText('browser.folderName'), { target: { value: 'slow' } })
    fireEvent.click(screen.getByRole('button', { name: 'browser.create' }))
    b.view.rerender(<DirectoryBrowser {...b.props} open={false} />)
    b.view.rerender(<DirectoryBrowser {...b.props} open />)
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    const listCallsBefore = b.listDirectory.mock.calls.length
    // The stale settlement must not relist the old target or reopen the
    // nested dialog's state inside the fresh flow.
    await act(async () => { settleCreate(`${HOME}/slow`) })
    expect(b.listDirectory.mock.calls.length).toBe(listCallsBefore)
    expect(screen.queryByLabelText('browser.folderName')).toBeNull()
    expect(screen.getByText('Documents')).toBeTruthy()
  })

  it('passes the folder name to the Host untrimmed (trim only gates blank drafts)', async () => {
    const b = mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'browser.newFolder' }))
    const input = screen.getByLabelText('browser.folderName')
    fireEvent.change(input, { target: { value: 'project ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    // A trailing space may be the wanted spelling; trimming would create a sibling.
    await waitFor(() => { expect(b.createDirectory).toHaveBeenCalledWith(HOME, 'project ') })
  })

  it('creates a folder through the nested dialog and lands with it selected', async () => {
    const b = mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(rowButton(screen.getByRole('listitem')))
    await waitFor(() => { expect(columns()).toHaveLength(2) })
    fireEvent.click(screen.getByRole('button', { name: 'browser.newFolder' }))
    // The nested dialog names the create target (the selected folder).
    expect(screen.getByText('browser.createIn:Documents')).toBeTruthy()
    // The created folder becomes listable (like the real backend after mkdir).
    b.listDirectory.mockImplementation(async (path?: string) => {
      if (path === `${DOCS}/fresh`) {
        return {
          path: `${DOCS}/fresh`, home: HOME,
          crumbs: [...listingFor(DOCS).crumbs, { name: 'fresh', path: `${DOCS}/fresh`, hidden: false }],
          entries: [],
          truncated: false,
        }
      }
      if (path === DOCS) {
        const docs = listingFor(DOCS)
        return { ...docs, entries: [...docs.entries, { name: 'fresh', path: `${DOCS}/fresh`, hidden: false }] }
      }
      return listingFor(path)
    })
    const input = screen.getByLabelText('browser.folderName')
    fireEvent.change(input, { target: { value: 'fresh' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => { expect(b.createDirectory).toHaveBeenCalledWith(DOCS, 'fresh') })
    // The create target became the level and the new folder its selection.
    await waitFor(() => {
      expect(within(screen.getByRole('navigation')).getByRole('button', { name: 'Documents' })).toBeTruthy()
      const level = columns()[0]!
      const rows = within(level).getAllByRole('listitem')
      expect(rows.some(row => row.textContent === 'fresh' && rowButton(row).getAttribute('aria-current') === 'true')).toBe(true)
    })
  })

  it('keeps the nested dialog open on a creation failure and cancels cleanly', async () => {
    const b = mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    b.createDirectory.mockRejectedValueOnce(
      new Error('taken already'))
    fireEvent.click(screen.getByRole('button', { name: 'browser.newFolder' }))
    expect(screen.getByText('browser.createIn:browser.home')).toBeTruthy()
    const input = screen.getByLabelText('browser.folderName')
    // A blank name never submits.
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(b.createDirectory).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: 'x' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('taken already') })
    fireEvent.keyDown(screen.getByLabelText('browser.folderName'), { key: 'Escape' })
    await waitFor(() => { expect(screen.queryByLabelText('browser.folderName')).toBeNull() })

    // The nested Cancel button and the nested mask both close only the child dialog.
    fireEvent.click(screen.getByRole('button', { name: 'browser.newFolder' }))
    const nested = screen.getByRole('dialog', { name: 'browser.newFolder' })
    fireEvent.click(within(nested).getByRole('button', { name: 'browser.cancel' }))
    await waitFor(() => { expect(screen.queryByLabelText('browser.folderName')).toBeNull() })
    fireEvent.click(screen.getByRole('button', { name: 'browser.newFolder' }))
    const masks = document.querySelectorAll('[aria-hidden="true"]')
    fireEvent.click(masks[masks.length - 1]!)
    await waitFor(() => { expect(screen.queryByLabelText('browser.folderName')).toBeNull() })
    expect(screen.getByRole('dialog', { name: 'browser.title' })).toBeTruthy()
  })

  it('surfaces a post-create relist failure on the browser surface', async () => {
    const b = mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'browser.newFolder' }))
    // Creation succeeds, but relisting the target fails afterwards.
    b.listDirectory.mockRejectedValueOnce(new Error('level vanished'))
    const input = screen.getByLabelText('browser.folderName')
    fireEvent.change(input, { target: { value: 'fresh' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('level vanished') })
  })

  it('drops a stale child listing that resolves after a crumb jump', async () => {
    const b = mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    let resolveSlow!: (value: DirectoryListing) => void
    const slow = new Promise<DirectoryListing>((settle) => { resolveSlow = settle })
    b.listDirectory.mockReturnValueOnce(slow)
    fireEvent.click(rowButton(screen.getByRole('listitem')))
    fireEvent.click(screen.getByRole('button', { name: 'browser.home' }))
    await waitFor(() => { expect(b.listDirectory).toHaveBeenCalledTimes(3) })
    await waitFor(() => { expect(columns()).toHaveLength(1) })
    resolveSlow(listingFor(DOCS))
    await new Promise(settle => setTimeout(settle, 0))
    // The superseded selection preview did not reopen the second pane.
    expect(columns()).toHaveLength(1)
  })

  it('drops a stale failure that rejects after a newer navigation', async () => {
    const b = mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    let rejectSlow!: (reason: unknown) => void
    const slow = new Promise<DirectoryListing>((_settle, fail) => { rejectSlow = fail })
    b.listDirectory.mockReturnValueOnce(slow)
    fireEvent.click(rowButton(screen.getByRole('listitem')))
    fireEvent.click(screen.getByRole('button', { name: 'browser.home' }))
    await waitFor(() => { expect(b.listDirectory).toHaveBeenCalledTimes(3) })
    rejectSlow(new Error('too late to matter'))
    await new Promise(settle => setTimeout(settle, 0))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('listitem').textContent).toBe('Documents')
  })

  it('drops a stale navigation failure that rejects after a newer jump', async () => {
    const b = mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(rowButton(screen.getByRole('listitem')))
    await waitFor(() => { expect(columns()).toHaveLength(2) })
    let rejectSlow!: (reason: unknown) => void
    const slow = new Promise<DirectoryListing>((_settle, fail) => { rejectSlow = fail })
    b.listDirectory.mockReturnValueOnce(slow)
    // A slow crumb jump superseded by a second jump.
    fireEvent.click(screen.getByRole('button', { name: 'browser.home' }))
    fireEvent.click(within(screen.getByRole('navigation')).getByRole('button', { name: 'Documents' }))
    await waitFor(() => { expect(b.listDirectory).toHaveBeenCalledTimes(4) })
    rejectSlow(new Error('late nav failure'))
    await new Promise(settle => setTimeout(settle, 0))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('drops a stale navigation listing that resolves after a newer jump', async () => {
    const b = mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(rowButton(screen.getByRole('listitem')))
    await waitFor(() => { expect(columns()).toHaveLength(2) })
    let resolveSlow!: (value: DirectoryListing) => void
    const slow = new Promise<DirectoryListing>((settle) => { resolveSlow = settle })
    b.listDirectory.mockReturnValueOnce(slow)
    fireEvent.click(screen.getByRole('button', { name: 'browser.home' }))
    fireEvent.click(within(screen.getByRole('navigation')).getByRole('button', { name: 'Documents' }))
    // The newer jump lands two-pane: Documents selected at home, children right.
    await waitFor(() => { expect(within(columns()[1]!).getByText('harness')).toBeTruthy() })
    resolveSlow(listingFor(undefined))
    await new Promise(settle => setTimeout(settle, 0))
    // The stale home listing did not replace the newer Documents landing.
    expect(columns()).toHaveLength(2)
    expect(within(columns()[1]!).getByText('harness')).toBeTruthy()
  })

  it('names the create target by its path when the level reports no crumbs', async () => {
    const bare: DirectoryListing = { path: '/srv/data', home: HOME, crumbs: [], entries: [], truncated: false }
    mount({ listDirectory: vi.fn(async () => bare) })
    await waitFor(() => { expect(screen.getByRole('button', { name: 'browser.newFolder' })).toBeTruthy() })
    await waitFor(() => {
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'browser.newFolder' }).disabled).toBe(false)
    })
    fireEvent.click(screen.getByRole('button', { name: 'browser.newFolder' }))
    expect(screen.getByText('browser.createIn:/srv/data')).toBeTruthy()
  })

  it('refuses to close the nested dialog while the creation is in flight', async () => {
    const b = mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    let settleCreate!: (path: string) => void
    b.createDirectory.mockReturnValueOnce(new Promise<string>((settle) => { settleCreate = settle }))
    fireEvent.click(screen.getByRole('button', { name: 'browser.newFolder' }))
    const input = screen.getByLabelText('browser.folderName')
    fireEvent.change(input, { target: { value: 'slow' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    // Escape and the mask are both inert while creating.
    fireEvent.keyDown(screen.getByLabelText('browser.folderName'), { key: 'Escape' })
    const masks = document.querySelectorAll('[aria-hidden="true"]')
    fireEvent.click(masks[masks.length - 1]!)
    expect(screen.getByLabelText('browser.folderName')).toBeTruthy()
    settleCreate(`${HOME}/slow`)
    await waitFor(() => { expect(screen.queryByLabelText('browser.folderName')).toBeNull() })
  })

  it('says a level is incomplete when the backend cut it at its bound', async () => {
    const cut = { ...listingFor(HOME), truncated: true }
    mount({ listDirectory: vi.fn(async () => cut) })
    await screen.findByText('browser.truncated')
  })

  it('flags a truncated child preview under a complete level', async () => {
    mount({
      listDirectory: vi.fn(async (path?: string) =>
        (path === DOCS ? { ...listingFor(DOCS), truncated: true } : listingFor(path))),
    })
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    expect(screen.queryByText('browser.truncated')).toBeNull()
    fireEvent.click(rowButton(screen.getByRole('listitem')))
    await waitFor(() => { expect(columns()).toHaveLength(2) })
    await screen.findByText('browser.truncated')
  })

  it('pins the child pane into view when its preview lands (narrow viewports scroll the miller row)', async () => {
    mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    const row = document.querySelector('[class*=millerRow]') as HTMLElement
    // jsdom does no layout: stub the overflow width the effect pins against.
    Object.defineProperty(row, 'scrollWidth', { value: 640, configurable: true })
    fireEvent.click(rowButton(screen.getByRole('listitem')))
    await waitFor(() => { expect(columns()).toHaveLength(2) })
    await waitFor(() => { expect(row.scrollLeft).toBe(640) })
  })

  it('starts back at home on reopen', async () => {
    const b = mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(rowButton(screen.getByRole('listitem')))
    await waitFor(() => { expect(columns()).toHaveLength(2) })
    b.view.rerender(<DirectoryBrowser {...b.props} open={false} />)
    b.view.rerender(<DirectoryBrowser {...b.props} open />)
    await waitFor(() => { expect(screen.getByRole('listitem').textContent).toBe('Documents') })
    expect(columns()).toHaveLength(1)
    expect(b.listDirectory).toHaveBeenLastCalledWith(undefined, expect.any(AbortSignal))
  })
})
