/** View target builder turning published nodes into turn rows. */

import type { Context } from '@deepseek-ai/cordis'
import type {
  ConversationViewBuilder, ConversationViewDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { buildTurns } from './stats-aggregate.ts'
import type { StatsSnapshot, StatsViewNode } from './stats-contract.ts'
import { TARGET } from './stats-definition.ts'

const EMPTY_LIST: readonly never[] = []

/** Stable snapshot used before a Session assembled any performance node. */
export const EMPTY_STATS_SNAPSHOT: StatsSnapshot = { turns: EMPTY_LIST, stepCount: 0 }

/** Incremental builder over the target's materialized nodes. */
class StatsSnapshotBuilder implements ConversationViewBuilder<StatsViewNode, StatsSnapshot> {
  private readonly nodes = new Map<string, StatsViewNode>()
  private current: StatsSnapshot = EMPTY_STATS_SNAPSHOT
  readonly empty: StatsSnapshot = EMPTY_STATS_SNAPSHOT

  replace(input: { readonly nodes: readonly StatsViewNode[] }): StatsSnapshot {
    this.nodes.clear()
    for (const node of input.nodes) this.nodes.set(node.key, node)
    return this.snapshot()
  }

  apply(input: { readonly upserts: readonly StatsViewNode[] }): StatsSnapshot {
    if (input.upserts.length === 0) return this.current
    for (const node of input.upserts) this.nodes.set(node.key, node)
    return this.snapshot()
  }

  private snapshot(): StatsSnapshot {
    const turns = buildTurns(this.nodes.values())
    this.current = {
      turns,
      stepCount: turns.reduce((sum, turn) => sum + turn.steps.length, 0),
    }
    return this.current
  }
}

/** The `stats` target every Definition publishes into. */
export const statsViewDefinition: ConversationViewDefinition<StatsViewNode, StatsSnapshot> = {
  target: TARGET,
  create: () => new StatsSnapshotBuilder(),
}

/**
 * Register the target builder. The registration rides the caller's fiber
 * effect, so unloading the plugin drops the target with it.
 * @param ctx - client root context.
 */
export function registerStatsConversationView(ctx: Context): void {
  ctx.uiConversation.views.register(statsViewDefinition)
}
