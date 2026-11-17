// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionPanelRoom } from '../src/client/slots.ts'
import { DOCKS_STORAGE_KEY, PINNED_STORAGE_KEY, SessionPanelState, hasRoom, presentationOf } from '../src/client/visibility.ts'

const A = 'session-a' as SessionId
const B = 'session-b' as SessionId

/** What the stubbed ResizeObserver holds for each observed probe element. */
interface Observation {
  /** Deliver one size report for the element. */
  readonly report: (width: number) => void
  /** Whether the observer was disconnected. */
  disconnected: boolean
}

const observations = new Map<Element, Observation>()
let nextProbe = 0

beforeEach(() => {
  localStorage.clear()
  observations.clear()
  vi.stubGlobal('ResizeObserver', class {
    private readonly callback: ResizeObserverCallback
    private readonly targets: Observation[] = []
    constructor(callback: ResizeObserverCallback) { this.callback = callback }
    observe(element: Element): void {
      const observation: Observation = {
        report: (width) => { this.callback([{ target: element, contentRect: { width } } as ResizeObserverEntry], {} as ResizeObserver) },
        disconnected: false,
      }
      this.targets.push(observation)
      observations.set(element, observation)
    }

    unobserve(): void {}
    disconnect(): void { for (const observation of this.targets) observation.disconnected = true }
  })
})

afterEach(() => {
  localStorage.clear()
  vi.unstubAllGlobals()
})

/**
 * One mounted panel's two probes under one id: a size report for each
 * element and their detachment, as the panel's refs drive them.
 */
function probeOf(state: SessionPanelState, sessionId: SessionId, room: Partial<SessionPanelRoom> = {}) {
  nextProbe += 1
  const id = `probe-${nextProbe}`
  const attach = (member: keyof SessionPanelRoom) => {
    const element = document.createElement('span')
    const ref = state.createProbeRef(sessionId, id, member)
    ref(element)
    const observation = observations.get(element)
    if (observation === undefined) throw new Error('the probe element is not observed')
    if (room[member] === true) observation.report(1)
    return { observation, resize: observation.report, detach: () => { ref(null) } }
  }
  const gutter = attach('gutter')
  const reserve = attach('reserve')
  return {
    id,
    gutter,
    reserve,
    /** Report the gutter probe's width. */
    resize: gutter.resize,
    /** Detach both probes, as the panel's unmount does. */
    detach: () => {
      gutter.detach()
      reserve.detach()
    },
  }
}

/** A state whose Chat Views show `A` and `B` without room to dock. */
function newState() {
  const state = new SessionPanelState()
  return { state, a: probeOf(state, A), b: probeOf(state, B) }
}

const NONE: SessionPanelRoom = { gutter: false, reserve: false }
const GUTTER: SessionPanelRoom = { gutter: true, reserve: false }
const RESERVE: SessionPanelRoom = { gutter: false, reserve: true }
const BOTH: SessionPanelRoom = { gutter: true, reserve: true }

describe('hasRoom', () => {
  it.each([
    [undefined, false, false],
    [undefined, true, false],
    [NONE, true, false],
    [GUTTER, false, true],
    [RESERVE, false, false],
    [RESERVE, true, true],
    [BOTH, false, true],
  ] as const)('room=%j pinned=%s is %s', (room, pinned, expected) => {
    expect(hasRoom(room, { docks: true, pinned, overlay: null })).toBe(expected)
  })
})

describe('presentationOf', () => {
  it.each([
    [GUTTER, true, false, null, 'docked'],
    [GUTTER, true, false, A, 'docked'],
    [GUTTER, false, false, null, 'hidden'],
    [GUTTER, false, false, A, 'hidden'],
    [NONE, true, false, null, 'hidden'],
    [NONE, false, false, null, 'hidden'],
    [NONE, true, false, A, 'overlay'],
    [NONE, false, false, A, 'overlay'],
    [NONE, true, false, B, 'hidden'],
    [undefined, true, true, A, 'overlay'],
    // The transcript can make room: that docks a pinned panel and leaves an unpinned one to the overlay.
    [RESERVE, true, true, null, 'docked'],
    [RESERVE, false, true, A, 'hidden'],
    [RESERVE, true, false, null, 'hidden'],
    [RESERVE, true, false, A, 'overlay'],
    [NONE, true, true, A, 'overlay'],
  ] as const)('room=%j docks=%s pinned=%s overlay=%s shows %s', (room, docks, pinned, overlay, expected) => {
    expect(presentationOf(room, { docks, pinned, overlay }, A)).toBe(expected)
  })
})

