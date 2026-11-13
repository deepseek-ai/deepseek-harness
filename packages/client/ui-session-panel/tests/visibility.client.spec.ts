// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { PINNED_STORAGE_KEY, SessionPanelState, presentationOf } from '../src/client/visibility.ts'

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
 * One mounted panel's dock probe: its id, a size report for its element, and
 * its detachment, as the panel's ref drives them.
 */
function probeOf(state: SessionPanelState, sessionId: SessionId, width = 0) {
  nextProbe += 1
  const id = `probe-${nextProbe}`
  const element = document.createElement('span')
  const ref = state.createProbeRef(sessionId, id)
  ref(element)
  const observation = observations.get(element)
  if (observation === undefined) throw new Error('the probe element is not observed')
  if (width > 0) observation.report(width)
  return { id, element, observation, resize: observation.report, detach: () => { ref(null) } }
}

/** A state whose Chat Views show `A` and `B` without room to dock. */
function newState() {
  const state = new SessionPanelState()
  return { state, a: probeOf(state, A), b: probeOf(state, B) }
}

describe('presentationOf', () => {
  it.each([
    [true, true, null, 'docked'],
    [true, true, A, 'docked'],
    [true, false, null, 'hidden'],
    [true, false, A, 'hidden'],
    [false, true, null, 'hidden'],
    [false, false, null, 'hidden'],
    [false, true, A, 'overlay'],
    [false, false, A, 'overlay'],
    [false, true, B, 'hidden'],
  ] as const)('fits=%s pinned=%s overlay=%s shows %s', (fits, pinned, overlay, expected) => {
    expect(presentationOf(fits, { pinned, overlay }, A)).toBe(expected)
  })
})

describe('SessionPanelState dock probes', () => {
  it('enters an attached probe without room and gives it room from 1px of width', () => {
    const state = new SessionPanelState()
    expect(state.probes.getSnapshot().size).toBe(0)
    const probe = probeOf(state, A)
    expect(state.probes.getSnapshot().get(probe.id)).toBe(false)
    expect(state.dockable.getSnapshot().get(A)).toBe(false)
    // Within a pixel below the gutter that docks the panel the probe is narrower than 1px.
    probe.resize(0.5)
    expect(state.probes.getSnapshot().get(probe.id)).toBe(false)
    probe.resize(1)
    expect(state.probes.getSnapshot().get(probe.id)).toBe(true)
    expect(state.dockable.getSnapshot().get(A)).toBe(true)
    probe.resize(0)
    expect(state.probes.getSnapshot().get(probe.id)).toBe(false)
    expect(state.dockable.getSnapshot().get(A)).toBe(false)
  })

  it('gives a Session room while any of its probes has it, and drops the Session once its last probe detaches', () => {
    const state = new SessionPanelState()
    const main = probeOf(state, A, 1)
    const embedded = probeOf(state, A)
    expect(state.probes.getSnapshot()).toEqual(new Map([[main.id, true], [embedded.id, false]]))
    expect(state.dockable.getSnapshot().get(A)).toBe(true)
    main.detach()
    expect(main.observation.disconnected).toBe(true)
    expect(state.probes.getSnapshot()).toEqual(new Map([[embedded.id, false]]))
    expect(state.dockable.getSnapshot().get(A)).toBe(false)
    embedded.resize(1)
    expect(state.dockable.getSnapshot().get(A)).toBe(true)
    embedded.detach()
    expect(state.dockable.getSnapshot().has(A)).toBe(false)
    expect(state.probes.getSnapshot().size).toBe(0)
    // A second detachment of the same element withdraws nothing more.
    const before = state.dockable.getSnapshot()
    embedded.detach()
    expect(state.dockable.getSnapshot()).toBe(before)
  })

  it('publishes only when a probe flips or a Session changes its room', () => {
    const state = new SessionPanelState()
    const main = probeOf(state, A, 1)
    const probes = state.probes.getSnapshot()
    const dockable = state.dockable.getSnapshot()
    let probeCalls = 0
    let sessionCalls = 0
    const offProbes = state.probes.subscribe(() => { probeCalls += 1 })
    const offSessions = state.dockable.subscribe(() => { sessionCalls += 1 })
    main.resize(1)
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
    const ref = state.createProbeRef(A, 'unobserved')
    ref(document.createElement('span'))
    expect(state.probes.getSnapshot().get('unobserved')).toBe(false)
    expect(state.dockable.getSnapshot().get(A)).toBe(false)
    ref(null)
    expect(state.dockable.getSnapshot().has(A)).toBe(false)
  })

  it('stops observing every attached probe on dispose, after which a detachment withdraws nothing', () => {
    const { state, a, b } = newState()
    state.dispose()
    expect([a.observation.disconnected, b.observation.disconnected]).toEqual([true, true])
    expect(state.probes.getSnapshot().size).toBe(0)
    expect(state.dockable.getSnapshot().size).toBe(0)
    const before = state.probes.getSnapshot()
    a.detach()
    expect(state.probes.getSnapshot()).toBe(before)
  })
})

