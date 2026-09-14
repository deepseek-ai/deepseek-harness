/** Goal activation observable that orders Remote reads and live activation events. */

import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  GoalActivationChanged, GoalProjection, GoalRef, GoalView,
} from '@deepseek-ai/dsh-goal/client'
import type { GoalActivationSnapshot } from './slots.ts'

/** Live inputs for one Session's goal activation source. */
export interface GoalActivationDeps {
  /** Durable projection used to derive the current active goal ref. */
  readonly projection: HostObservable<GoalProjection | null | undefined>
  /** Session snapshot; running flips trigger a fresh authoritative read. */
  readonly session: HostObservable<{ readonly running: boolean }>
  /** Read the current live goal at call time. */
  readonly getGoal: () => Promise<RemoteResult<GoalView | undefined>>
  /** Subscribe to activation edges after the transport delivers them. */
  readonly subscribeActivation: (listener: (goal: GoalActivationChanged['goal']) => void) => () => void
  /** Refresh after a connection-generation reset. */
  readonly subscribeReset: (listener: () => void) => () => void
}

/** Compare two empty-or-populated activation snapshots by value. */
function sameSnapshot(left: GoalActivationSnapshot, right: GoalActivationSnapshot): boolean {
  return left.id === right.id && left.revision === right.revision && left.activation === right.activation
}

/** Return the current active CAS ref, or undefined when the goal is not active. */
function activeRef(projection: GoalProjection | null | undefined): GoalRef | undefined {
  return projection?.goal.phase === 'active' ? projection.goal : undefined
}

/**
 * Create one registrant-private activation source. The source subscribes only
 * while a framework hook observes it, so unmount releases the Remote event,
 * projection, running-snapshot, and reset listeners.
 * @param deps - projection, session, Remote read, and live-event inputs.
 * @returns stable snapshot source consumed by `useGoalActivation`.
 */
export function createGoalActivationSource(deps: GoalActivationDeps): HostObservable<GoalActivationSnapshot> {
  let snapshot: GoalActivationSnapshot = {}
  let subscriptions = 0
  let disposers: readonly (() => void)[] = []
  let running = deps.session.getSnapshot().running
  let eventEpoch = 0
  let projectionEpoch = 0
  let readEpoch = 0
  const listeners = new Set<() => void>()

  const publish = (next: GoalActivationSnapshot): void => {
    if (sameSnapshot(snapshot, next)) return
    snapshot = next
    for (const listener of listeners) listener()
  }

  const startRead = (ref: GoalRef | undefined): void => {
    if (ref === undefined) return
    const read = ++readEpoch
    const startedAtEvent = eventEpoch
    const startedAtProjection = projectionEpoch
    void deps.getGoal().then((result) => {
      if (read !== readEpoch || startedAtEvent !== eventEpoch || startedAtProjection !== projectionEpoch) return
      if (!result.ok) return
      const goal = result.value
      /* v8 ignore next 4 -- projection drive is the authoritative clear edge; an active projection with no live goal is transient. */
      if (goal === undefined) {
        if (activeRef(deps.projection.getSnapshot()) === undefined) publish({})
        return
      }
      publish({ id: goal.id, revision: goal.revision, activation: goal.activation })
    })
  }

  const refreshProjection = (): void => {
    projectionEpoch++
    const ref = activeRef(deps.projection.getSnapshot())
    if (ref === undefined) {
      /* v8 ignore next -- clearing an already-empty activation snapshot is idempotent. */
      if (snapshot.id !== undefined) publish({})
      return
    }
    if (snapshot.id !== ref.id || snapshot.revision !== ref.revision) {
      publish({ id: ref.id, revision: ref.revision })
    }
    startRead(ref)
  }

  const onActivation = (goal: GoalActivationChanged['goal']): void => {
    eventEpoch++
    readEpoch++
    publish(goal === undefined
      ? {}
      : { id: goal.id, revision: goal.revision, activation: goal.activation })
  }

  const onRunning = (): void => {
    const next = deps.session.getSnapshot().running
    if (next === running) return
    running = next
    startRead(activeRef(deps.projection.getSnapshot()))
  }

  const onReset = (): void => {
    eventEpoch++
    projectionEpoch++
    startRead(activeRef(deps.projection.getSnapshot()))
  }

  const start = (): void => {
    disposers = [
      deps.projection.subscribe(refreshProjection),
      deps.session.subscribe(onRunning),
      deps.subscribeActivation(onActivation),
      deps.subscribeReset(onReset),
    ]
    running = deps.session.getSnapshot().running
    refreshProjection()
  }

  const stop = (): void => {
    for (const dispose of disposers) dispose()
    disposers = []
    readEpoch++
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      if (subscriptions === 0) start()
      subscriptions++
      return () => {
        listeners.delete(listener)
        subscriptions--
        if (subscriptions === 0) stop()
      }
    },
  }
}