describe('SessionPanelState room probes', () => {
  it('enters attached probes without room and gives each its room from 1px of width', () => {
    const state = new SessionPanelState()
    expect(state.probes.getSnapshot().size).toBe(0)
    const probe = probeOf(state, A)
    expect(state.probes.getSnapshot().get(probe.id)).toEqual(NONE)
    expect(state.dockable.getSnapshot().get(A)).toEqual(NONE)
    // Within a pixel below the gutter that docks the panel the probe is narrower than 1px.
    probe.resize(0.5)
    expect(state.probes.getSnapshot().get(probe.id)).toEqual(NONE)
    probe.resize(1)
    expect(state.probes.getSnapshot().get(probe.id)).toEqual(GUTTER)
    expect(state.dockable.getSnapshot().get(A)).toEqual(GUTTER)
    probe.reserve.resize(1)
    expect(state.probes.getSnapshot().get(probe.id)).toEqual(BOTH)
    probe.resize(0)
    expect(state.probes.getSnapshot().get(probe.id)).toEqual(RESERVE)
    expect(state.dockable.getSnapshot().get(A)).toEqual(RESERVE)
  })

  it('gives a Session each room while any of its panels has it, and drops the Session once its last probe detaches', () => {
    const state = new SessionPanelState()
    const main = probeOf(state, A, { gutter: true })
    const embedded = probeOf(state, A, { reserve: true })
    const other = probeOf(state, B)
    expect(state.probes.getSnapshot()).toEqual(new Map([[main.id, GUTTER], [embedded.id, RESERVE], [other.id, NONE]]))
    expect(state.dockable.getSnapshot()).toEqual(new Map([[A, BOTH], [B, NONE]]))
    main.detach()
    expect(main.gutter.observation.disconnected).toBe(true)
    expect(state.probes.getSnapshot()).toEqual(new Map([[embedded.id, RESERVE], [other.id, NONE]]))
    expect(state.dockable.getSnapshot().get(A)).toEqual(RESERVE)
    embedded.resize(1)
    expect(state.dockable.getSnapshot().get(A)).toEqual(BOTH)
    embedded.detach()
    expect(state.dockable.getSnapshot().has(A)).toBe(false)
    expect(state.probes.getSnapshot().size).toBe(1)
    // A second detachment of the same elements withdraws nothing more.
    const before = state.dockable.getSnapshot()
    embedded.detach()
    expect(state.dockable.getSnapshot()).toBe(before)
  })

  it('keeps a panel entered while one of its probes stays attached, with no room from the withdrawn one', () => {
    const state = new SessionPanelState()
    const probe = probeOf(state, A, { gutter: true, reserve: true })
    probe.gutter.detach()
    expect(state.probes.getSnapshot().get(probe.id)).toEqual(RESERVE)
    expect(state.dockable.getSnapshot().get(A)).toEqual(RESERVE)
    probe.reserve.detach()
    expect(state.probes.getSnapshot().has(probe.id)).toBe(false)
    expect(state.dockable.getSnapshot().has(A)).toBe(false)
  })

  it('publishes only when a probe flips or a Session changes its room', () => {
    const state = new SessionPanelState()
    const main = probeOf(state, A, { gutter: true })
    const probes = state.probes.getSnapshot()
    const dockable = state.dockable.getSnapshot()
    let probeCalls = 0
    let sessionCalls = 0
    const offProbes = state.probes.subscribe(() => { probeCalls += 1 })
    const offSessions = state.dockable.subscribe(() => { sessionCalls += 1 })
    main.resize(1)
    main.reserve.resize(0)
    expect(state.probes.getSnapshot()).toBe(probes)
    expect(state.dockable.getSnapshot()).toBe(dockable)
    // A second Chat View without room changes the probes, not the Session's room.
    const embedded = probeOf(state, A)
    expect([probeCalls, sessionCalls]).toEqual([1, 0])
    main.resize(0)
    expect([probeCalls, sessionCalls]).toEqual([2, 1])
    embedded.detach()
    expect([probeCalls, sessionCalls]).toEqual([3, 1])
    offProbes()
    offSessions()
  })

  it('keeps a probe without room where ResizeObserver is missing', () => {
    vi.stubGlobal('ResizeObserver', undefined)
    const state = new SessionPanelState()
    const ref = state.createProbeRef(A, 'unobserved', 'gutter')
    ref(document.createElement('span'))
    expect(state.probes.getSnapshot().get('unobserved')).toEqual(NONE)
    expect(state.dockable.getSnapshot().get(A)).toEqual(NONE)
    ref(null)
    expect(state.dockable.getSnapshot().has(A)).toBe(false)
  })

  it('stops observing every attached probe on dispose, after which a detachment withdraws nothing', () => {
    const { state, a, b } = newState()
    state.dispose()
    expect([a.gutter, a.reserve, b.gutter, b.reserve].map(probe => probe.observation.disconnected)).toEqual([true, true, true, true])
    expect(state.probes.getSnapshot().size).toBe(0)
    expect(state.dockable.getSnapshot().size).toBe(0)
    const before = state.probes.getSnapshot()
    a.detach()
    expect(state.probes.getSnapshot()).toBe(before)
  })
})