describe('SessionPanelState visibility', () => {
  it('docks by default and keeps the snapshot identity until a member changes', () => {
    const { state } = newState()
    const first = state.visibility.getSnapshot()
    expect(first).toEqual({ pinned: true, overlay: null })
    expect(state.visibility.getSnapshot()).toBe(first)
  })

  it('flips and persists the docking preference when the gutter has room, closing any overlay', () => {
    const { state, a } = newState()
    state.toggle(A)
    expect(state.visibility.getSnapshot().overlay).toBe(A)
    a.resize(1)
    expect(state.visibility.getSnapshot().overlay).toBeNull()
    state.toggle(A)
    expect(state.visibility.getSnapshot()).toEqual({ pinned: false, overlay: null })
    expect(localStorage.getItem(PINNED_STORAGE_KEY)).toBe('false')
    expect(new SessionPanelState().visibility.getSnapshot().pinned).toBe(false)
    state.toggle(A)
    expect(state.visibility.getSnapshot().pinned).toBe(true)
  })

  it('opens and closes one Session overlay without touching the docking preference', () => {
    const { state } = newState()
    state.toggle(A)
    state.toggle(B)
    expect(state.visibility.getSnapshot()).toEqual({ pinned: true, overlay: B })
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

  it('treats a stored value other than false as the default', () => {
    localStorage.setItem(PINNED_STORAGE_KEY, '"yes"')
    expect(newState().state.visibility.getSnapshot().pinned).toBe(true)
  })

  it('notifies subscribers of both members and stops after unsubscribe', () => {
    const { state, a } = newState()
    let calls = 0
    const off = state.visibility.subscribe(() => { calls += 1 })
    state.toggle(A)
    a.resize(1)
    state.toggle(A)
    const seen = calls
    expect(seen).toBeGreaterThanOrEqual(2)
    off()
    state.toggle(A)
    expect(calls).toBe(seen)
  })

  it('closes an overlay once its gutter can dock the panel, without reopening it when the gutter narrows again', () => {
    const { state, a } = newState()
    state.toggle(A)
    a.resize(0.5)
    expect(state.visibility.getSnapshot().overlay).toBe(A)
    a.resize(1)
    expect(state.visibility.getSnapshot()).toEqual({ pinned: true, overlay: null })
    a.resize(0)
    expect(presentationOf(false, state.visibility.getSnapshot(), A)).toBe('hidden')
  })

  it('closes an overlay once no Chat View shows its Session, so returning to it shows no overlay', () => {
    const { state, a } = newState()
    state.toggle(A)
    a.detach()
    expect(state.visibility.getSnapshot().overlay).toBeNull()
    probeOf(state, A)
    expect(presentationOf(false, state.visibility.getSnapshot(), A)).toBe('hidden')
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
