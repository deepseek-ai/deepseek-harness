/** Session-local object references used by the Chat Inspector's detail tree. */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'

/**
 * Inspector-owned coordinates read from DOM attributes or Chat's string-keyed snapshots.
 * Registry access resolves these strings against current branded references; a DOM value is not itself a validated registry ID.
 */
export interface InspectorChatTarget {
  readonly anchorSeq?: number
  readonly callId?: string
  readonly rootCallId?: string
  readonly nodeKey?: string
  readonly nodeKind?: string
  readonly groupKey?: string
  readonly groupPart?: string
  readonly turn?: number
  readonly step?: number
}

/** A named object whose current value can be inspected independently. */
export interface InspectorObjectReference {
  readonly id: string
  readonly kind: 'node' | 'nodeData' | 'group' | 'groupData' | 'turn' | 'turnData' | 'step' | 'stepData'
  readonly identity: string
  readonly target: InspectorChatTarget
  readonly rowKey?: string
  /** @returns Latest loaded value, or undefined after removal. */
  readonly read: () => unknown
}

/** Object-identity lookup for one inspected Session. */
export interface InspectorObjects {
  readonly sessionId: SessionId
  /** Conversation publications invalidate cached fields of identity-stable Data readers. */
  readonly updates: ObservableSnapshot<object>
  /** @param value - An original runtime object. @returns Its named reference, when indexed. */
  readonly reference: (value: object) => InspectorObjectReference | undefined
  /** @param key - Inspector table row. @returns Its reference and exact Chat group part. */
  readonly row: (key: string) => InspectorObjectReference | undefined
}
