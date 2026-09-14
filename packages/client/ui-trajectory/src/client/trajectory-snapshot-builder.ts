import type { Context } from '@deepseek-ai/cordis'
import type {
  AssistantMessageNode, ConversationNode, ConversationPromptSnapshot, ConversationViewBuilder,
  ConversationViewDefinition, RequestPromptChange, RequestView, ToolCallBlock,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { COMPACTION_INTERRUPTED_ERROR } from './copy-codes.ts'
import type {
  TrajectoryConversationViewNode, TrajectoryRequestHeaderState,
  TrajectorySnapshot,
} from './trajectory-contract.ts'

const EMPTY_LIST: readonly never[] = []
type AssistantRequest = Extract<RequestView, { purpose: 'assistant' }>
type ToolSchema = ConversationPromptSnapshot['tools'][number]

/** Stable empty target used until a Session has assembled Trajectory records. */
export const EMPTY_TRAJECTORY_SNAPSHOT: TrajectorySnapshot = {
  eventNodes: EMPTY_LIST,
  eventLocations: new Map(),
  requests: EMPTY_LIST,
  callSchemas: new Map(),
  partial: null,
  runningCalls: EMPTY_LIST,
}

function stepKey(turn: number, step: number): string {
  return `${turn}\u0000${step}`
}

function headerStepKey(header: TrajectoryRequestHeaderState): string | undefined {
  const location = header.location
  return location.kind === 'step'
    ? stepKey(location.turn.turn, location.step.step)
    : undefined
}

interface StepHeaders {
  /** Latest full request snapshot in the step. */
  latest: TrajectoryRequestHeaderState
  /** Latest actual prompt change in the step, retained across a later series snapshot. */
  change?: RequestPromptChange
}

function headerFor(
  request: AssistantRequest,
  headersByStep: ReadonlyMap<string, StepHeaders>,
  previous: TrajectoryRequestHeaderState | undefined,
): StepHeaders | undefined {
  return headersByStep.get(stepKey(request.turn, request.step))
    ?? (previous !== undefined && previous.seq < request.startSeq
      ? {
        latest: previous,
        ...(previous.change === undefined ? {} : { change: previous.change }),
      }
      : undefined)
}

function applyHeader(
  request: AssistantRequest,
  header: StepHeaders | undefined,
  includeChange: boolean,
): AssistantRequest {
  return header === undefined
    ? request
    : {
      ...request,
      prompt: header.latest.prompt,
      requestConfig: header.latest.prompt.config,
      ...(includeChange && header.change !== undefined ? { promptChange: header.change } : {}),
    }
}

function withRequestConfig(
  node: AssistantMessageNode,
  prompt: ConversationPromptSnapshot | undefined,
): AssistantMessageNode {
  return prompt === undefined ? node : { ...node, requestConfig: prompt.config }
}

function captureSchemas(
  block: ToolCallBlock,
  toolsByName: ReadonlyMap<string, ToolSchema>,
  output: Map<string, ToolSchema>,
): void {
  const name = 'kind' in block ? block.call?.name : block.name
  const schema = name === undefined ? undefined : toolsByName.get(name)
  if (schema !== undefined) output.set(block.callId, schema)
  for (const child of block.subCalls) captureSchemas(child, toolsByName, output)
}

function indexTools(tools: readonly ToolSchema[]): ReadonlyMap<string, ToolSchema> {
  return new Map(tools.map(tool => [tool.name, tool]))
}

function interruptCompactions(
  requests: RequestView[],
  boundaries: readonly { seq: number; time: number }[],
): void {
  let nextRequest = 0
  const runningCompactions: number[] = []
  for (const boundary of boundaries) {
    while (nextRequest < requests.length) {
      const request = requests[nextRequest]
      if (request === undefined || request.startSeq >= boundary.seq) break
      if (request.purpose === 'compaction' && request.status === 'running') {
        runningCompactions.push(nextRequest)
      }
      nextRequest++
    }
    let index = runningCompactions.pop()
    while (index !== undefined && requests[index]?.status !== 'running') {
      index = runningCompactions.pop()
    }
    if (index === undefined) continue
    const request = requests[index]
    if (request?.purpose !== 'compaction') continue
    requests[index] = {
      ...request,
      completedAt: boundary.time,
      status: 'error',
      error: COMPACTION_INTERRUPTED_ERROR,
    }
  }
}

function applyTurnErrors(
  requests: RequestView[],
  endings: readonly { turn: number; time: number; error?: string; errorCode?: string }[],
): void {
  const lastAssistantByTurn = new Map<number, number>()
  for (const [index, request] of requests.entries()) {
    if (request.purpose === 'assistant') lastAssistantByTurn.set(request.turn, index)
  }
  for (const ending of endings) {
    if (ending.error === undefined) continue
    const index = lastAssistantByTurn.get(ending.turn)
    if (index === undefined) continue
    const request = requests[index]
    if (request?.purpose !== 'assistant') continue
    requests[index] = {
      ...request,
      completedAt: request.completedAt ?? ending.time,
      status: 'error',
      error: ending.error,
      ...(ending.errorCode === undefined ? {} : { errorCode: ending.errorCode }),
    }
  }
}

/** Simple keyed adapter retaining the old Trajectory snapshot and stage layout. */
export class TrajectorySnapshotBuilder implements ConversationViewBuilder<
  TrajectoryConversationViewNode,
  TrajectorySnapshot
> {
  private readonly nodes = new Map<string, TrajectoryConversationViewNode>()
  private readonly positions = new Map<string, number>()
  private contributions: TrajectoryConversationViewNode[] = []
  readonly empty = EMPTY_TRAJECTORY_SNAPSHOT

  replace(input: {
    readonly nodes: readonly TrajectoryConversationViewNode[]
  }): TrajectorySnapshot {
    this.nodes.clear()
    for (const node of input.nodes) this.nodes.set(node.key, node)
    this.rebuildContributions()
    return this.snapshot()
  }

  apply(input: {
    readonly upserts: readonly TrajectoryConversationViewNode[]
  }): TrajectorySnapshot {
    let structural = false
    for (const node of input.upserts) {
      const previous = this.nodes.get(node.key)
      this.nodes.set(node.key, node)
      if (previous === undefined || previous.anchorSeq !== node.anchorSeq) {
        structural = true
        continue
      }
      const position = this.positions.get(node.key)
      if (position === undefined) structural = true
      else this.contributions[position] = node
    }
    if (structural) this.rebuildContributions()
    return this.snapshot()
  }

  private snapshot(): TrajectorySnapshot {
    const headersByStep = new Map<string, StepHeaders>()
    for (const contribution of this.contributions) {
      if (contribution.data.kind !== 'request-header') continue
      const key = headerStepKey(contribution.data.header)
      if (key === undefined) continue
      const previous = headersByStep.get(key)
      headersByStep.set(key, {
        latest: contribution.data.header,
        ...(contribution.data.header.change !== undefined
          ? { change: contribution.data.header.change }
          : previous?.change === undefined ? {} : { change: previous.change }),
      })
    }
    const representedPrompts = new Set(this.contributions.flatMap(node =>
      node.data.kind === 'request-header' && node.data.header.change !== undefined ? [node.data.header.change.seq] : []))
    const systemPrompts: NonNullable<TrajectorySnapshot['systemPrompts']>[number][] = []
    const finalized: ConversationNode[] = []
    const eventLocations = new Map<number, TrajectoryConversationViewNode['location']>()
    const requests: RequestView[] = []
    const boundaries: { seq: number; time: number }[] = []
    const turnEndings: {
      turn: number
      time: number
      error?: string
      errorCode?: string
    }[] = []
    const callSchemas = new Map<string, ToolSchema>()
    const consumedPromptChanges = new Set<number>()
    let previousHeader: TrajectoryRequestHeaderState | undefined
    let previousTools: ReadonlyMap<string, ToolSchema> = new Map()
    let partial: TrajectorySnapshot['partial'] = null
    const runningCalls: TrajectorySnapshot['runningCalls'][number][] = []

    for (const contribution of this.contributions) {
      const data = contribution.data
      if (data.kind === 'system-prompt') {
        if (!representedPrompts.has(data.prompt.seq)) systemPrompts.push(data.prompt)
        continue
      }
      if (data.kind === 'request-header') {
        previousHeader = data.header
        previousTools = indexTools(data.header.prompt.tools)
        continue
      }
      if (data.kind === 'node') {
        finalized.push(data.node)
        eventLocations.set(data.node.seq, contribution.location)
        continue
      }
      if (data.kind === 'assistant') {
        const header = data.request === undefined
          ? undefined
          : headerFor(data.request, headersByStep, previousHeader)
        if (data.node !== undefined) finalized.push(withRequestConfig(data.node, header?.latest.prompt))
        if (data.partial !== null) partial = data.partial
        if (data.request !== undefined) {
          const change = header?.change
          const includeChange = change !== undefined
            && !consumedPromptChanges.has(change.seq)
          requests.push(applyHeader(data.request, header, includeChange))
          if (includeChange) consumedPromptChanges.add(change.seq)
        }
        continue
      }
      if (data.kind === 'tool') {
        if ('kind' in data.root) finalized.push(data.root)
        else runningCalls.push(data.root)
        if (previousHeader !== undefined && previousHeader.seq < contribution.anchorSeq) {
          captureSchemas(data.root, previousTools, callSchemas)
        }
        continue
      }
      if (data.kind === 'compaction') {
        requests.push(data.request)
        continue
      }
      if (data.kind === 'session-end') {
        boundaries.push({ seq: data.seq, time: data.time })
        continue
      }
      turnEndings.push({
        turn: data.turn,
        time: data.time,
        ...(data.error === undefined ? {} : { error: data.error }),
        ...(data.errorCode === undefined ? {} : { errorCode: data.errorCode }),
      })
    }

    requests.sort((left, right) => left.startSeq - right.startSeq)
    interruptCompactions(requests, boundaries)
    applyTurnErrors(requests, turnEndings)
    finalized.sort((left, right) => left.seq - right.seq)
    const eventNodes = finalized
    return {
      eventNodes,
      ...systemPrompts.length > 0 ? { systemPrompts } : {},
      eventLocations,
      requests,
      callSchemas,
      partial,
      runningCalls,
    }
  }

  private rebuildContributions(): void {
    this.contributions = [...this.nodes.values()]
      .sort((left, right) => left.anchorSeq - right.anchorSeq || left.key.localeCompare(right.key))
    this.positions.clear()
    for (const [index, contribution] of this.contributions.entries()) {
      this.positions.set(contribution.key, index)
    }
  }
}

/** Trajectory target factory preserving the existing stage-oriented view model. */
export const trajectoryViewDefinition: ConversationViewDefinition<
  TrajectoryConversationViewNode,
  TrajectorySnapshot
> = {
  target: 'trajectory',
  create: () => new TrajectorySnapshotBuilder(),
}

/**
 * Register the stage-oriented Trajectory target builder.
 *
 * @param ctx - Plugin context receiving the view Definition.
 */
export function registerTrajectoryConversationView(ctx: Context): void {
  ctx.uiConversation.views.register(trajectoryViewDefinition)
}
