/** Definition-owned grouping over a target's already materialized Nodes. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ConversationTimelineSnapshot, ConversationViewNode } from './conversation.ts'

/** Existing Node identity, without allocating another execution Node. */
export type NodeKey = Branded<'ConversationNodeKey'>

/** Definition-local group identity within one Session and target. */
export type GroupKey = Branded<'ConversationGroupKey'>

/** One whole Node or a renderer-owned part of that Node. */
export interface NodeReference {
  readonly kind: 'node'
  readonly key: NodeKey
  readonly groupPart?: string
}

/** Root-list reference to a separately observed group. */
export interface GroupReference {
  readonly kind: 'group'
  readonly key: GroupKey
}

/** The two supported root rendering positions. */
export type RenderEntry = NodeReference | GroupReference

/** Immutable group data and its ordered, non-nested Node references. */
export interface GroupSnapshot<Data> {
  readonly key: GroupKey
  readonly data: Data
  readonly members: readonly NodeReference[]
}

/**
 * One atomic grouping update. Replacement input requires entries and a complete
 * group replacement; apply input may omit entries to preserve the root list.
 * Group removal never deletes source Nodes.
 */
export interface GroupUpdate<Data> {
  /** Complete root sequence; only its Node references and referenced group members render. */
  readonly entries?: readonly RenderEntry[]
  readonly groups:
    | { readonly kind: 'replace'; readonly snapshots: readonly GroupSnapshot<Data>[] }
    | {
      readonly kind: 'apply'
      readonly upserts: readonly GroupSnapshot<Data>[]
      readonly removes: readonly GroupKey[]
    }
}

/** Target-processed Node values before and after one update. */
export interface NodeChange<Node> {
  readonly previous: Node | undefined
  readonly current: Node
}

/** Owning Turn and immediate neighbours in the target's visible Node order. */
export interface GroupNodePosition {
  readonly turn: number | undefined
  readonly previous: NodeKey | undefined
  readonly next: NodeKey | undefined
}

interface GroupInputNodes<Node> {
  readonly order: readonly NodeKey[]
  /** @param key - target Node identity. @returns its current value during this synchronous update. */
  readonly readNode: (key: NodeKey) => Node | undefined
  /** @param turn - owning Turn. @returns its visible keys in target order; empty when absent. */
  readonly readTurn: (turn: number) => readonly NodeKey[]
  /** @param key - target Node identity. @returns its visible position, or absence outside the target order. */
  readonly readPosition: (key: NodeKey) => GroupNodePosition | undefined
  readonly timeline: ConversationTimelineSnapshot
}

/** Target-local inputs; apply includes lifecycle changes without Node upserts. */
export type ConversationGroupInput<Node> = GroupInputNodes<Node> & (
  | { readonly kind: 'replace' }
  | {
    readonly kind: 'apply'
    readonly changes: readonly NodeChange<Node>[]
    readonly changedTurns: readonly number[]
    /** Turns whose visible keys or immediate neighbours changed, including removal and cross-Turn moves. */
    readonly changedTurnOrders: readonly number[]
  }
)

/** Framework-owned State for one Session's registered Group Definition. */
export interface ConversationGroupContext<State> {
  readonly state: State
}

/** Business grouping rules, driven after the target Builder has installed Nodes. */
export interface ConversationGroupDefinition<
  Node extends ConversationViewNode = ConversationViewNode,
  State = unknown,
  Data = unknown,
> {
  readonly kind: string
  readonly target: string
  /** @returns initial Session-local grouping State. */
  create(): State
  /**
   * Consume target Node changes, not raw Session events or presentation modes.
   * @param context - current Session-local State.
   * @param input - current target inputs; its readers are valid only during this call.
   * @returns State adopted by the framework.
   */
  update(context: ConversationGroupContext<State>, input: ConversationGroupInput<Node>): State
  /**
   * Materialize pending grouping changes without changing the business State.
   * @param context - State adopted after update.
   * @returns complete output for replace input; an update or null when unchanged for apply input.
   */
  buildGroups(context: ConversationGroupContext<State>): GroupUpdate<Data> | null
}

/** Merge-extensible group data associated with each registered target. */
export interface ConversationGroupDataMap {}

/** Group data declared by a target; undeclared targets have no group payload. */
export type ConversationGroupData<Target extends string> =
  Target extends keyof ConversationGroupDataMap ? ConversationGroupDataMap[Target] : never

/** Stable grouped reader; data-only updates preserve entries and member arrays. */
export interface ConversationGroupedView<Data> {
  readonly entries: readonly RenderEntry[]
  /**
   * Observe a group without subscribing to the root sequence.
   * @param key - group identity within this target.
   * @returns an identity-stable source, whose value is absent after removal.
   */
  groupSource(key: GroupKey): ObservableSnapshot<GroupSnapshot<Data> | undefined>
}