describe('SessionPanelState visibility', () => {
  it('docks unpinned by default and keeps the snapshot identity until a member changes', () => {
    const { state } = newState()
    const first = state.visibility.getSnapshot()
    expect(first).toEqual({ docks: true, pinned: false, overlay: null })
    expect(state.visibility.getSnapshot()).toBe(first)
  })

  it('flips and persists the docking preference when the gutter has room, closing any overlay', () => {
    const { state, a } = newState()
    state.toggle(A)
    expect(state.visibility.getSnapshot().overlay).toBe(A)
    a.resize(1)
    expect(state.visibility.getSnapshot().overlay).toBeNull()
    state.toggle(A)
    expect(state.visibility.getSnapshot()).toEqual({ docks: false, pinned: false, overlay: null })
    expect(localStorage.getItem(DOCKS_STORAGE_KEY)).toBe('false')
    expect(new SessionPanelState().visibility.getSnapshot().docks).toBe(false)
    state.toggle(A)
    expect(state.visibility.getSnapshot().docks).toBe(true)
  })

  it('opens and closes one Session overlay without touching the docking preference', () => {
    const { state } = newState()
    state.toggle(A)
    state.toggle(B)
    expect(state.visibility.getSnapshot()).toEqual({ docks: true, pinned: false, overlay: B })
    state.closeOverlay(A)
    expect(state.visibility.getSnapshot().overlay).toBe(B)
    state.toggle(B)
    expect(state.visibility.getSnapshot().overlay).toBeNull()
    state.toggle(A)
    state.closeOverlay(A)
    expect(state.visibility.getSnapshot().overlay).toBeNull()
  })

  it('ignores the toggle of a Session that no Chat View shows', () => {
    const state = new SessionPanelState()
    const before = state.visibility.getSnapshot()
    state.toggle(A)
    expect(state.visibility.getSnapshot()).toBe(before)
  })

  it('treats a stored docking value other than false, and a stored pin other than true, as the default', () => {
    localStorage.setItem(DOCKS_STORAGE_KEY, '"yes"')
    localStorage.setItem(PINNED_STORAGE_KEY, '"yes"')
    expect(newState().state.visibility.getSnapshot()).toEqual({ docks: true, pinned: false, overlay: null })
  })

  it('notifies subscribers of every member and stops after unsubscribe', () => {
    const { state, a } = newState()
    let calls = 0
    const off = state.visibility.subscribe(() => { calls += 1 })
    state.toggle(A)
    a.resize(1)
    state.toggle(A)
    state.setPinned(A, true)
    const seen = calls
    expect(seen).toBeGreaterThanOrEqual(4)
    off()
    state.toggle(A)
    state.setPinned(A, false)
    expect(calls).toBe(seen)
  })

  it('closes an overlay once its gutter can dock the panel, without reopening it when the gutter narrows again', () => {
    const { state, a } = newState()
    state.toggle(A)
    a.resize(0.5)
    expect(state.visibility.getSnapshot().overlay).toBe(A)
    a.resize(1)
    expect(state.visibility.getSnapshot()).toEqual({ docks: true, pinned: false, overlay: null })
    a.resize(0)
    expect(presentationOf(state.dockable.getSnapshot().get(A), state.visibility.getSnapshot(), A)).toBe('hidden')
  })

  it('closes an overlay once no Chat View shows its Session, so returning to it shows no overlay', () => {
    const { state, a } = newState()
    state.toggle(A)
    a.detach()
    expect(state.visibility.getSnapshot().overlay).toBeNull()
    probeOf(state, A)
    expect(presentationOf(state.dockable.getSnapshot().get(A), state.visibility.getSnapshot(), A)).toBe('hidden')
  })

  it('follows only the open overlay, and nothing after dispose', () => {
    const { state, a } = newState()
    state.toggle(A)
    state.toggle(B)
    // A's Chat View no longer matters once B holds the overlay.
    a.detach()
    expect(state.visibility.getSnapshot().overlay).toBe(B)
    // Dispose withdraws B's probe too, but nothing follows the overlay any longer.
    state.dispose()
    expect(state.dockable.getSnapshot().has(B)).toBe(false)
    expect(state.visibility.getSnapshot().overlay).toBe(B)
  })
})

