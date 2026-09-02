/** Trajectory view: compact summary over a turn-aware event ledger. */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AssistantBlock, AssistantMessageNode, ConvViewProps, MessageImageLoader, RenderMessageImages,
  ToolCallBlock,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InjectFace, PropsLocale, PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  TrajectoryTable,
  type TrajectoryRequestNumber,
  type TrajectoryUsage,
} from './TrajectoryTable.tsx'
import { TrajectoryToolbar } from './TrajectoryToolbar.tsx'
import { TrajectoryTimeline } from './TrajectoryTimeline.tsx'
import {
  appendTrajectoryPartialLayout, deriveTrajectoryLayout,
  type TrajectoryTurnModel,
} from './layout.ts'
import {
  trajectoryTimelineFocusIndexes,
  type TrajectoryTimelineMode,
  type TrajectoryTimeRange,
} from './timeline.ts'
import { trajectoryRecordId } from './trajectory-record.ts'
import { TrajectorySearchIndex } from './trajectory-search-index.ts'
import type { TrajectorySnapshot } from './trajectory-contract.ts'
import css from './views.module.css'

const EMPTY_TURN_IDS: ReadonlySet<number> = new Set()
const EMPTY_RECORD_IDS: ReadonlySet<string> = new Set()
const SEARCH_INDEX_THROTTLE_MS = 3_000
const HISTORY_PAGE_NODES = 50

function containsCall(calls: readonly ToolCallBlock[], callId: string): boolean {
  for (const call of calls) {
    if (call.callId === callId || containsCall(call.subCalls, callId)) return true
  }
  return false
}

function lastCellIndex(turns: readonly TrajectoryTurnModel[]): number {
  let last = 0
  for (const turn of turns) {
    for (const group of turn.groups) {
      for (const cell of group.cells) last = Math.max(last, cell.index)
    }
  }
  return last
}

function timelineBlock(block: AssistantBlock): AssistantBlock {
  switch (block.kind) {
    case 'text': return { kind: 'text', text: '' }
    case 'reasoning': return { kind: 'reasoning', text: '' }
    case 'image': return block
    case 'tool-call': return {
      kind: 'tool-call',
      callId: block.callId,
      name: block.name,
      argsRaw: '',
    }
    case 'other': return { kind: 'other', block: null }
  }
}

function partialStructureSignature(partial: TrajectorySnapshot['partial']): string {
  if (partial === null) return ''
  return partial.blocks.map(block => block.kind === 'tool-call'
    ? `${block.kind}:${block.callId}:${block.name}`
    : block.kind).join('\u0000')
}

/** Session-bound controls not already supplied by the conversation view slot. */
export interface TrajectoryViewInjected {
  hooks: {
    duration: SnapshotStore<boolean>
  }
  loadOlder: () => Promise<boolean>
  loadImage: MessageImageLoader
  setActualDuration: (actualDuration: boolean) => void
}

interface UsageLike {
  inputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  outputTokens?: number
  reasoningTokens?: number
}

function requestUsage(value: unknown): TrajectoryUsage | undefined {
  const usage = value as UsageLike | undefined
  if (usage === undefined) return undefined
  return {
    ...(usage.inputTokens === undefined ? {} : { input: usage.inputTokens }),
    ...(usage.cacheReadTokens === undefined ? {} : { cacheRead: usage.cacheReadTokens }),
    ...(usage.cacheWriteTokens === undefined ? {} : { cacheWrite: usage.cacheWriteTokens }),
    ...(usage.outputTokens === undefined ? {} : { output: usage.outputTokens }),
    ...(usage.reasoningTokens === undefined ? {} : { reasoning: usage.reasoningTokens }),
  }
}

