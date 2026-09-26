import { describe, expect, it, vi } from 'vitest'
import type { SelectOption } from '../src/client/contract.ts'
import type { PopupSpec, TokenSegment } from '../src/client/popup.ts'
import { filterOptions, PopupSelectController } from '../src/client/popup.ts'

interface Ctx { readonly session: string }
const CTX_A: Ctx = { session: 'A' }

const OPTIONS: SelectOption[] = [
  { id: 'dark', label: 'Dark' },
  { id: 'light', label: 'Light', active: true },
  { id: 'sepia', label: 'Sepia', detail: 'warm' },
]
const GATED: SelectOption = {
  id: 'full',
  label: 'Full access',
  confirmation: {
    title: 'Enable Full access?',
    description: 'Sensitive operations.',
    acknowledgeLabel: 'I understand',
    cancelLabel: 'Cancel',
    confirmLabel: 'Enable Full access',
  },
}

const SEGMENT: TokenSegment = { via: 'enter', token: '/theme' }

function spec(overrides: Partial<PopupSpec<Ctx>> = {}): PopupSpec<Ctx> {
  return {
    options: () => Promise.resolve(OPTIONS),
    onSelect: () => undefined,
    ...overrides,
  }
}

/** Fake session wiring: records consume/focus calls; consume answer is settable per test. */
function makeDeps(consumeResult = true) {
  const consume = vi.fn((_segment: TokenSegment) => consumeResult)
  const focusComposer = vi.fn()
  return { consume, focusComposer }
}

async function readyPopup(overrides: Partial<PopupSpec<Ctx>> = {}, deps = makeDeps()) {
  const popup = new PopupSelectController<Ctx>(deps)
  popup.open('theme', spec(overrides), CTX_A, SEGMENT)
  await Promise.resolve()
  return { popup, deps }
}

describe('filterOptions', () => {
  it('matches case-insensitively over label and detail; blank keeps all', () => {
    expect(filterOptions(OPTIONS, '')).toBe(OPTIONS)
    expect(filterOptions(OPTIONS, '  ')).toBe(OPTIONS)
    expect(filterOptions(OPTIONS, 'DARK')).toEqual([OPTIONS[0]])
    expect(filterOptions(OPTIONS, 'warm')).toEqual([OPTIONS[2]])
    expect(filterOptions(OPTIONS, 'nope')).toEqual([])
  })
})

