/** Test adapter for the production conversation.details.tool registration. */
import type { SessionLiveEventEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import { SessionSeq } from '@deepseek-ai/dsh-session/types'
import { isJsonValue, type JsonValue } from '@deepseek-ai/dsh-util-values'
import type {
  ChatConversationViewNode, ChatSnapshot, ConversationNode, DetailsSlotProps,
  DetailsToolOwnerProps, RunningToolCall, ToolResultNode,
} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { ToolDetails } from '../src/client/tool/ToolDetails.tsx'

type TrajectorySnapshot = Parameters<Parameters<DetailsSlotProps['useTrajectory']>[0]>[0]

const emptyTrajectory: TrajectorySnapshot = {
  eventNodes: [],
  eventLocations: new Map(),
  requests: [],
  callSchemas: new Map(),
  partial: null,
  runningCalls: [],
}

/** Stable empty Trajectory source for DetailsPanel fixtures. */
export const useEmptyTrajectory: DetailsSlotProps['useTrajectory'] = selector => selector(emptyTrajectory)

function jsonFixture(value: unknown): JsonValue {
  if (!isJsonValue(value)) throw new Error('tool event fixture must be lossless JSON')
  return value as JsonValue
}

/** Build the canonical Chat slice consumed by Tool rows and details tests. */
export function toolChatSnapshot(
  settled: readonly ConversationNode[] = [],
  running: readonly RunningToolCall[] = [],
): ChatSnapshot {
  const roots = [...settled.filter(node => node.kind === 'tool-result'), ...running]
  const nodes: ChatConversationViewNode[] = roots.map(root => ({
    key: `tool:${root.callId}`,
    kind: 'tool-call',
    id: root.callId,
    target: 'chat',
    anchorSeq: 'kind' in root ? root.seq : Number.MAX_SAFE_INTEGER,
    location: { kind: 'session' },
    visibility: 'visible',
    data: { root },
  }))
  const byKey = new Map(nodes.map(node => [node.key, node]))
  const empty: readonly string[] = []
  return {
    order: nodes.map(node => node.key),
    nodes: {
      get: key => byKey.get(key),
      source: key => ({ getSnapshot: () => byKey.get(key), subscribe: () => () => {} }),
      processSource: () => ({ getSnapshot: () => undefined, subscribe: () => () => {} }),
      values: () => nodes,
    },
    locations: {
      getTurn: () => empty,
      getStep: () => empty,
    },
    navigation: { items: () => [] },
    timeline: { turnOrder: [], turns: new Map() },
    legacy: {
      nodes: settled,
      runningCalls: running,
      partial: null,
      turnTimings: new Map(),
      turnEnds: new Map(),
    },
  }
}

/** Build the Session event window that projects settled root Tool calls into Chat. */
export function toolSessionEvents(nodes: readonly ToolResultNode[]): readonly SessionLiveEventEntry[] {
  const firstTime = nodes[0]?.callTime ?? nodes[0]?.time ?? 0
  const entries: SessionLiveEventEntry[] = [
    {
      type: 'event',
      event: {
        seq: SessionSeq(1),
        time: firstTime - 2,
        type: 'turn/start',
        data: { turn: 1 },
      },
    },
    {
      type: 'event',
      event: {
        seq: SessionSeq(2),
        time: firstTime - 1,
        type: 'step/start',
        data: { turn: 1, step: 1 },
      },
    },
  ]
  for (const [index, node] of nodes.entries()) {
    if (node.call === null) throw new Error(`tool fixture "${node.callId}" requires its call event`)
    const callSeq = 3 + index * 2
    const callEntry: SessionLiveEventEntry = {
      type: 'event',
      event: {
        seq: SessionSeq(callSeq),
        time: node.callTime ?? node.time - 1,
        type: 'tool/call',
        data: {
          turn: 1,
          step: 1,
          callId: node.callId,
          name: node.call.name,
          arguments: node.call.argsRaw,
        },
      } as unknown as SessionLiveEventEntry['event'],
    }
    entries.push(callEntry)
    const resultEntry: SessionLiveEventEntry = {
      type: 'event',
      event: {
        seq: SessionSeq(callSeq + 1),
        time: node.time,
        type: 'tool/result',
        data: jsonFixture({
          turn: 1,
          step: 1,
          message: {
            id: `result-${node.callId}`,
            role: 'user',
            source: { kind: 'tool', callId: node.callId },
            content: [{
              type: 'tool-result',
              toolCallId: node.callId,
              content: node.content.map(block => ({ ...block })),
              isError: node.isError,
            }],
          },
          ...(node.error === undefined ? {} : { error: node.error }),
          ...(node.meta === undefined ? {} : { meta: node.meta }),
        }),
        surfaceOp: 'append',
      } as unknown as SessionLiveEventEntry['event'],
    }
    entries.push(resultEntry)
  }
  return entries
}

/**
 * Bind ui-tool's details renderer to the conversation slot callback shape.
 * @param t - conversation locale seat used by Tool cards.
 * @param home - optional Host account home for POSIX `~` summaries.
 * @returns a direct-test renderSlot implementation.
 */
export function renderToolDetails(
  t: TranslateNS<'conversation'>,
  home?: string,
): DetailsSlotProps['renderSlot'] {
  return (_key, owner) => {
    // PropsRenderSlots keeps its key generic even for this one-key share;
    // recover the concrete owner selected by the adapter's fixed slot.
    const details = owner as unknown as DetailsToolOwnerProps
    return <ToolDetails
      block={details.block}
      cwd={details.cwd}
      useHostInfo={selector => selector({ home, isLoopback: true })}
      t={t}
    />
  }
}