function addUsage(
  total: TrajectoryUsage | undefined,
  usage: TrajectoryUsage | undefined,
): TrajectoryUsage | undefined {
  if (usage === undefined) return total
  return {
    ...(total?.input === undefined && usage.input === undefined
      ? {}
      : { input: (total?.input ?? 0) + (usage.input ?? 0) }),
    ...(total?.cacheRead === undefined && usage.cacheRead === undefined
      ? {}
      : { cacheRead: (total?.cacheRead ?? 0) + (usage.cacheRead ?? 0) }),
    ...(total?.cacheWrite === undefined && usage.cacheWrite === undefined
      ? {}
      : { cacheWrite: (total?.cacheWrite ?? 0) + (usage.cacheWrite ?? 0) }),
    ...(total?.output === undefined && usage.output === undefined
      ? {}
      : { output: (total?.output ?? 0) + (usage.output ?? 0) }),
    ...(total?.reasoning === undefined && usage.reasoning === undefined
      ? {}
      : { reasoning: (total?.reasoning ?? 0) + (usage.reasoning ?? 0) }),
  }
}

export function TrajectoryView({
  useSession, useTrajectory, useDuration, loadOlder, loadImage, setActualDuration,
  viewRequest, completeViewRequest, renderSlot, t,
}: ConvViewProps
  & PropsRenderSlots<'conversation.trajectory.images'>
  & InjectFace<TrajectoryViewInjected>
  & PropsLocale<'trajectory'>) {
  const [collapsedTurns, setCollapsedTurns] = useState<ReadonlySet<number>>(EMPTY_TURN_IDS)
  const renderImages = useCallback<RenderMessageImages>(
    owner => renderSlot('conversation.trajectory.images', { ...owner, loadImage }),
    [loadImage, renderSlot],
  )
  const [collapsedAssistants, setCollapsedAssistants] =
    useState<ReadonlySet<string>>(EMPTY_RECORD_IDS)
  const [timelineSelection, setTimelineSelection] = useState<TrajectoryTimeRange | null>(null)
  const actualDuration = useDuration(value => value)
  const [actualTime, setActualTime] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchIndex] = useState(() => new TrajectorySearchIndex())
  const [searchIndexRevision, setSearchIndexRevision] = useState(0)
  const searchIndexTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchIndexInitialized = useRef(false)
  const [selectedTimelineIndex, setSelectedTimelineIndex] = useState<number | null>(null)
  const [timelineRecordSelection, setTimelineRecordSelection] = useState<{
    readonly index: number
  } | null>(null)
  const [timelineRecordFocus, setTimelineRecordFocus] = useState<{
    readonly index: number
  } | null>(null)
  const completeInspection = useTrajectory(snapshot => snapshot)
  const latestNodeSeq = completeInspection.eventNodes.at(-1)?.seq
  const [historyTailSeq, setHistoryTailSeq] = useState(latestNodeSeq)
  const [historyNodeLimit, setHistoryNodeLimit] = useState(HISTORY_PAGE_NODES)
  const fixedTailSeq = historyTailSeq ?? latestNodeSeq
  const historyTailIndex = fixedTailSeq === undefined
    ? -1
    : completeInspection.eventNodes.findLastIndex(node => node.seq <= fixedTailSeq)
  const historyEndIndex = historyTailIndex < 0 && latestNodeSeq !== undefined
    ? completeInspection.eventNodes.length
    : historyTailIndex + 1
  const historyStartIndex = Math.max(0, historyEndIndex - historyNodeLimit)
  useEffect(() => {
    if (latestNodeSeq !== undefined && (historyTailSeq === undefined || historyTailIndex < 0)) {
      setHistoryTailSeq(latestNodeSeq)
    }
  }, [historyTailIndex, historyTailSeq, latestNodeSeq])
  const inspection = useMemo<TrajectorySnapshot>(() => {
    if (historyStartIndex === 0) return completeInspection
    const eventNodes = completeInspection.eventNodes.slice(historyStartIndex)
    const firstSeq = eventNodes[0]?.seq ?? 0
    return {
      ...completeInspection,
      eventNodes,
      requests: completeInspection.requests.filter(request =>
        request.startSeq >= firstSeq || (request.resultSeq ?? -1) >= firstSeq),
    }
  }, [completeInspection, historyStartIndex])
  const historyLoading = useSession(snapshot => snapshot.openState === 'loading')
  const olderHistoryLoading = useSession(snapshot => snapshot.loadingOlder)
  const sessionHasOlderHistory = useSession(snapshot => snapshot.hasMore)
  const hasResidentOlderHistory = historyStartIndex > 0
  const hasOlderHistory = hasResidentOlderHistory
    || sessionHasOlderHistory
  const nodes = inspection.eventNodes
  const eventLocations = inspection.eventLocations
  const historyBaseSeq = nodes[0]?.seq ?? 0
  const partial = inspection.partial
  const runningCalls = inspection.runningCalls
  const requests = inspection.requests
  const callSchemas = inspection.callSchemas
  const inspectCallId = viewRequest?.view === 'trajectory' ? viewRequest.focus : null
  const inspectNodeIndex = useMemo(() => inspectCallId === null
    ? -1
    : completeInspection.eventNodes.findIndex(node => node.kind === 'assistant'
      ? node.blocks.some(block => block.kind === 'tool-call' && block.callId === inspectCallId)
      : node.kind === 'tool-result' && containsCall([node], inspectCallId)),
  [completeInspection.eventNodes, inspectCallId])
  useEffect(() => {
    if (inspectNodeIndex < 0 || inspectNodeIndex >= historyStartIndex) return
    setHistoryNodeLimit(limit => limit + historyStartIndex - inspectNodeIndex)
  }, [historyStartIndex, inspectNodeIndex])
  const requestNumbers = useMemo<readonly TrajectoryRequestNumber[]>(() => {
    const assistantsByStep = new Map<string, AssistantMessageNode>()
    for (const node of completeInspection.eventNodes) {
      if (node.kind !== 'assistant' || node.step <= 0) continue
      assistantsByStep.set(`${node.turn}\u0000${node.step}`, node)
    }
    const requestsByStep = new Map(
      completeInspection.requests
        .filter(request => request.purpose === 'assistant')
        .map(request => [
          `${request.turn}\u0000${request.step}`,
          request,
        ]),
    )
    const orderedRequests = [
      ...completeInspection.requests.map(request => ({
        seq: request.startSeq,
        request,
        node: request.purpose === 'assistant'
          ? assistantsByStep.get(`${request.turn}\u0000${request.step}`)
          : undefined,
      })),
      ...[...assistantsByStep.entries()].flatMap(([key, node]) =>
        requestsByStep.has(key)
          ? []
          : [{
            seq: node.seq,
            request: undefined,
            node,
          }],
      ),
    ].sort((left, right) => left.seq - right.seq)
    const numbered: TrajectoryRequestNumber[] = []
    let cumulativeUsage: TrajectoryUsage | undefined
    for (const [index, entry] of orderedRequests.entries()) {
      const usage = requestUsage(entry.request?.usage ?? entry.node?.usage)
      cumulativeUsage = addUsage(cumulativeUsage, usage)
      if (entry.request?.purpose !== 'compaction') {
        const request = entry.request
        const node = entry.node
        const turn = request?.turn ?? node?.turn
        const step = request?.step ?? node?.step
        if (turn === undefined || step === undefined) continue
        const provider = request?.provenance?.provider ?? node?.provenance?.provider
        const model = request?.provenance?.model ?? node?.provenance?.model
        const requestConfig = request?.requestConfig ?? node?.requestConfig
        numbered.push({
          seq: entry.seq,
          turn,
          step,
          group: t('group.step', { step }),
          number: index + 1,
          ...(request?.status === undefined ? {} : { status: request.status }),
          ...(request?.startedAt === undefined ? {} : { startedAt: request.startedAt }),
          ...(request?.completedAt === undefined ? {} : { completedAt: request.completedAt }),
          ...(request?.error === undefined ? {} : { error: request.error }),
          ...(request?.errorCode === undefined ? {} : { errorCode: request.errorCode }),
          ...(request?.resultSeq === undefined ? {} : { resultSeq: request.resultSeq }),
          ...(request?.retry === undefined ? {} : { retry: request.retry }),
          ...(request?.maxRetries === undefined ? {} : { maxRetries: request.maxRetries }),
          ...(request?.retryDelayMs === undefined
            ? {}
            : { retryDelayMs: request.retryDelayMs }),
          ...(provider === undefined ? {} : { provider }),
          ...(model === undefined ? {} : { model }),
          ...(requestConfig === undefined ? {} : { requestConfig }),
          ...(usage === undefined ? {} : { usage }),
          ...(cumulativeUsage === undefined ? {} : { cumulativeUsage }),
        })
        continue
      }
      const request = entry.request
      numbered.push({
        seq: request.startSeq,
        turn: request.turn,
        step: 0,
        group: t('group.compaction', { seq: request.startSeq }),
        number: index + 1,
        purpose: 'compaction',
        status: request.status,
        startedAt: request.startedAt,
        completedAt: request.completedAt,
        ...(request.error === undefined ? {} : { error: request.error }),
        ...(request.errorCode === undefined ? {} : { errorCode: request.errorCode }),
        resultSeq: request.startSeq,
        ...(request.provenance?.provider === undefined
          ? {}
          : { provider: request.provenance.provider }),
        ...(request.provenance?.model === undefined
          ? {}
          : { model: request.provenance.model }),
        ...(request.requestConfig === undefined ? {} : { requestConfig: request.requestConfig }),
        ...(usage === undefined ? {} : { usage }),
        ...(cumulativeUsage === undefined ? {} : { cumulativeUsage }),
      })
    }

    return numbered
  }, [
    completeInspection.eventNodes, completeInspection.requests, t,
  ])
  const partialTurn = partial?.turn ?? null
  const partialStep = partial?.step ?? null
  const finalized = useMemo(() => {
    const turns = deriveTrajectoryLayout({
      nodes,
      eventLocations,
      partial: partialTurn === null || partialStep === null
        ? null
        : { turn: partialTurn, step: partialStep, blocks: [] },
      runningCalls,
      requests,
      callSchemas,
    }, t)
    return { turns, lastIndex: lastCellIndex(turns) }
  }, [
    nodes, eventLocations, partialTurn, partialStep,
    runningCalls, requests, callSchemas, t,
  ])
  const timelinePartialSignature = partialStructureSignature(partial)
  const timelinePartial = useMemo<TrajectorySnapshot['partial']>(() => partial === null
    ? null
    : {
      turn: partial.turn,
      step: partial.step,
      blocks: partial.blocks.map(block => timelineBlock(block)),
    },
  [partialStep, partialTurn, timelinePartialSignature])
  const timelineTurns = useMemo(
    () => appendTrajectoryPartialLayout(finalized.turns, timelinePartial, finalized.lastIndex, t),
    [finalized, timelinePartial, t],
  )
  const timelineMode: TrajectoryTimelineMode = actualDuration
    ? actualTime ? 'actual' : 'duration'
    : actualTime ? 'time' : 'sequence'
  const partialSearchTurns = useMemo(
    () => appendTrajectoryPartialLayout([], partial, finalized.lastIndex, t),
    [finalized.lastIndex, partial, t],
  )
  const searchLayouts = useMemo(
    () => [finalized.turns, partialSearchTurns] as const,
    [finalized, partialSearchTurns],
  )
  const latestSearchLayouts = useRef(searchLayouts)
  latestSearchLayouts.current = searchLayouts
  useEffect(() => {
    if (!searchIndexInitialized.current) {
      searchIndexInitialized.current = true
      if (searchIndex.update(searchLayouts)) {
        setSearchIndexRevision(revision => revision + 1)
      }
      return
    }
    if (searchIndexTimer.current !== null) return
    searchIndexTimer.current = setTimeout(() => {
      searchIndexTimer.current = null
      if (searchIndex.update(latestSearchLayouts.current)) {
        setSearchIndexRevision(revision => revision + 1)
      }
    }, SEARCH_INDEX_THROTTLE_MS)
  }, [searchIndex, searchLayouts])
  useEffect(() => () => {
    if (searchIndexTimer.current !== null) clearTimeout(searchIndexTimer.current)
  }, [])
  const streamingCells = useMemo(
    () => partialSearchTurns.flatMap(turn =>
      turn.groups.flatMap(group => group.cells),
    ),
    [partialSearchTurns],
  )
  const searchMatchRecordIds = useMemo(
    () => searchIndex.search(searchQuery),
    [searchIndex, searchIndexRevision, searchQuery],
  )
  const searchMatchIndexes = useMemo(() => {
    if (searchMatchRecordIds === null) return null
    const indexes = new Set<number>()
    for (const turns of searchLayouts) {
      for (const turn of turns) {
        for (const group of turn.groups) {
          for (const cell of group.cells) {
            if (searchMatchRecordIds.has(trajectoryRecordId(cell))) indexes.add(cell.index)
          }
        }
      }
    }
    return indexes
  }, [searchLayouts, searchMatchRecordIds])
  const timelineRange = timelineSelection
  const timelineFocusIndexes = useMemo(
    () => timelineRange === null
      ? null
      : trajectoryTimelineFocusIndexes(timelineTurns, timelineRange, timelineMode),
    [timelineMode, timelineRange, timelineTurns],
  )
  const handleRecordSelect = useCallback((index: number) => {
    if (
      timelineFocusIndexes !== null
      && !timelineFocusIndexes.has(index)
    ) {
      setTimelineSelection(null)
    }
  }, [timelineFocusIndexes])
  const handleTimelineRangeChange = useCallback((range: TrajectoryTimeRange | null) => {
    setTimelineSelection(range)
  }, [])
  const handleTimelineRecordSelect = useCallback((index: number) => {
    setTimelineSelection(null)
    setTimelineRecordSelection({ index })
    setSelectedTimelineIndex(index)
  }, [])
  const handleTimelineRecordFocus = useCallback((index: number) => {
    setTimelineRecordFocus({ index })
  }, [])
  const collapsibleTurnIds = useMemo(
    () => timelineTurns
      .filter(turn =>
        turn.turn !== null
        &&
        turn.groups.reduce(
          (count, group) =>
            count + group.cells.filter(cell =>
              cell.requestOnly !== true && cell.kind !== 'system').length,
          0,
        ) > 1)
      .flatMap(turn => turn.turn === null ? [] : [turn.turn]),
    [timelineTurns],
  )
  const allTurnsCollapsed = collapsibleTurnIds.length > 0
    && collapsibleTurnIds.every(turn => collapsedTurns.has(turn))
  const collapsibleAssistantIds = useMemo(() => {
    const ids: string[] = []
    for (const turn of timelineTurns) {
      const cells = turn.groups.flatMap(group => group.cells)
      for (let i = 0; i < cells.length; i++) {
        const cell = cells[i]
        if (cell?.kind !== 'message') continue
        const next = cells[i + 1]
        if (next?.kind === 'tool' || next?.kind === 'subtool') {
          ids.push(trajectoryRecordId(cell))
        }
      }
    }
    return ids
  }, [timelineTurns])
  const allAssistantsCollapsed = collapsibleAssistantIds.length > 0
    && collapsibleAssistantIds.every(index => collapsedAssistants.has(index))

  const toggleTurn = (turn: number) => {
    setCollapsedTurns((current) => {
      const collapsed = new Set(current)
      if (collapsed.has(turn)) collapsed.delete(turn)
      else collapsed.add(turn)
      return collapsed
    })
  }

  const toggleAllTurns = () => {
    setCollapsedTurns((current) => {
      const collapsed = new Set(current)
      if (allTurnsCollapsed) {
        for (const turn of collapsibleTurnIds) collapsed.delete(turn)
      } else {
        for (const turn of collapsibleTurnIds) collapsed.add(turn)
      }
      return collapsed
    })
  }

  const toggleAssistant = (id: string) => {
    setCollapsedAssistants((current) => {
      const collapsed = new Set(current)
      if (collapsed.has(id)) collapsed.delete(id)
      else collapsed.add(id)
      return collapsed
    })
  }

  const toggleAllAssistants = () => {
    setCollapsedAssistants((current) => {
      const collapsed = new Set(current)
      if (allAssistantsCollapsed) {
        for (const index of collapsibleAssistantIds) collapsed.delete(index)
      } else {
        for (const index of collapsibleAssistantIds) collapsed.add(index)
      }
      return collapsed
    })
  }

  const loadEarlierHistory = useCallback(async () => {
    if (!hasResidentOlderHistory && !await loadOlder()) return false
    setHistoryNodeLimit(limit => limit + HISTORY_PAGE_NODES)
    return true
  }, [hasResidentOlderHistory, loadOlder])

  return (
    <div className={css.root} data-conversation-composer-overlay="">
      <TrajectoryToolbar
        actualDuration={actualDuration}
        onActualDurationChange={(nextActualDuration) => {
          setActualDuration(nextActualDuration)
          setTimelineSelection(null)
        }}
        actualTime={actualTime}
        onActualTimeChange={(nextActualTime) => {
          setActualTime(nextActualTime)
          setTimelineSelection(null)
        }}
        allTurnsCollapsed={allTurnsCollapsed}
        onToggleAllTurns={toggleAllTurns}
        allAssistantsCollapsed={allAssistantsCollapsed}
        onToggleAllAssistants={toggleAllAssistants}
        searchQuery={searchQuery}
        onSearchQueryChange={setSearchQuery}
        t={t}
      />
      <TrajectoryTimeline
        t={t}
        turns={timelineTurns}
        mode={timelineMode}
        range={timelineRange}
        hasEarlierRecords={hasOlderHistory}
        onLoadEarlier={loadEarlierHistory}
        selectedIndex={selectedTimelineIndex}
        searchMatchIndexes={searchMatchIndexes}
        onRangeChange={handleTimelineRangeChange}
        onRecordSelect={handleTimelineRecordSelect}
        onRecordFocus={handleTimelineRecordFocus}
      />
      <div className={css.ledger}>
        <TrajectoryTable
          t={t}
          renderImages={renderImages}
          requestNumbers={requestNumbers}
          turns={timelineTurns}
          streamingCells={streamingCells}
          timelineFocusIndexes={timelineFocusIndexes}
          searchMatchIndexes={searchMatchIndexes}
          onSelectedIndexChange={setSelectedTimelineIndex}
          onRecordSelect={handleRecordSelect}
          recordSelection={timelineRecordSelection}
          recordFocus={timelineRecordFocus}
          historyLoading={historyLoading}
          olderHistoryLoading={olderHistoryLoading}
          historyStartSeq={historyBaseSeq}
          hasOlderRecords={hasOlderHistory}
          onLoadOlder={loadEarlierHistory}
          onClearSelection={() => { setTimelineSelection(null) }}
          collapsedTurns={collapsedTurns}
          onToggleTurn={toggleTurn}
          collapsedAssistants={collapsedAssistants}
          onToggleAssistant={toggleAssistant}
          inspectCallId={inspectCallId}
          onInspectApplied={completeViewRequest}
        />
      </div>
    </div>
  )
}
