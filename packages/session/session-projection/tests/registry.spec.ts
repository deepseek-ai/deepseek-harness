/**
 * SessionProjectionRegistry unit drive: eager apply on committed events with
 * lazy cell build (registration after events, session after registration),
 * the Object.is no-change gates (same state or raw view reference ⇒ zero
 * change-feed work), snapshot consistency (asOfSeq = last event seq; values
 * from the watermark cache), duplicate-key rejection, stateVersion validation,
 * and effect-tied removal of registrations and change listeners (HMR safety).
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    'test/marks': MarksState
    'test/count': number
    'test/stable-view': StableViewState
  }

  interface SessionProjectionMap {
    'test/marks': { marks: string[] }
    'test/stable-view': { marks: string[] }
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'test/mark': { marks: string[] }
  }
}

interface MarksView {
  marks: string[]
}
type MarksState = MarksView | null
interface StableViewState {
  revision: number
  value: MarksView
}
const marksViewSchema: z.ZodType<MarksView> = z.object({ marks: z.array(z.string()) })
const RESTORE_HEADER: SessionHeader = {
  version: 0,
  id: SessionId('projection-restore'),
  createdAt: 0,
}
/** Whole-value unit: latest test/mark event wins; unrelated events return the same reference. */
const marksUnit = (): Omit<ProjectionDefinition<'test/marks', MarksState>, 'wire'>
  & { wire: NonNullable<ProjectionDefinition<'test/marks', MarksState>['wire']> } => ({
  key: 'test/marks',
  stateSchema: marksViewSchema.nullable(),
  init: () => null,
  apply: (state, event) => (event.type === 'test/mark' ? (event).data : state),
  wire: {
    viewSchema: marksViewSchema,
    view: state => state ?? { marks: [] },
  },
  stateVersion: 1,
})

/** Host-only counting unit over every event — state changes on each apply. */
const countUnit = (): ProjectionDefinition<'test/count', number> => ({
  key: 'test/count',
  stateSchema: z.number().int().nonnegative(),
  init: () => 0,
  apply: state => state + 1,
  stateVersion: 1,
})

const stableViewUnit = (
  view: (state: StableViewState) => StableViewState['value'],
) => ({
  key: 'test/stable-view',
  stateSchema: z.object({
    revision: z.number().int().nonnegative(),
    value: marksViewSchema,
  }),
  init: () => ({ revision: 0, value: { marks: [] } }),
  apply: (state, event) => {
    if (event.type === 'turn/start') return { ...state, revision: state.revision + 1 }
    if (event.type === 'test/mark') return { revision: state.revision + 1, value: event.data }
    return state
  },
  wire: {
    viewSchema: marksViewSchema,
    view,
  },
  stateVersion: 1,
}) satisfies ProjectionDefinition<'test/stable-view', StableViewState>

async function harness(): Promise<{ ctx: Context; session: Session }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  return { ctx, session: ctx.sessions.create() }
}

const mark = (session: Session, marks: string[]): SessionEvent =>
  session.append('test/mark', { marks })

const STATE_SEQUENCES = [
  [0, 0, 0, 0],
  [0, 0, 0, 1],
  [0, 0, 1, 0],
  [0, 0, 1, 1],
  [0, 0, 1, 2],
  [0, 1, 0, 0],
  [0, 1, 0, 1],
  [0, 1, 0, 2],
  [0, 1, 1, 0],
  [0, 1, 1, 1],
  [0, 1, 1, 2],
  [0, 1, 2, 0],
  [0, 1, 2, 1],
  [0, 1, 2, 2],
  [0, 1, 2, 3],
] as const

function identitySequences(length: number): number[][] {
  const sequences: number[][] = []
  const visit = (sequence: number[], highest: number): void => {
    if (sequence.length === length) {
      sequences.push(sequence)
      return
    }
    for (let value = 0; value <= highest + 1; value++) {
      visit([...sequence, value], Math.max(highest, value))
    }
  }
  visit([0], 0)
  return sequences
}

function sameIdentities(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((value, index) => Object.is(value, right[index]))
}

function sequenceName(sequence: readonly number[], prefix: string): string {
  return sequence.map(value => `${prefix}${String(value + 1)}`).join(',')
}

