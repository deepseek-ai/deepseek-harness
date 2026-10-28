/** The forge facts a Session row shows, from the Session list and the change request states every row shares. */

import { useMemo } from 'react'
import type { HostObservable, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { UseSessions } from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-experimental-forge-session/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionProjectionSummaryValues } from '@deepseek-ai/dsh-session-projection/types'
import type { ForgeChangeRequestListState, ForgeSessionWorktree } from '../types.ts'
import type { StreamSnapshot } from './source.ts'
import { toneOf, type ChangeRequestTone } from './status.ts'

/** Change request states by URL as the Host streams them. */
export type ChangeRequestStates = StreamSnapshot<ReadonlyMap<string, ForgeChangeRequestListState>>

/** Business face of the Session row entries: the change request states every row shares. */
export interface SessionListInjected {
  readonly hooks: {
    /** States by URL; the renderer binds it as `useStates`. */
    readonly states: HostObservable<ChangeRequestStates>
  }
}

/** One visible change request of a Session with its last polled state, when known. */
export interface SessionListChangeRequest {
  readonly url: string
  readonly state: ForgeChangeRequestListState | undefined
  readonly tone: ChangeRequestTone
}

/** What a Session row and its hover card show. */
export interface SessionForgeFacts {
  /** The worktree the panel created for the Session, while the Session works in it. */
  readonly worktree: ForgeSessionWorktree | null
  /** Visible change requests, most urgent first; equally urgent ones keep their binding order. */
  readonly changeRequests: readonly SessionListChangeRequest[]
}

const URGENCY: Record<ChangeRequestTone, number> = { blocked: 0, open: 1, draft: 2, unknown: 3, merged: 4, closed: 5 }

const NO_FACTS: SessionForgeFacts = { worktree: null, changeRequests: [] }

/**
 * Derive a Session's facts from its listed projection values.
 * @param values - the Session's projection values in the Session list, undefined before it is listed.
 * @param states - change request states by URL.
 * @returns the facts; a Session without a worktree or change requests shares one empty value.
 */
export function sessionForgeFacts(
  values: Readonly<Partial<SessionProjectionSummaryValues>> | undefined,
  states: ReadonlyMap<string, ForgeChangeRequestListState>,
): SessionForgeFacts {
  const worktree = values?.forgeWorktree ?? null
  const changeRequests = (values?.forgeChangeRequests ?? [])
    .filter(binding => !binding.dismissed)
    .map((binding): SessionListChangeRequest => {
      const state = states.get(binding.url)
      return { url: binding.url, state, tone: toneOf(state ?? null) }
    })
    .sort((left, right) => URGENCY[left.tone] - URGENCY[right.tone])
  return worktree === null && changeRequests.length === 0 ? NO_FACTS : { worktree, changeRequests }
}

/**
 * Read one Session's facts, recomputed only when its listed values or the shared states change.
 * @param useSessions - selector hook over the Session list.
 * @param useStates - selector hook over the change request states.
 * @param sessionId - the row's Session.
 * @returns the facts.
 */
export function useSessionForgeFacts(
  useSessions: UseSessions,
  useStates: SnapshotSelectorHook<ChangeRequestStates>,
  sessionId: SessionId,
): SessionForgeFacts {
  const values = useSessions(state => state.byId[sessionId]?.projectionValues)
  const states = useStates(snapshot => snapshot.state)
  return useMemo(() => sessionForgeFacts(values, states), [values, states])
}