describe('open and options load', () => {
  it('publishes pending immediately, ready when options land', async () => {
    const popup = new PopupSelectController<Ctx>(makeDeps())
    let release!: (options: readonly SelectOption[]) => void
    popup.open('theme', spec({ options: () => new Promise((resolve) => { release = resolve }) }), CTX_A, SEGMENT)
    expect(popup.state.getSnapshot()).toMatchObject({ open: true, command: 'theme', status: 'pending', search: '', submitting: false, error: null })
    release(OPTIONS)
    await Promise.resolve()
    // The highlight parks on the row the list marks as the current value
    // (Light at index 1), not on the topmost row.
    expect(popup.state.getSnapshot()).toMatchObject({ status: 'ready', options: OPTIONS, active: 1 })
  })

  it('parks the highlight on the top row when no row marks the current value', async () => {
    const rows: SelectOption[] = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]
    const popup = new PopupSelectController<Ctx>(makeDeps())
    popup.open('theme', spec({ options: () => Promise.resolve(rows) }), CTX_A, SEGMENT)
    await Promise.resolve()
    expect(popup.state.getSnapshot().active).toBe(0)
  })

  it('a retry re-parks the highlight inside the search text it retained', async () => {
    let attempts = 0
    const rows: SelectOption[] = [
      { id: 'sun', label: 'Sun' },
      { id: 'moon', label: 'Moon', active: true },
      { id: 'star', label: 'Star' },
    ]
    const { popup } = await readyPopup({
      options: () => {
        attempts += 1
        return attempts === 1 ? Promise.reject(new Error('directory down')) : Promise.resolve(rows)
      },
    })
    await Promise.resolve()
    popup.setSearch('n') // Sun, Moon — the current value sits at filtered index 1
    popup.retry()
    await Promise.resolve()
    expect(popup.state.getSnapshot()).toMatchObject({ status: 'ready', search: 'n', active: 1 })
  })

  it('loads options exactly once: search filters locally without re-querying the provider', async () => {
    const options = vi.fn(() => Promise.resolve(OPTIONS))
    const { popup } = await readyPopup({ options })
    popup.setSearch('li')
    popup.setSearch('light')
    const s = popup.state.getSnapshot()
    expect(options).toHaveBeenCalledTimes(1)
    expect(s.options).toEqual(OPTIONS) // original array retained; filtering is view-side
    expect(s.search).toBe('light')
    expect(filterOptions(s.options, s.search)).toEqual([OPTIONS[1]])
  })

  it('a reopen aborts the old load and drops its late arrival', async () => {
    const popup = new PopupSelectController<Ctx>(makeDeps())
    let firstSignal!: AbortSignal
    let releaseFirst!: (options: readonly SelectOption[]) => void
    popup.open('alpha', spec({
      options: (_ctx, signal) => {
        firstSignal = signal
        return new Promise((resolve) => { releaseFirst = resolve })
      },
    }), CTX_A, SEGMENT)
    popup.open('beta', spec(), CTX_A, SEGMENT)
    expect(firstSignal.aborted).toBe(true)
    releaseFirst([{ id: 'stale', label: 'stale' }])
    await Promise.resolve()
    const s = popup.state.getSnapshot()
    expect(s.command).toBe('beta')
    expect(s.options).toEqual(OPTIONS)
  })

  it('dispose aborts the flying load, clears state, and drops the late arrival', async () => {
    const popup = new PopupSelectController<Ctx>(makeDeps())
    let signal!: AbortSignal
    let release!: (options: readonly SelectOption[]) => void
    popup.open('theme', spec({
      options: (_ctx, s) => {
        signal = s
        return new Promise((resolve) => { release = resolve })
      },
    }), CTX_A, SEGMENT)
    popup.dispose()
    expect(signal.aborted).toBe(true)
    expect(popup.state.getSnapshot().open).toBe(false)
    release(OPTIONS)
    await Promise.resolve()
    expect(popup.state.getSnapshot().open).toBe(false)
  })

  it('an options failure keeps the shell open with search retained, surfaces the error, and retry reloads', async () => {
    let attempts = 0
    const { popup } = await readyPopup({
      options: () => {
        attempts += 1
        return attempts === 1 ? Promise.reject(new Error('directory down')) : Promise.resolve(OPTIONS)
      },
    })
    await Promise.resolve()
    popup.setSearch('da')
    // The failure landed before setSearch (readyPopup awaited); search must survive it and retry.
    expect(popup.state.getSnapshot()).toMatchObject({ open: true, status: 'failed', error: 'directory down', search: 'da' })
    popup.retry()
    expect(popup.state.getSnapshot()).toMatchObject({ status: 'pending', error: null })
    await Promise.resolve()
    expect(popup.state.getSnapshot()).toMatchObject({ status: 'ready', options: OPTIONS, search: 'da' })
    expect(attempts).toBe(2)
  })

  it('retry is a no-op unless the options load failed', async () => {
    const { popup } = await readyPopup()
    popup.retry()
    expect(popup.state.getSnapshot().status).toBe('ready')
    const closed = new PopupSelectController<Ctx>(makeDeps())
    closed.retry()
    expect(closed.state.getSnapshot().open).toBe(false)
  })
})

describe('search / move / highlight over the filtered list', () => {
  it('setSearch rebases the highlight to the top row and ignores closed shells and identical text', async () => {
    const { popup } = await readyPopup()
    expect(popup.state.getSnapshot().active).toBe(1) // parked on the current-value row
    popup.move(1)
    expect(popup.state.getSnapshot().active).toBe(2)
    popup.setSearch('a') // Dark, Sepia
    expect(popup.state.getSnapshot()).toMatchObject({ search: 'a', active: 0 })
    const before = popup.state.getSnapshot()
    popup.setSearch('a')
    expect(popup.state.getSnapshot()).toBe(before)
    const closed = new PopupSelectController<Ctx>(makeDeps())
    closed.setSearch('x')
    expect(closed.state.getSnapshot().search).toBe('')
  })

  it('move wraps across the FILTERED rows', async () => {
    const { popup } = await readyPopup()
    popup.setSearch('a') // Dark, Sepia (detail 'warm' also matches 'a'? label match: Dark, Sepia)
    const rows = filterOptions(popup.state.getSnapshot().options, 'a')
    expect(rows.length).toBe(2)
    popup.move(1)
    expect(popup.state.getSnapshot().active).toBe(1)
    popup.move(1)
    expect(popup.state.getSnapshot().active).toBe(0)
    popup.move(-1)
    expect(popup.state.getSnapshot().active).toBe(1)
  })

  it('move is a no-op while pending, closed, or when the filter matches nothing', async () => {
    const pending = new PopupSelectController<Ctx>(makeDeps())
    pending.open('theme', spec({ options: () => new Promise(() => {}) }), CTX_A, SEGMENT)
    pending.move(1)
    expect(pending.state.getSnapshot().active).toBe(0)
    const closed = new PopupSelectController<Ctx>(makeDeps())
    closed.move(1)
    expect(closed.state.getSnapshot().active).toBe(0)
    const { popup } = await readyPopup()
    popup.setSearch('nope')
    popup.move(1)
    expect(popup.state.getSnapshot().active).toBe(0)
  })

  it('highlight sets the active filtered row and ignores out-of-range or same-index calls', async () => {
    const { popup } = await readyPopup()
    popup.highlight(1)
    expect(popup.state.getSnapshot().active).toBe(1)
    popup.highlight(99)
    popup.highlight(-1)
    popup.highlight(1)
    expect(popup.state.getSnapshot().active).toBe(1)
    popup.setSearch('dark') // one filtered row → index 1 now out of range
    popup.highlight(1)
    expect(popup.state.getSnapshot().active).toBe(0)
  })
})