describe('SessionProjectionRegistry drive', () => {
  it('drives a registered unit over committed events and snapshots the current value', async () => {
    const { ctx, session } = await harness()
    ctx.sessionProjections.register(marksUnit())
    mark(session, ['a'])
    mark(session, ['a', 'b'])
    const snapshot = ctx.sessionProjections.snapshot(session)
    expect(snapshot.values['test/marks']).toEqual({ marks: ['a', 'b'] })
    expect(snapshot.asOfSeq).toBe(session.seq - 1)
  })

  it('builds the cell lazily from the full log for a unit registered after events flowed', async () => {
    const { ctx, session } = await harness()
    mark(session, ['pre-registration'])
    ctx.sessionProjections.register(marksUnit())
    expect(ctx.sessionProjections.snapshot(session).values['test/marks']).toEqual({ marks: ['pre-registration'] })
    // The lazily-built cell then continues on the live drive path.
    mark(session, ['after'])
    expect(ctx.sessionProjections.snapshot(session).values['test/marks']).toEqual({ marks: ['after'] })
  })

  it('serves init-derived state and asOfSeq -1 for an empty log', async () => {
    const { ctx, session } = await harness()
    ctx.sessionProjections.register(marksUnit())
    const snapshot = ctx.sessionProjections.snapshot(session)
    expect(snapshot.asOfSeq).toBe(-1)
    expect(snapshot.values['test/marks']).toEqual({ marks: [] })
  })

  it('notifies onChanged with the validated view and the causing seq, and skips same-reference applies', async () => {
    const { ctx, session } = await harness()
    ctx.sessionProjections.register(marksUnit())
    const seen: { key: string; value: unknown; seq: number; sessionId: string }[] = []
    ctx.sessionProjections.onChanged((changedSession, key, value, seq) => {
      seen.push({ key, value, seq, sessionId: String(changedSession.id) })
    })
    const event = mark(session, ['a'])
    // Non-matching event: apply returns the same reference — no notification.
    session.append('turn/start', { turn: 1 })
    expect(seen).toEqual([{ key: 'test/marks', value: { marks: ['a'] }, seq: event.seq, sessionId: String(session.id) }])
  })

  it('does not compute a view while no change listener exists', async () => {
    const { ctx, session } = await harness()
    const view = vi.fn((state: StableViewState) => state.value)
    ctx.sessionProjections.register(stableViewUnit(view))

    session.append('turn/start', { turn: 1 })
    session.append('turn/start', { turn: 2 })

    expect(ctx.sessionProjections.stateOf(session, 'test/stable-view')?.revision).toBe(2)
    expect(view).not.toHaveBeenCalled()
  })

  it('publishes the first observed view and suppresses later same-reference views', async () => {
    const { ctx, session } = await harness()
    const view = vi.fn((state: StableViewState) => state.value)
    ctx.sessionProjections.register(stableViewUnit(view))

    const seen: unknown[] = []
    ctx.sessionProjections.onChanged((_session, key, value) => {
      if (key === 'test/stable-view') seen.push(value)
    })

    session.append('turn/start', { turn: 1 })
    session.append('turn/start', { turn: 2 })

    expect(seen).toEqual([{ marks: [] }])
    expect(view).toHaveBeenCalledTimes(2)

    mark(session, ['changed'])
    expect(seen).toEqual([{ marks: [] }, { marks: ['changed'] }])
    expect(view).toHaveBeenCalledTimes(3)
  })

  it('publishes the first view after an unobserved state change', async () => {
    const { ctx, session } = await harness()
    const view = vi.fn((state: StableViewState) => state.value)
    ctx.sessionProjections.register(stableViewUnit(view))
    const first: unknown[] = []
    const stop = ctx.sessionProjections.onChanged((_session, key, value) => {
      if (key === 'test/stable-view') first.push(value)
    })

    session.append('turn/start', { turn: 1 })
    stop()
    session.append('turn/start', { turn: 2 })
    expect(view).toHaveBeenCalledTimes(1)

    const resumed: unknown[] = []
    ctx.sessionProjections.onChanged((_session, key, value) => {
      if (key === 'test/stable-view') resumed.push(value)
    })
    session.append('turn/start', { turn: 3 })

    expect(first).toEqual([{ marks: [] }])
    expect(resumed).toEqual([{ marks: [] }])
    expect(view).toHaveBeenCalledTimes(2)
  })

  it('matches every four-state identity sequence across listener gaps and raw-view identities', async () => {
    const { ctx } = await harness()
    const initialState: MarksState = { marks: ['initial'] }
    const stateByEvent = new Map<string, MarksState>()
    const viewByState = new Map<MarksState, MarksView>()
    const computedViews: MarksView[] = []
    ctx.sessionProjections.register({
      key: 'test/marks',
      stateSchema: marksViewSchema.nullable(),
      init: () => initialState,
      apply: (state, event) => {
        if (event.type !== 'test/mark') return state
        const token = event.data.marks[0]
        if (token === undefined || !stateByEvent.has(token)) return state
        return stateByEvent.get(token) as MarksState
      },
      wire: {
        viewSchema: marksViewSchema,
        view: (state) => {
          const value = viewByState.get(state)
          if (value === undefined) throw new Error('test state lacks a raw view')
          computedViews.push(value)
          return value
        },
      },
      stateVersion: 1,
    })

    const failures = new Map<string, unknown>()
    let mismatchCount = 0
    let checked = 0
    for (const stateSequence of STATE_SEQUENCES) {
      const stateCount = Math.max(...stateSequence) + 1
      for (const viewSequence of identitySequences(stateCount)) {
        for (const baselineKnown of [false, true]) {
          for (let listenerMask = 0; listenerMask < 8; listenerMask++) {
            const scenario = String(checked++)
            const states = Array.from(
              { length: stateCount },
              (_, index): MarksState => ({ marks: [`state-${scenario}-${String(index)}`] }),
            )
            const views = Array.from(
              { length: Math.max(...viewSequence) + 1 },
              (): MarksView => ({ marks: [] }),
            )
            for (let index = 0; index < stateCount; index++) {
              viewByState.set(states[index] as MarksState, views[viewSequence[index] as number] as MarksView)
            }
            for (let index = 0; index < stateSequence.length; index++) {
              stateByEvent.set(`${scenario}:${String(index)}`, states[stateSequence[index] as number] as MarksState)
            }

            const session = ctx.sessions.create()
            const notifications: number[] = []
            let stop: (() => void) | undefined
            const setListening = (listening: boolean): void => {
              if (listening && stop === undefined) {
                stop = ctx.sessionProjections.onChanged((changedSession, key, _value, seq) => {
                  if (changedSession === session && key === 'test/marks') notifications.push(seq)
                })
              } else if (!listening && stop !== undefined) {
                stop()
                stop = undefined
              }
            }

            setListening(baselineKnown)
            mark(session, [`${scenario}:0`])
            computedViews.length = 0
            notifications.length = 0

            const expectedViews: MarksView[] = []
            const expectedNotifications: number[] = []
            let comparable = baselineKnown
              ? views[viewSequence[stateSequence[0] as number] as number] as MarksView
              : undefined
            for (let index = 1; index < stateSequence.length; index++) {
              const listening = (listenerMask & (1 << (index - 1))) !== 0
              setListening(listening)
              const changed = stateSequence[index] !== stateSequence[index - 1]
              if (changed) {
                if (listening) {
                  const current = views[viewSequence[stateSequence[index] as number] as number] as MarksView
                  expectedViews.push(current)
                  if (comparable === undefined || !Object.is(comparable, current)) {
                    expectedNotifications.push(index)
                  }
                  comparable = current
                } else {
                  comparable = undefined
                }
              }
              mark(session, [`${scenario}:${String(index)}`])
            }
            setListening(false)

            if (!sameIdentities(computedViews, expectedViews)
              || notifications.length !== expectedNotifications.length
              || notifications.some((seq, index) => seq !== expectedNotifications[index])) {
              mismatchCount += 1
              const stateName = sequenceName(stateSequence, 'v')
              if (!failures.has(stateName) || (baselineKnown && listenerMask === 7)) {
                failures.set(stateName, {
                  state: stateName,
                  view: stateSequence.map(value => `r${String((viewSequence[value] as number) + 1)}`).join(','),
                  baseline: baselineKnown ? 'known' : 'unknown',
                  listeners: [0, 1, 2]
                    .map(index => (listenerMask & (1 << index)) === 0 ? 'off' : 'on')
                    .join(','),
                  expectedViewCalls: expectedViews.length,
                  actualViewCalls: computedViews.length,
                  expectedNotifications,
                  actualNotifications: [...notifications],
                })
              }
            }
            computedViews.length = 0
          }
        }
      }
    }

    expect({ checked, mismatchCount, failures: [...failures.values()] }).toEqual({
      checked: 960,
      mismatchCount: 0,
      failures: [],
    })
  })

  it('drives independently per session (cells are per-session watermarks)', async () => {
    const { ctx, session } = await harness()
    const other = ctx.sessions.create()
    ctx.sessionProjections.register(marksUnit())
    mark(session, ['one'])
    mark(other, ['two'])
    expect(ctx.sessionProjections.snapshot(session).values['test/marks']).toEqual({ marks: ['one'] })
    expect(ctx.sessionProjections.snapshot(other).values['test/marks']).toEqual({ marks: ['two'] })
  })

  it('updates host-only units without publishing them to wire listeners', async () => {
    const { ctx, session } = await harness()
    ctx.sessionProjections.register(marksUnit())
    ctx.sessionProjections.register(countUnit())
    const changedKeys: string[] = []
    ctx.sessionProjections.onChanged((_session, key) => {
      changedKeys.push(key)
    })
    session.append('turn/start', { turn: 1 })
    expect(changedKeys).toEqual([])
    expect(ctx.sessionProjections.stateOf(session, 'test/count')).toBe(1)
    expect(ctx.sessionProjections.snapshot(session).values).toEqual({ 'test/marks': { marks: [] } })
  })

  it('shares one unit between registrants of the same key', async () => {
    const { ctx, session } = await harness()
    ctx.sessionProjections.register(marksUnit())

    // One definition already serves every session (cells are keyed by
    // Session), and registrants are per-session now: an agent preset mounts
    // the same tool package once per agent.
    expect(() => ctx.sessionProjections.register(marksUnit())).not.toThrow()
    mark(session, ['kept'])
    expect(ctx.sessionProjections.snapshot(session).values['test/marks']).toEqual({ marks: ['kept'] })
  })

  it('keeps the unit until the last registrant releases it', async () => {
    const { ctx, session } = await harness()
    const first = ctx.sessionProjections.register(marksUnit())
    const second = ctx.sessionProjections.register(marksUnit())
    mark(session, ['kept'])

    first()

    // The regression this counts against: without last-release semantics, one
    // session ending strips the projection from every other live session,
    // because the first registrant owns the only disposer.
    expect(ctx.sessionProjections.snapshot(session).values['test/marks']).toEqual({ marks: ['kept'] })
    second()
    expect(ctx.sessionProjections.snapshot(session).values).toEqual({})
  })

  it('refuses to share a key across a stateVersion change', async () => {
    const { ctx } = await harness()
    ctx.sessionProjections.register(marksUnit())

    // The one incompatibility a runtime comparison can name: the versioned
    // contract says the cached state shape differs, so the two cannot share
    // cells. Everything else about a definition is functions.
    expect(() => ctx.sessionProjections.register({ ...marksUnit(), stateVersion: 9 }))
      .toThrow(/already registered at stateVersion 1; refusing to share it with stateVersion 9/)
  })

  it('rejects a non-integer or negative stateVersion at register time', async () => {
    const { ctx } = await harness()
    expect(() => ctx.sessionProjections.register({ ...marksUnit(), stateVersion: -1 })).toThrow(/stateVersion/)
    expect(() => ctx.sessionProjections.register({ ...marksUnit(), stateVersion: 1.5 })).toThrow(/stateVersion/)
  })

  it('register() disposer removes the key (with its cells) and frees it for re-registration', async () => {
    const { ctx, session } = await harness()
    const dispose = ctx.sessionProjections.register(marksUnit())
    mark(session, ['cached'])
    dispose()
    expect(ctx.sessionProjections.snapshot(session).values).toEqual({})
    ctx.sessionProjections.register(marksUnit())
    // Fresh registration rebuilds from the log, not from a stale cell.
    expect(ctx.sessionProjections.snapshot(session).values['test/marks']).toEqual({ marks: ['cached'] })
  })

  it('removes registrations and change listeners when their owning fiber unloads (HMR safety)', async () => {
    const { ctx, session } = await harness()
    const notifications: string[] = []
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      inner.sessionProjections.register(marksUnit())
      inner.sessionProjections.onChanged((_session, key) => {
        notifications.push(key)
      })
    }, { inject: ['sessionProjections'] }))
    mark(session, ['live'])
    expect(notifications).toEqual(['test/marks'])
    await fiber.dispose()
    mark(session, ['after-dispose'])
    expect(notifications).toEqual(['test/marks'])
    expect(ctx.sessionProjections.snapshot(session).values).toEqual({})
  })

  it('snapshot serves client views and excludes host-only state', async () => {
    const { ctx, session } = await harness()
    ctx.sessionProjections.register(marksUnit())
    ctx.sessionProjections.register(countUnit())
    mark(session, ['a', 'b'])
    const values = ctx.sessionProjections.snapshot(session).values
    expect(values['test/marks']).toEqual({ marks: ['a', 'b'] })
    expect('test/count' in values).toBe(false)
    expect(ctx.sessionProjections.stateOf(session, 'test/count')).toBe(1)
    expect('test/unregistered' in values).toBe(false)
  })

  it('checkpoints every persisted unit with its stateVersion and per-cell watermark', async () => {
    const { ctx, session } = await harness()
    ctx.sessionProjections.register(marksUnit())
    ctx.sessionProjections.register({ ...countUnit(), stateVersion: 7 })
    const markEvent = mark(session, ['a'])
    const rows = ctx.sessionProjections.checkpoint(session)
    expect(rows['test/marks']).toEqual({ ver: 1, seq: markEvent.seq, val: { marks: ['a'] } })
    expect(rows['test/count']).toEqual({ ver: 7, seq: markEvent.seq, val: 1 })
    // Empty log: init-derived state at watermark -1.
    const fresh = ctx.sessions.create()
    expect(ctx.sessionProjections.checkpoint(fresh)['test/marks']).toEqual({ ver: 1, seq: -1, val: null })
  })

  it('checkpoint states are detached clones — mutating them cannot corrupt the watermark cache', async () => {
    const { ctx, session } = await harness()
    ctx.sessionProjections.register(marksUnit())
    mark(session, ['a'])
    const rows = ctx.sessionProjections.checkpoint(session)
    // Hostile (or merely careless) consumer mutates the handed-out state.
    ;(rows['test/marks']?.val as { marks: string[] }).marks.push('INJECTED')
    // The registry's authoritative cell is untouched: snapshot and a fresh
    // checkpoint both still serve the committed value.
    expect(ctx.sessionProjections.snapshot(session).values['test/marks']).toEqual({ marks: ['a'] })
    expect(ctx.sessionProjections.checkpoint(session)['test/marks']?.val).toEqual({ marks: ['a'] })
  })

  it('restoreFloor anchors one below the lowest usable watermark and at 0 for missing or mismatched rows', async () => {
    const { ctx } = await harness()
    expect(ctx.sessionProjections.restoreFloor({})).toBeUndefined() // no unit registered
    ctx.sessionProjections.register(marksUnit())
    ctx.sessionProjections.register(countUnit())
    expect(ctx.sessionProjections.restoreFloor({})).toBe(0)
    // Lowest usable watermark is count's 5 → the anchored tail starts AT 5
    // (one below the first needed seq 6), so the read proves seq 5 still exists.
    expect(ctx.sessionProjections.restoreFloor({
      'test/marks': { ver: 1, seq: 10, val: { marks: [] } },
      'test/count': { ver: 1, seq: 5, val: 6 },
    })).toBe(5)
    // A version-mismatched row forces that key back to a full refold.
    expect(ctx.sessionProjections.restoreFloor({
      'test/marks': { ver: 2, seq: 10, val: { marks: [] } },
      'test/count': { ver: 1, seq: 5, val: 6 },
    })).toBe(0)
    // A fresh (-1) row still needs the whole tail from 0.
    expect(ctx.sessionProjections.restoreFloor({
      'test/marks': { ver: 1, seq: -1, val: null },
      'test/count': { ver: 1, seq: -1, val: 0 },
    })).toBe(0)
  })

  it('restore folds the tail past each usable row and refolds from init on version mismatch', async () => {
    const { ctx } = await harness()
    ctx.sessionProjections.register(marksUnit())
    ctx.sessionProjections.register(countUnit())
    const tail: SessionEvent[] = [
      { type: 'test/mark', seq: 3, time: 3, data: { marks: ['new'] } },
      { type: 'turn/end', seq: 4, time: 4, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    // marks row usable (watermark 2, tail starts at 3); count row mismatched — but
    // a mismatch with baseSeq > 0 cannot silently refold: it throws for a re-read.
    expect(() => ctx.sessionProjections.restore({
      'test/marks': { ver: 1, seq: 2, val: { marks: ['old'] } },
      'test/count': { ver: 99, seq: 2, val: 3 },
    }, tail, 3, RESTORE_HEADER)).toThrow(/re-read from seq 0/)
    // The full-log re-read (baseSeq 0) refolds the mismatched key from init.
    const full: SessionEvent[] = [
      { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
      { type: 'test/mark', seq: 1, time: 1, data: { marks: ['old'] } },
      { type: 'test/mark', seq: 2, time: 2, data: { marks: ['old', '2'] } },
      ...tail,
    ]
    const { snapshot, checkpoint } = ctx.sessionProjections.restore({
      'test/marks': { ver: 1, seq: 2, val: { marks: ['old', '2'] } },
      'test/count': { ver: 99, seq: 2, val: 3 },
    }, full, 0, RESTORE_HEADER)
    expect(snapshot.asOfSeq).toBe(4)
    expect(snapshot.values['test/marks']).toEqual({ marks: ['new'] })
    expect('test/count' in snapshot.values).toBe(false)
    // The refreshed rows sit at the served cut, ready for a durable write-back.
    expect(checkpoint['test/marks']).toEqual({ ver: 1, seq: 4, val: { marks: ['new'] } })
    expect(checkpoint['test/count']).toEqual({ ver: 1, seq: 4, val: 5 })
  })

  it('restore over a suffix folds only past each row watermark and serves an exact empty-tail cut', async () => {
    const { ctx } = await harness()
    ctx.sessionProjections.register(marksUnit())
    ctx.sessionProjections.register(countUnit())
    const rows = {
      'test/marks': { ver: 1, seq: 4, val: { marks: ['done'] } },
      'test/count': { ver: 1, seq: 2, val: 3 },
    }
    const tail: SessionEvent[] = [
      { type: 'turn/start', seq: 3, time: 3, data: { turn: 2 } },
      { type: 'turn/end', seq: 4, time: 4, data: { turn: 2, reason: { kind: 'completed' } } },
    ]
    const { snapshot, checkpoint } = ctx.sessionProjections.restore(rows, tail, 3, RESTORE_HEADER)
    expect(snapshot.asOfSeq).toBe(4)
    // marks already covers the tail (watermark 4): nothing re-applied.
    expect(snapshot.values['test/marks']).toEqual({ marks: ['done'] })
    // count folds exactly seqs 3 and 4 on top of its checkpoint, but remains host-only.
    expect(checkpoint['test/count']).toEqual({ ver: 1, seq: 4, val: 5 })
    expect('test/count' in snapshot.values).toBe(false)

    // Empty tail (checkpoint is current): the cut sits at baseSeq - 1.
    const { snapshot: current, checkpoint: currentCheckpoint } = ctx.sessionProjections.restore({
      'test/marks': { ver: 1, seq: 4, val: { marks: ['done'] } },
      'test/count': { ver: 1, seq: 4, val: 5 },
    }, [], 5, RESTORE_HEADER)
    expect(current.asOfSeq).toBe(4)
    expect('test/count' in current.values).toBe(false)
    expect(currentCheckpoint['test/count']).toEqual({ ver: 1, seq: 4, val: 5 })
  })

  it('viewCheckpoint serves version-matching rows without any log and skips mismatched keys', async () => {
    const { ctx } = await harness()
    ctx.sessionProjections.register(marksUnit())
    ctx.sessionProjections.register(countUnit())
    const values = ctx.sessionProjections.viewCheckpoint({
      'test/marks': { ver: 1, seq: 4, val: { marks: ['stored'] } },
      'test/count': { ver: 99, seq: 4, val: 5 }, // mismatched: absent
    })
    expect(values['test/marks']).toEqual({ marks: ['stored'] })
    expect('test/count' in values).toBe(false)
    expect(ctx.sessionProjections.viewCheckpoint({})).toEqual({})
  })

  it('viewCheckpoint and restore exclude host-only state while retaining its checkpoint', async () => {
    const { ctx } = await harness()
    ctx.sessionProjections.register(marksUnit())
    ctx.sessionProjections.register(countUnit())
    const rows = {
      'test/marks': { ver: 1, seq: 4, val: { marks: ['stored'] } },
      'test/count': { ver: 1, seq: 4, val: 5 },
    }
    expect(ctx.sessionProjections.viewCheckpoint(rows)).toEqual({
      'test/marks': { marks: ['stored'] },
    })

    const restored = ctx.sessionProjections.restore(rows, [], 5, RESTORE_HEADER)
    expect(restored.snapshot.values).toEqual({
      'test/marks': { marks: ['stored'] },
    })
    expect(restored.checkpoint['test/count']).toEqual(rows['test/count'])
  })

  it('rejects version-matching rows whose state no longer matches the registered schema', async () => {
    const { ctx } = await harness()
    ctx.sessionProjections.register(marksUnit())
    const drifted = {
      'test/marks': { ver: 1, seq: 2, val: { marks: 'not-an-array' } },
    }

    expect(ctx.sessionProjections.viewCheckpoint(drifted)).toEqual({})
    expect(() => ctx.sessionProjections.restore(drifted, [], 3, RESTORE_HEADER)).toThrow()
  })

  it('restore rejects a row claiming events past the supplied log end (shrunk log ⇒ re-read)', async () => {
    const { ctx } = await harness()
    ctx.sessionProjections.register(countUnit())
    const rows = { 'test/count': { ver: 1, seq: 9, val: 10 } }
    // The anchored floor sits ON the watermark, so the tail read must return
    // at least seq 9 from an intact log…
    const floor = ctx.sessionProjections.restoreFloor(rows)
    expect(floor).toBe(9)
    // …an intact log serves the anchor event and the checkpoint stands as-is.
    const anchor: SessionEvent = { type: 'turn/end', seq: 9, time: 9, data: { turn: 2, reason: { kind: 'completed' } } }
    const anchored = ctx.sessionProjections.restore(rows, [anchor], 9, RESTORE_HEADER)
    expect(anchored.snapshot.values).toEqual({})
    expect(anchored.checkpoint['test/count']).toEqual({ ver: 1, seq: 9, val: 10 })
    // …while a log crash-repaired down to fewer events returns an empty tail:
    // the row overreaches the proven end and a tail read cannot fix this key.
    expect(() => ctx.sessionProjections.restore(rows, [], 9, RESTORE_HEADER)).toThrow(/re-read from seq 0/)
    // The full re-read discards the overreaching row and refolds from init.
    const events: SessionEvent[] = [
      { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
      { type: 'turn/end', seq: 1, time: 1, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    const { snapshot, checkpoint } = ctx.sessionProjections.restore(rows, events, 0, RESTORE_HEADER)
    expect(snapshot.asOfSeq).toBe(1)
    expect(snapshot.values).toEqual({})
    expect(checkpoint['test/count']).toEqual({ ver: 1, seq: 1, val: 2 })
  })

  it('fails loud when a unit view violates its own schema (async unit output is unrepresentable)', async () => {
    const { ctx, session } = await harness()
    ctx.sessionProjections.register({
      key: 'test/marks',
      stateSchema: z.object({ marks: z.array(z.string()) }).nullable(),
      init: () => null as MarksState,
      apply: state => state,
      wire: {
        viewSchema: z.object({ marks: z.array(z.string()) }),
        // A Promise (what an accidentally-async view would return) is not the
        // declared shape: the boundary parse rejects it before it leaves.
        view: () => Promise.resolve({ marks: [] }) as never,
      },
      stateVersion: 1,
    })
    expect(() => ctx.sessionProjections.snapshot(session)).toThrow()
  })
})