describe('SessionPanelState pin', () => {
  const shown = (state: SessionPanelState, sessionId: SessionId) =>
    presentationOf(state.dockable.getSnapshot().get(sessionId), state.visibility.getSnapshot(), sessionId)

  it('docks an overlay whose transcript can make room, and persists the pin', () => {
    const { state, a } = newState()
    a.reserve.resize(1)
    // Unpinned, the room the transcript could make docks nothing.
    state.toggle(A)
    expect(shown(state, A)).toBe('overlay')
    state.setPinned(A, true)
    expect(state.visibility.getSnapshot()).toEqual({ docks: true, pinned: true, overlay: null })
    expect(shown(state, A)).toBe('docked')
    expect(localStorage.getItem(PINNED_STORAGE_KEY)).toBe('true')
    expect(new SessionPanelState().visibility.getSnapshot().pinned).toBe(true)
  })

  it('sets the docking preference with the pin, so a hidden panel shows again', () => {
    const { state, a } = newState()
    a.resize(1)
    state.toggle(A)
    expect(shown(state, A)).toBe('hidden')
    state.setPinned(A, true)
    expect(state.visibility.getSnapshot()).toEqual({ docks: true, pinned: true, overlay: null })
    expect(shown(state, A)).toBe('docked')
  })

  it('hides and shows a pinned panel from the toggle without unpinning it', () => {
    const { state, a } = newState()
    a.reserve.resize(1)
    state.setPinned(A, true)
    state.toggle(A)
    expect(state.visibility.getSnapshot()).toEqual({ docks: false, pinned: true, overlay: null })
    expect(shown(state, A)).toBe('hidden')
    state.toggle(A)
    expect(shown(state, A)).toBe('docked')
  })

  it('leaves a pinned panel to the overlay where the transcript cannot make room, and docks it again once it can', () => {
    const { state, a } = newState()
    state.setPinned(A, true)
    expect(shown(state, A)).toBe('hidden')
    state.toggle(A)
    expect(shown(state, A)).toBe('overlay')
    a.reserve.resize(1)
    expect(state.visibility.getSnapshot().overlay).toBeNull()
    expect(shown(state, A)).toBe('docked')
    a.reserve.resize(0)
    expect(shown(state, A)).toBe('hidden')
  })

  it('keeps a panel that only the pin held beside the transcript open as the overlay when unpinned', () => {
    const { state, a } = newState()
    a.reserve.resize(1)
    state.setPinned(A, true)
    state.setPinned(A, false)
    expect(state.visibility.getSnapshot()).toEqual({ docks: true, pinned: false, overlay: A })
    expect(shown(state, A)).toBe('overlay')
    expect(localStorage.getItem(PINNED_STORAGE_KEY)).toBe('false')
    // The overlay follows its Session as any other: it closes once the gutter docks the panel.
    a.resize(1)
    expect(state.visibility.getSnapshot().overlay).toBeNull()
  })

  it('opens no overlay when unpinning a panel its gutter holds, a hidden one, an overlay, or one no Chat View shows', () => {
    const { state, a } = newState()
    a.reserve.resize(1)
    a.resize(1)
    state.setPinned(A, true)
    state.setPinned(A, false)
    expect(state.visibility.getSnapshot()).toEqual({ docks: true, pinned: false, overlay: null })
    // Hidden from the toggle while pinned.
    a.resize(0)
    state.setPinned(A, true)
    state.toggle(A)
    state.setPinned(A, false)
    expect(state.visibility.getSnapshot()).toEqual({ docks: false, pinned: false, overlay: null })
    // Pinned where the transcript cannot make room: the open overlay stays the overlay.
    a.reserve.resize(0)
    state.setPinned(A, true)
    state.toggle(A)
    state.setPinned(A, false)
    expect(state.visibility.getSnapshot()).toEqual({ docks: true, pinned: false, overlay: A })
    state.closeOverlay(A)
    a.detach()
    state.setPinned(A, true)
    state.setPinned(A, false)
    expect(state.visibility.getSnapshot()).toEqual({ docks: true, pinned: false, overlay: null })
  })
})