describe('select', () => {
  it('gates a confirmed option until acknowledgement, then settles through the original binding', async () => {
    const onSelect = vi.fn()
    const deps = makeDeps()
    const { popup } = await readyPopup({ options: () => Promise.resolve([GATED]), onSelect }, deps)
    await popup.select(0)
    expect(popup.state.getSnapshot()).toMatchObject({
      open: true, confirming: GATED, acknowledged: false, submitting: false,
    })
    expect(onSelect).not.toHaveBeenCalled()
    await popup.confirm()
    expect(onSelect).not.toHaveBeenCalled()
    popup.acknowledge(true)
    await popup.confirm()
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(GATED, CTX_A)
    expect(deps.consume).toHaveBeenCalledExactlyOnceWith(SEGMENT)
    expect(popup.state.getSnapshot().open).toBe(false)
  })

  it('cancels a confirmation back to the picker without selecting or consuming', async () => {
    const onSelect = vi.fn()
    const deps = makeDeps()
    const { popup } = await readyPopup({ options: () => Promise.resolve([GATED]), onSelect }, deps)
    await popup.select(0)
    popup.acknowledge(true)
    popup.cancelConfirmation()
    expect(popup.state.getSnapshot()).toMatchObject({
      open: true, confirming: null, acknowledged: false, submitting: false,
    })
    expect(onSelect).not.toHaveBeenCalled()
    expect(deps.consume).not.toHaveBeenCalled()
  })

  it('runs onSelect with the filtered option and the open-time context, consumes, closes, refocuses', async () => {
    const seen: Array<{ option: SelectOption; context: Ctx }> = []
    const deps = makeDeps()
    const { popup } = await readyPopup({
      onSelect: (option, context) => { seen.push({ option, context }) },
    }, deps)
    popup.setSearch('light')
    await popup.select(0)
    expect(seen).toEqual([{ option: OPTIONS[1], context: CTX_A }])
    expect(deps.consume).toHaveBeenCalledExactlyOnceWith(SEGMENT)
    expect(deps.focusComposer).toHaveBeenCalledTimes(1)
    expect(popup.state.getSnapshot().open).toBe(false)
  })

  it('is single-flight: the first call enters submitting, later Enter/click calls no-op', async () => {
    let release!: () => void
    const onSelect = vi.fn(() => new Promise<void>((resolve) => { release = resolve }))
    const deps = makeDeps()
    const { popup } = await readyPopup({ onSelect }, deps)
    const first = popup.select(0)
    expect(popup.state.getSnapshot().submitting).toBe(true)
    await popup.select(0)
    await popup.select(1)
    popup.setSearch('x') // locked while submitting
    popup.move(1)
    popup.highlight(1)
    expect(popup.state.getSnapshot()).toMatchObject({ search: '', active: 1 })
    release()
    await first
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(deps.consume).toHaveBeenCalledTimes(1)
    expect(popup.state.getSnapshot().open).toBe(false)
  })

  it('a consume CAS miss is benign: no retry, still closes and refocuses', async () => {
    const deps = makeDeps(false)
    const { popup } = await readyPopup({}, deps)
    await popup.select(0)
    expect(deps.consume).toHaveBeenCalledTimes(1)
    expect(deps.focusComposer).toHaveBeenCalledTimes(1)
    expect(popup.state.getSnapshot().open).toBe(false)
  })

  it('an onSelect failure keeps the shell open with search/highlight/token intact, no consumption, and select re-arms', async () => {
    let attempts = 0
    const deps = makeDeps()
    const { popup } = await readyPopup({
      onSelect: () => {
        attempts += 1
        if (attempts === 1) throw new Error('host rejected')
        return undefined
      },
    }, deps)
    popup.setSearch('a')
    popup.move(1)
    await popup.select(1)
    expect(popup.state.getSnapshot()).toMatchObject({
      open: true, status: 'ready', submitting: false, error: 'host rejected', search: 'a', active: 1,
    })
    expect(deps.consume).not.toHaveBeenCalled()
    await popup.select(1) // retry = selecting again
    expect(deps.consume).toHaveBeenCalledExactlyOnceWith(SEGMENT)
    expect(popup.state.getSnapshot().open).toBe(false)
  })

  it('ignores selects while closed, pending, failed, or out of filtered range', async () => {
    const closed = new PopupSelectController<Ctx>(makeDeps())
    await closed.select(0)
    expect(closed.state.getSnapshot().open).toBe(false)
    const failedDeps = makeDeps()
    const { popup: failed } = await readyPopup({ options: () => Promise.reject(new Error('x')) }, failedDeps)
    await failed.select(0)
    expect(failedDeps.consume).not.toHaveBeenCalled()
    const deps = makeDeps()
    const { popup } = await readyPopup({}, deps)
    popup.setSearch('dark')
    await popup.select(1) // only one filtered row
    expect(deps.consume).not.toHaveBeenCalled()
    expect(popup.state.getSnapshot().open).toBe(true)
  })

  it('a dismiss racing a succeeding onSelect revokes it: no consume, no focus, state stays closed', async () => {
    let release!: () => void
    const deps = makeDeps()
    const { popup } = await readyPopup({
      onSelect: () => new Promise<void>((resolve) => { release = resolve }),
    }, deps)
    const selecting = popup.select(0)
    popup.dismiss()
    release()
    await selecting
    expect(deps.consume).not.toHaveBeenCalled()
    expect(deps.focusComposer).not.toHaveBeenCalled()
    expect(popup.state.getSnapshot().open).toBe(false)
  })

  it('a dispose racing a failing onSelect revokes its error write', async () => {
    let reject!: (error: Error) => void
    const deps = makeDeps()
    const { popup } = await readyPopup({
      onSelect: () => new Promise<void>((_resolve, rej) => { reject = rej }),
    }, deps)
    const selecting = popup.select(0)
    popup.dispose()
    reject(new Error('late'))
    await selecting
    expect(popup.state.getSnapshot()).toMatchObject({ open: false, error: null })
    expect(deps.consume).not.toHaveBeenCalled()
  })

  it('a reopen racing a succeeding onSelect keeps the new shell: no consume of the old segment', async () => {
    let release!: () => void
    const deps = makeDeps()
    const { popup } = await readyPopup({
      onSelect: () => new Promise<void>((resolve) => { release = resolve }),
    }, deps)
    const selecting = popup.select(0)
    popup.open('other', spec(), CTX_A, { via: 'enter', token: '/other' })
    release()
    await selecting
    await Promise.resolve()
    expect(deps.consume).not.toHaveBeenCalled()
    expect(popup.state.getSnapshot()).toMatchObject({ open: true, command: 'other' })
  })
})

describe('dismiss / dispose', () => {
  it('dismiss closes, aborts the flying fetch, and is a no-op when already closed', async () => {
    const deps = makeDeps()
    const popup = new PopupSelectController<Ctx>(deps)
    let signal!: AbortSignal
    popup.open('theme', spec({
      options: (_ctx, s) => {
        signal = s
        return new Promise(() => {})
      },
    }), CTX_A, SEGMENT)
    popup.dismiss()
    expect(signal.aborted).toBe(true)
    expect(popup.state.getSnapshot().open).toBe(false)
    expect(deps.focusComposer).not.toHaveBeenCalled() // outside-pointer path: the click's target takes focus
    popup.dismiss()
    popup.dispose()
    expect(popup.state.getSnapshot().open).toBe(false)
  })

  it('the Escape path restores composer focus explicitly', async () => {
    const deps = makeDeps()
    const { popup } = await readyPopup({}, deps)
    popup.dismiss({ focusComposer: true })
    expect(deps.focusComposer).toHaveBeenCalledTimes(1)
    expect(popup.state.getSnapshot().open).toBe(false)
  })
})
