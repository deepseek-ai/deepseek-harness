/** Turn-aware trajectory event ledger with a local record inspector. */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  IconChevronRightOutline14,
  IconSettingsOutline16,
  IconSparkle16,
  IconUserOutline16,
  JsonTree,
  MarkdownText,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { JsonTreeLabels, MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import { structuredPatch } from 'diff'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {
  AssistantRequestConfig, ConversationPromptSnapshot, RenderMessageImages,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {
  AssistantMetricDetail, TrajectoryCellKind, TrajectoryCellProps, TrajectorySourceBlock,
} from './trajectory-record.ts'
import { formatElapsedSeconds, trajectoryRecordId } from './trajectory-record.ts'
import {
  groupTrajectoryVirtualRows, trajectoryVirtualRecordKey,
} from './trajectory-virtual-rows.ts'
import type { TrajectoryVirtualRow } from './trajectory-virtual-rows.ts'
import type { TrajectoryTurnModel } from './layout.ts'
import { trajectoryPreviewText } from './trajectory-preview.ts'
import type { TrajectoryKey, TrajectoryTranslate } from './locales.ts'
import { COMPACTION_INTERRUPTED_ERROR } from './copy-codes.ts'
import css from './TrajectoryTable.module.css'

const BOTTOM_FOLLOW_THRESHOLD_PX = 2
const OLDER_LOAD_THRESHOLD_PX = 48
const HISTORY_LOAD_ROW_HEIGHT_PX = 30
const VIRTUALIZATION_THRESHOLD = 100
const VIRTUAL_OVERSCAN_ROWS = 12
const VIRTUAL_INITIAL_VIEWPORT_HEIGHT_PX = 600

const KIND_LABEL_KEY: Record<TrajectoryCellKind, TrajectoryKey> = {
  system: 'kind.system',
  user: 'kind.user',
  context: 'kind.context',
  compacted: 'kind.compacted',
  message: 'kind.assistant',
  tool: 'kind.tool',
  subtool: 'kind.subtool',
}

function ToolWrenchIcon(): ReactNode {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      data-role-icon="wrench"
      aria-hidden="true"
    >
      <path d="M14 3.3a3.8 3.8 0 0 1-4.8 4.8l-5.1 5.1a1.6 1.6 0 1 1-2.3-2.3l5.1-5.1A3.8 3.8 0 0 1 11.7 1l-2.3 2.3 2.3 2.3L14 3.3Z" />
    </svg>
  )
}

function InformationIcon(): ReactNode {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      data-role-icon="information"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6.7" />
      <circle cx="8" cy="5.5" r=".85" fill="currentColor" stroke="none" />
      <path d="M8 7.75v3.4" strokeWidth="1.8" />
    </svg>
  )
}

function CompactedIcon(): ReactNode {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      data-role-icon="compacted"
      aria-hidden="true"
    >
      <path d="m2.5 2.5 3.75 3.75M3 6.25h3.25V3" />
      <path d="m13.5 2.5-3.75 3.75M13 6.25H9.75V3" />
      <path d="m2.5 13.5 3.75-3.75M3 9.75h3.25V13" />
      <path d="m13.5 13.5-3.75-3.75M13 9.75H9.75V13" />
    </svg>
  )
}

const KIND_ICON: Record<TrajectoryCellKind, ReactNode> = {
  system: <IconSettingsOutline16 size={13} />,
  user: <IconUserOutline16 size={13} />,
  context: <InformationIcon />,
  compacted: <CompactedIcon />,
  message: <IconSparkle16 size={13} />,
  tool: <ToolWrenchIcon />,
  subtool: <ToolWrenchIcon />,
}

interface TableRecord {
  turn: number | null
  section: number
  group: string
  groupStart: boolean
  turnStart: boolean
  cell: TrajectoryCellProps
  turnEnd: boolean
  collapsedSummary?: string
  collapsedSummaryKind?: 'turn' | 'assistant'
}

interface VirtualRowStructure {
  height: number
  key: string
}

function useStableVirtualRowStructure(
  rows: readonly TrajectoryVirtualRow<TableRecord>[],
): readonly VirtualRowStructure[] {
  const cache = useRef<{
    rows: readonly TrajectoryVirtualRow<TableRecord>[]
    structure: readonly VirtualRowStructure[]
  }>({ rows: [], structure: [] })
  if (cache.current.rows === rows) return cache.current.structure
  const structure = cache.current.structure.length === rows.length
    && rows.every((row, index) => {
      const previous = cache.current.structure[index]
      return previous?.key === row.key && previous.height === row.height
    })
    ? cache.current.structure
    : rows.map(row => ({ key: row.key, height: row.height }))
  cache.current = { rows, structure }
  return structure
}

type DetailTab =
  | 'system-prompt'
  | 'tools'
  | 'overview'
  | 'rendered'
  | 'raw'
  | 'source'
  | 'input'
  | 'output'
  | 'schema'
  | 'options'
  | 'usage'
  | 'timing'
  | 'diff'
type RecordState = 'complete' | 'running' | 'error'

interface DetailTabItem {
  id: DetailTab
  labelKey: TrajectoryKey
}

interface ParentRecords {
  message?: TableRecord
  tool?: TableRecord
}

interface ToolCallTextParts {
  name: string
  args?: string
}

interface SelectedRequest {
  identity: string
}

interface DetailsResizeDrag {
  pointerId: number
  startX: number
  startWidth: number
  splitWidth: number
  startToolRequestOffset: number
}

const DETAILS_MIN_WIDTH = 320
const DETAILS_MAX_WIDTH = 720
const TABLE_MIN_WIDTH = 280
const DETAILS_RESIZE_STEP = 16
const TOOL_REQUEST_SHARE = 0.58
const TOOL_REQUEST_MIN_WIDTH = 180
const TOOL_REQUEST_MAX_WIDTH = 480
const DEFAULT_TOOL_REQUEST_SHARE = 0.36
const DEFAULT_TOOL_REQUEST_OFFSET = 56
const SYSTEM_PROMPT_TABS: readonly DetailTabItem[] = [
  { id: 'system-prompt', labelKey: 'tab.systemPrompt' },
  { id: 'tools', labelKey: 'tab.tools' },
]
const SYSTEM_UPDATE_TABS: readonly DetailTabItem[] = [
  { id: 'diff', labelKey: 'tab.diff' },
  ...SYSTEM_PROMPT_TABS,
]
const REQUEST_TABS: readonly DetailTabItem[] = [
  { id: 'overview', labelKey: 'tab.summary' },
  { id: 'options', labelKey: 'tab.options' },
  { id: 'usage', labelKey: 'tab.usage' },
  { id: 'timing', labelKey: 'tab.timing' },
]

function jsonTreeLabels(t: TrajectoryTranslate): JsonTreeLabels {
  return {
    copyValue: t('copy.value'),
    copyJson: t('copy.json'),
    copyPath: t('copy.path'),
    copyPrettyJson: t('copy.prettyJson'),
    copyCompactJson: t('copy.compactJson'),
    copied: t('copied'),
    copyFailed: t('copy.failed'),
    collapseNode: t('json.collapseNode'),
    expandNode: t('json.expandNode'),
    copyButtonTitle: action => t('copy.optionsHint', { action }),
  }
}

function markdownLabels(t: TrajectoryTranslate): MarkdownLabels {
  return {
    code: { copyLabel: t('copy'), copiedLabel: t('copied') },
    footnotes: t('markdown.footnotes'),
  }
}

type TrajectorySplitStyle = CSSProperties & {
  '--trajectory-tool-request-width': string
}

type RequestBoundaryStyle = CSSProperties & {
  '--request-boundary-offset': string
}

type VirtualSpacerStyle = CSSProperties & {
  '--trajectory-virtual-spacer-height': string
}

interface OlderLoadAnchor {
  readonly historyStartSeq: number | undefined
  readonly scrollHeight: number
  readonly scrollTop: number
}

function clampDetailsWidth(width: number, splitWidth: number): number {
  const maxWidth = Math.max(
    DETAILS_MIN_WIDTH,
    Math.min(DETAILS_MAX_WIDTH, splitWidth - TABLE_MIN_WIDTH),
  )
  return Math.round(Math.min(Math.max(width, DETAILS_MIN_WIDTH), maxWidth))
}

function defaultToolRequestWidth(splitWidth: number): number {
  return Math.min(
    Math.max(
      splitWidth * DEFAULT_TOOL_REQUEST_SHARE - DEFAULT_TOOL_REQUEST_OFFSET,
      TOOL_REQUEST_MIN_WIDTH,
    ),
    TOOL_REQUEST_MAX_WIDTH,
  )
}

function formatDurationMs(milliseconds: number, t: TrajectoryTranslate): string {
  if (milliseconds < 1_000) return t('unit.milliseconds', { value: Math.round(milliseconds) })
  return t('unit.seconds', {
    value: (milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 2 : 1),
  })
}

function formatStartedAt(timestamp: number | null, t: TrajectoryTranslate): string {
  if (timestamp === null || !Number.isFinite(timestamp)) return t('timing.notAvailable')
  const date = new Date(timestamp)
  const two = (value: number) => String(value).padStart(2, '0')
  const three = (value: number) => String(value).padStart(3, '0')
  const time = `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}.${three(date.getMilliseconds())}`
  const day = `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`
  return `${day} ${time}`
}

/** Whether a click lands on an active text selection and should keep it. */
function clickSelectsText(target: Node): boolean {
  const selection = window.getSelection()
  return selection !== null
    && !selection.isCollapsed
    && selection.rangeCount > 0
    && selection.getRangeAt(0).intersectsNode(target)
}

function StartedAtValue({ timestamp, t }: { timestamp: number | null; t: TrajectoryTranslate }) {
  const [showUnix, setShowUnix] = useState(false)
  if (timestamp === null || !Number.isFinite(timestamp)) return <dd>{t('timing.notAvailable')}</dd>
  return (
    <dd>
      <button
        type="button"
        className={css.timestampToggle}
        title={showUnix ? t('timing.showLocalTime') : t('timing.showUnixTimestamp')}
        onClick={(event) => {
          if (clickSelectsText(event.currentTarget)) return
          setShowUnix(current => !current)
        }}
      >
        {showUnix ? (timestamp / 1_000).toFixed(3) : formatStartedAt(timestamp, t)}
      </button>
    </dd>
  )
}

function totalTime(metrics: AssistantMetricDetail, t: TrajectoryTranslate): string {
  if (!metrics.timingRecorded) return t('timing.notRecorded')
  if (metrics.stepStartTime === null) return t('timing.stepStartUnavailable')
  if (metrics.completedTime === null) return t('status.pending')
  return formatDurationMs(Math.max(0, metrics.completedTime - metrics.stepStartTime), t)
}

function ttft(metrics: AssistantMetricDetail, t: TrajectoryTranslate): string {
  if (!metrics.timingRecorded) return t('timing.notRecorded')
  if (metrics.stepStartTime === null) return t('timing.stepStartUnavailable')
  if (metrics.firstTokenTime === null) return t('timing.firstTokenUnavailable')
  return formatDurationMs(Math.max(0, metrics.firstTokenTime - metrics.stepStartTime), t)
}

function generationTime(metrics: AssistantMetricDetail, t: TrajectoryTranslate): string {
  if (!metrics.timingRecorded || metrics.firstTokenTime === null) return t('timing.firstTokenUnavailable')
  if (metrics.completedTime === null) return t('status.pending')
  return formatDurationMs(Math.max(0, metrics.completedTime - metrics.firstTokenTime), t)
}

function throughput(metrics: AssistantMetricDetail, t: TrajectoryTranslate): string {
  if (!metrics.usageProvided) return t('timing.usageUnavailable')
  if (metrics.outputTokens === null) return t('timing.outputTokensUnavailable')
  if (!metrics.timingRecorded || metrics.firstTokenTime === null) return t('timing.firstTokenUnavailable')
  if (metrics.completedTime === null) return t('status.pending')
  const generationSeconds = (metrics.completedTime - metrics.firstTokenTime) / 1_000
  if (generationSeconds <= 0) return t('timing.durationTooShort')
  return t('unit.tokensPerSecond', {
    value: (metrics.outputTokens / generationSeconds).toFixed(1),
  })
}

function AssistantTimingPanel({
  metrics,
  t,
}: { metrics: AssistantMetricDetail; t: TrajectoryTranslate }) {
  return (
    <dl className={css.overview}>
      <div><dt>{t('timing.started')}</dt><StartedAtValue timestamp={metrics.stepStartTime} t={t} /></div>
      <div><dt>{t('timing.totalDuration')}</dt><dd>{totalTime(metrics, t)}</dd></div>
      <div><dt>{t('timing.ttft')}</dt><dd>{ttft(metrics, t)}</dd></div>
      <div><dt>{t('timing.generation')}</dt><dd>{generationTime(metrics, t)}</dd></div>
      <div><dt>{t('timing.throughput')}</dt><dd>{throughput(metrics, t)}</dd></div>
    </dl>
  )
}

/** Props for the trajectory ledger. */
export interface TrajectoryTableProps {
  /** Trajectory locale seat. */
  t: TrajectoryTranslate
  /** Slot-backed durable image renderer shared with the Chat gallery. */
  renderImages: RenderMessageImages
  /** Session-global request numbers for the request groups visible in this context. */
  requestNumbers?: readonly TrajectoryRequestNumber[]
  /** Grouped records in display order. */
  turns: readonly TrajectoryTurnModel[]
  /** In-flight cells whose content replaces the matching structural record index. */
  streamingCells?: readonly TrajectoryCellProps[]
  /** Record indexes emphasized by the active timeline focus. */
  timelineFocusIndexes?: ReadonlySet<number> | null
  /** Record indexes retained by the active live search, or null without a query. */
  searchMatchIndexes?: ReadonlySet<number> | null
  /** Report the record currently selected in the local inspector. */
  onSelectedIndexChange?: (index: number | null) => void
  /** Report a direct user selection from a ledger row. */
  onRecordSelect?: (index: number) => void
  /** One externally requested record selection; a new object repeats the request. */
  recordSelection?: { readonly index: number } | null
  /** One externally requested record focus without changing inspector selection. */
  recordFocus?: { readonly index: number } | null
  /** Whether the initial history tail is still loading. */
  historyLoading?: boolean
  /** Whether one older history page request is pending anywhere. */
  olderHistoryLoading?: boolean
  /** First loaded raw event, used to preserve scroll position after prepending a page. */
  historyStartSeq?: number | undefined
  /** Whether one older history page can be requested. */
  hasOlderRecords?: boolean
  /** Load one older history page. */
  onLoadOlder?: () => Promise<boolean>
  /** Clear selection state owned by the ledger host. */
  onClearSelection?: () => void
  /** Turn ids whose rows after the first are folded into a summary. */
  collapsedTurns: ReadonlySet<number>
  /** Toggle one turn between folded and expanded. */
  onToggleTurn: (turn: number) => void
  /** Stable Assistant record ids whose tool calls are folded. */
  collapsedAssistants: ReadonlySet<string>
  /** Toggle tool calls under one assistant record. */
  onToggleAssistant: (id: string) => void
  /** One-shot cross-view inspect: open and scroll to this call's record. */
  inspectCallId?: string | null
  /** Acknowledge a consumed (or unresolvable) inspect request. */
  onInspectApplied?: (() => void) | undefined
}

/** Request-inspector fields shared by ordinary generation and compaction. */
interface TrajectoryRequestNumberBase {
  group: string
  number: number
  status?: 'complete' | 'running' | 'error'
  startedAt?: number
  completedAt?: number | null
  error?: string
  errorCode?: string
  retry?: number
  maxRetries?: number
  retryDelayMs?: number
  resultSeq?: number
  provider?: string
  model?: string
  requestConfig?: AssistantRequestConfig
  usage?: TrajectoryUsage
  cumulativeUsage?: TrajectoryUsage
}

/** One purpose-discriminated request identity paired with its session-global number. */
export type TrajectoryRequestNumber = TrajectoryRequestNumberBase & (
  | {
    purpose?: 'assistant'
    /** Request anchor event sequence; absent for the currently streaming request. */
    seq?: number
    turn: number
    step: number
  }
  | {
    purpose: 'compaction'
    /** Request anchor event sequence and stable compaction identity. */
    seq: number
    turn: number | null
    step: 0
  }
)

/** Disjoint provider token buckets for one request or a session prefix. */
export interface TrajectoryUsage {
  input?: number
  cacheRead?: number
  cacheWrite?: number
  output?: number
  reasoning?: number
}

function flattenRecords(turns: readonly TrajectoryTurnModel[]): TableRecord[] {
  return turns.flatMap((turn, section) => {
    let firstInSection = true
    const records = turn.groups.flatMap((group) => {
      return group.cells.map((cell, index) => {
        const turnStart = firstInSection
          && cell.requestOnly !== true
          && cell.kind !== 'system'
          && (cell.kind !== 'compacted' || turn.turn === null)
        if (turnStart) firstInSection = false
        return {
          turn: turn.turn,
          section,
          group: group.title,
          groupStart: index === 0,
          turnStart,
          cell,
          turnEnd: false,
        }
      })
    })
    const last = records.at(-1)
    if (last !== undefined) last.turnEnd = true
    return records
  })
}

function filterRecords(
  records: readonly TableRecord[],
  matches: ReadonlySet<number>,
): TableRecord[] {
  const filtered = records
    .filter(record =>
      record.cell.requestOnly !== true && matches.has(record.cell.index),
    )
    .map(record => ({ ...record, groupStart: false, turnStart: false, turnEnd: false }))
  const startedSections = new Set<number>()
  for (const [index, record] of filtered.entries()) {
    const previous = filtered[index - 1]
    const next = filtered[index + 1]
    record.groupStart = previous === undefined
      || previous.section !== record.section
      || previous.group !== record.group
    record.turnStart = !startedSections.has(record.section)
      && record.cell.kind !== 'system'
      && (record.cell.kind !== 'compacted' || record.turn === null)
    if (record.turnStart) startedSections.add(record.section)
    record.turnEnd = next === undefined || next.section !== record.section
  }
  return filtered
}

function requestKey(turn: number | null, group: string): string {
  return `${turn}\u0000${group}`
}

function requestIdentity(request: TrajectoryRequestNumber): string {
  return request.purpose === 'compaction'
    ? `compaction\u0000${request.seq}`
    : `assistant\u0000${request.turn}\u0000${request.step}`
}

function indexRequestBoundaries(
  records: readonly TableRecord[],
  requestGroups: ReadonlySet<string>,
): ReadonlyMap<string, number> {
  const boundaries = new Map<string, number>()
  for (const record of records) {
    const key = requestKey(record.turn, record.group)
    if (!requestGroups.has(key)) continue
    if (boundaries.has(key)) continue
    if (record.cell.kind === 'user' || record.cell.kind === 'context') continue
    boundaries.set(key, record.cell.index)
  }
  return boundaries
}

function sectionLabel(turn: number | null, t: TrajectoryTranslate): string {
  return turn === null ? t('section.betweenTurns') : t('turn.label', { turn })
}

function indexRequestNumbers(
  sessionNumbers: readonly TrajectoryRequestNumber[] | undefined,
): ReadonlyMap<string, number> {
  const numbers = new Map<string, number>()
  for (const request of sessionNumbers ?? []) {
    numbers.set(requestKey(request.turn, request.group), request.number)
  }
  return numbers
}

function indexRequestBoundaryRuns(
  records: readonly TableRecord[],
  requestGroups: ReadonlySet<string>,
): ReadonlyMap<number, number> {
  const indexes = new Map<number, number>()
  let runLength = 0
  for (const record of records) {
    if (record.cell.requestOnly === true) {
      indexes.set(record.cell.index, runLength++)
      continue
    }
    if (
      runLength > 0
      && record.groupStart
      && requestGroups.has(requestKey(record.turn, record.group))
    ) {
      indexes.set(record.cell.index, runLength)
    }
    runLength = 0
  }
  return indexes
}

function summarizeTurn(
  records: readonly TableRecord[],
  requestGroups: ReadonlySet<string>,
  t: TrajectoryTranslate,
): string {
  const steps = new Set(
    records
      .map(record => requestKey(record.turn, record.group))
      .filter(key => requestGroups.has(key)),
  ).size
  const toolCalls = records.filter(record =>
    record.cell.kind === 'tool' || record.cell.kind === 'subtool',
  ).length
  return [
    t(steps === 1 ? 'summary.steps.one' : 'summary.steps.other', { count: steps }),
    t(toolCalls === 1 ? 'summary.toolCalls.one' : 'summary.toolCalls.other', {
      count: toolCalls,
    }),
  ].join(' · ')
}

function collapseTurnRecords(
  records: readonly TableRecord[],
  collapsedTurns: ReadonlySet<number>,
  requestGroups: ReadonlySet<string>,
  t: TrajectoryTranslate,
): TableRecord[] {
  const recordsByTurn = new Map<number, TableRecord[]>()
  for (const record of records) {
    if (record.turn === null) continue
    const turnRecords = recordsByTurn.get(record.turn) ?? []
    turnRecords.push(record)
    recordsByTurn.set(record.turn, turnRecords)
  }
  return records.flatMap((record) => {
    if (record.turn === null || !collapsedTurns.has(record.turn)) return [record]
    const turnRecords = recordsByTurn.get(record.turn) ?? [record]
    if (record.cell.requestOnly === true || record.cell.kind === 'system') return [record]
    const contentRecords = turnRecords.filter(candidate =>
      candidate.cell.requestOnly !== true && candidate.cell.kind !== 'system')
    if (contentRecords.length <= 1) return [record]
    if (record.cell.index !== contentRecords[0]?.cell.index) return []
    return [
      { ...record, turnEnd: false },
      {
        ...record,
        groupStart: false,
        turnStart: false,
        turnEnd: true,
        collapsedSummary: summarizeTurn(contentRecords.slice(1), requestGroups, t),
        collapsedSummaryKind: 'turn',
      },
    ]
  })
}

function assistantToolCalls(
  records: readonly TableRecord[],
  assistantIndex: number,
): readonly TableRecord[] {
  const at = records.findIndex(record => record.cell.index === assistantIndex)
  if (at === -1 || records[at]?.cell.kind !== 'message') return []
  const calls: TableRecord[] = []
  for (let i = at + 1; i < records.length; i++) {
    const record = records[i]
    if (record === undefined) break
    if (record.cell.kind !== 'tool' && record.cell.kind !== 'subtool') break
    calls.push(record)
  }
  return calls
}

function summarizeAssistantTools(
  records: readonly TableRecord[],
  t: TrajectoryTranslate,
): string {
  const names = [...new Set(records.map((record) => {
    const separator = record.cell.text.indexOf(' · ')
    return separator === -1 ? record.cell.text : record.cell.text.slice(0, separator)
  }).filter(name => name !== ''))]
  const count = records.length
  const summary = t(count === 1 ? 'summary.toolCalls.one' : 'summary.toolCalls.other', { count })
  return names.length > 0 ? `${summary} · ${names.join(', ')}` : summary
}

function collapseAssistantRecords(
  records: readonly TableRecord[],
  collapsedAssistants: ReadonlySet<string>,
  t: TrajectoryTranslate,
): TableRecord[] {
  const out: TableRecord[] = []
  for (let i = 0; i < records.length; i++) {
    const record = records[i]
    if (record === undefined) continue
    out.push(record)
    if (
      record.cell.kind !== 'message'
      || !collapsedAssistants.has(trajectoryRecordId(record.cell))
    ) continue
    const calls: TableRecord[] = []
    for (let j = i + 1; j < records.length; j++) {
      const candidate = records[j]
      if (
        candidate === undefined
        || candidate.collapsedSummary !== undefined
        || (candidate.cell.kind !== 'tool' && candidate.cell.kind !== 'subtool')
      ) break
      calls.push(candidate)
    }
    if (calls.length === 0) continue
    const last = calls.at(-1)
    out[out.length - 1] = { ...record, turnEnd: false }
    out.push({
      ...record,
      groupStart: false,
      turnStart: false,
      turnEnd: last?.turnEnd ?? false,
      collapsedSummary: summarizeAssistantTools(calls, t),
      collapsedSummaryKind: 'assistant',
    })
    i += calls.length
  }
  return out
}

function stateOf(record: TableRecord): RecordState {
  if (record.cell.isError) return 'error'
  if (record.cell.kind === 'compacted' && record.cell.timeSeconds === null) return 'running'
  if (
    (record.cell.kind === 'tool' || record.cell.kind === 'subtool')
    && record.cell.outputDetail === undefined
  ) return 'running'
  return 'complete'
}

function statusLabel(state: RecordState, t: TrajectoryTranslate): string {
  if (state === 'error') return t('status.failed')
  if (state === 'running') return t('status.pending')
  return t('status.completed')
}

function requestErrorMessage(
  request: Pick<TrajectoryRequestNumber, 'error' | 'errorCode'>,
  t: TrajectoryTranslate,
): string | undefined {
  if (request.errorCode === 'AUTH') return t('details.failure.auth')
  if (request.error === COMPACTION_INTERRUPTED_ERROR) return t('layout.compactionInterrupted')
  return request.error
}

function TokenRows({ cell, t }: { cell: TrajectoryCellProps; t: TrajectoryTranslate }) {
  const content = cell.output !== undefined && cell.think !== undefined
    ? Math.max(0, cell.output - cell.think)
    : undefined
  return (
    <>
      <div>
        <dt>{t('usage.tokens')}</dt>
        <dd>{cell.output === undefined ? '—' : t('unit.tokens', { value: cell.output })}</dd>
      </div>
      {cell.think !== undefined && (
        <div className={css.requestTokenDetail}>
          <dt>{t('usage.reasoning')}</dt>
          <dd>{t('unit.tokens', { value: cell.think })}</dd>
        </div>
      )}
      {content !== undefined && (
        <div className={css.requestTokenDetail}>
          <dt>{t('usage.content')}</dt>
          <dd>{t('unit.tokens', { value: content })}</dd>
        </div>
      )}
    </>
  )
}

function inputTotal(usage: TrajectoryUsage): number | undefined {
  if (
    usage.input === undefined
    && usage.cacheRead === undefined
    && usage.cacheWrite === undefined
  ) return undefined
  return (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)
}

function UsageRows({ usage, t }: { usage: TrajectoryUsage | undefined; t: TrajectoryTranslate }) {
  if (usage === undefined) return <p className={css.noPayload}>{t('usage.notReported')}</p>
  const totalInput = inputTotal(usage)
  const otherOutput = usage.output !== undefined && usage.reasoning !== undefined
    ? usage.output - usage.reasoning
    : undefined
  return (
    <dl className={css.overview}>
      {totalInput !== undefined && (
        <div><dt>{t('usage.input')}</dt><dd>{t('unit.tokens', { value: totalInput })}</dd></div>
      )}
      {usage.cacheRead !== undefined && (
        <div className={css.requestTokenDetail}>
          <dt>{t('usage.cached')}</dt>
          <dd>{t('unit.tokens', { value: usage.cacheRead })}</dd>
        </div>
      )}
      {usage.cacheWrite !== undefined && (
        <div className={css.requestTokenDetail}>
          <dt>{t('usage.cacheCreated')}</dt>
          <dd>{t('unit.tokens', { value: usage.cacheWrite })}</dd>
        </div>
      )}
      {usage.input !== undefined && (
        <div className={css.requestTokenDetail}>
          <dt>{t('usage.other')}</dt>
          <dd>{t('unit.tokens', { value: usage.input })}</dd>
        </div>
      )}
      {usage.output !== undefined && (
        <div><dt>{t('usage.output')}</dt><dd>{t('unit.tokens', { value: usage.output })}</dd></div>
      )}
      {usage.reasoning !== undefined && (
        <div className={css.requestTokenDetail}>
          <dt>{t('usage.reasoning')}</dt>
          <dd>{t('unit.tokens', { value: usage.reasoning })}</dd>
        </div>
      )}
      {otherOutput !== undefined && (
        <div className={css.requestTokenDetail}>
          <dt>{t('usage.content')}</dt>
          <dd>{t('unit.tokens', { value: otherOutput })}</dd>
        </div>
      )}
    </dl>
  )
}

function RequestUsagePanel({
  usage,
  cumulative,
  t,
}: {
  usage: TrajectoryUsage | undefined
  cumulative: TrajectoryUsage | undefined
  t: TrajectoryTranslate
}) {
  return (
    <div className={css.usagePanel}>
      <section className={css.usageGroup}>
        <h4 className={css.usageHeading}>{t('usage.thisRequest')}</h4>
        <UsageRows usage={usage} t={t} />
      </section>
      <section className={css.usageGroup}>
        <h4 className={css.usageHeading}>{t('usage.sessionCumulative')}</h4>
        <UsageRows usage={cumulative} t={t} />
      </section>
    </div>
  )
}

function RequestOptions({
  options,
  preview = false,
  t,
}: {
  options: AssistantRequestConfig | undefined
  preview?: boolean
  t: TrajectoryTranslate
}) {
  if (options === undefined) {
    return <p className={css.noPayload}>{t('options.notRecorded')}</p>
  }
  return (
    <JsonTree
      data={options}
      label={t('options.json')}
      labels={jsonTreeLabels(t)}
      className={preview ? css.jsonPreview : css.jsonPayload}
    />
  )
}

function messageSourceLabel(source: unknown, t: TrajectoryTranslate): string {
  if (typeof source !== 'object' || source === null || Array.isArray(source)) {
    return t('source.unknown')
  }
  const properties = source as Record<string, unknown>
  const kind = properties.kind
  if (kind === 'user') return t('source.user')
  if (kind === 'plugin') {
    const plugin = properties.plugin
    return typeof plugin === 'string' && plugin !== ''
      ? t('source.pluginNamed', { plugin })
      : t('source.plugin')
  }
  if (kind === 'goal') {
    const round = properties.round
    return typeof round === 'number' && round > 0
      ? t('source.goalRound', { round })
      : t('source.goal')
  }
  if (typeof kind !== 'string' || kind === '') return t('source.unknown')
  return `${kind[0]?.toUpperCase() ?? ''}${kind.slice(1)}`
}

function MessageSource({ record, t }: { record: TableRecord; t: TrajectoryTranslate }) {
  const source = record.cell.messageSource
  if (source === undefined) return <p className={css.noPayload}>{t('source.notRecorded')}</p>
  const data = typeof source === 'object' && source !== null
    ? source
    : { value: source }
  return (
    <JsonTree
      data={data}
      label={t('source.messageJson')}
      labels={jsonTreeLabels(t)}
      className={css.jsonPayload}
    />
  )
}

function isMarkdownRecord(record: TableRecord): boolean {
  return record.cell.kind === 'user'
    || record.cell.kind === 'context'
    || record.cell.kind === 'message'
}

function parentRecords(
  records: readonly TableRecord[],
  record: TableRecord,
): ParentRecords {
  if (record.cell.kind !== 'tool' && record.cell.kind !== 'subtool') return {}
  const at = records.findIndex(candidate => candidate.cell.index === record.cell.index)
  if (at === -1) return {}
  let tool: TableRecord | undefined
  if (record.cell.kind === 'subtool') {
    for (let i = at - 1; i >= 0; i--) {
      const candidate = records[i]
      if (
        candidate === undefined
        || candidate.turn !== record.turn
        || candidate.group !== record.group
      ) break
      if (candidate.cell.kind === 'tool') {
        tool = candidate
        break
      }
    }
  }
  const parentCallId = tool?.cell.callId ?? record.cell.callId
  let message: TableRecord | undefined
  if (parentCallId !== undefined) {
    message = records.find(candidate =>
      candidate.turn === record.turn
      && candidate.cell.kind === 'message'
      && candidate.cell.sourceBlocks?.some(block => block.callId === parentCallId) === true,
    )
  }
  return { ...(message === undefined ? {} : { message }), ...(tool === undefined ? {} : { tool }) }
}

function markdownSource(record: TableRecord): string | undefined {
  if (record.cell.kind === 'user' || record.cell.kind === 'context') {
    return record.cell.inputDetail
  }
  if (record.cell.kind === 'message' || record.cell.kind === 'compacted') {
    return record.cell.outputDetail
  }
  return undefined
}

function detailTabs(record: TableRecord): readonly DetailTabItem[] {
  if (record.cell.kind === 'system') {
    return record.cell.previousPromptDetail === undefined
      ? SYSTEM_PROMPT_TABS
      : SYSTEM_UPDATE_TABS
  }
  if (record.cell.kind === 'compacted') {
    return [
      { id: 'overview', labelKey: 'tab.summary' },
      { id: 'raw', labelKey: 'tab.rawOutput' },
    ]
  }
  if (isMarkdownRecord(record)) {
    return [
      { id: 'overview', labelKey: 'tab.summary' },
      { id: 'rendered', labelKey: 'tab.preview' },
      { id: 'raw', labelKey: 'tab.raw' },
      ...(record.cell.messageSource === undefined
        ? []
        : [{ id: 'source', labelKey: 'tab.source' } as const]),
    ]
  }
  return [
    { id: 'overview', labelKey: 'tab.summary' },
    ...(record.cell.inputDetail ? [{ id: 'input', labelKey: 'tab.payload' } as const] : []),
    ...(record.cell.outputDetail ? [{ id: 'output', labelKey: 'tab.result' } as const] : []),
    { id: 'schema', labelKey: 'tab.schema' },
    { id: 'timing', labelKey: 'tab.timing' },
  ]
}

function recordDisplayText(cell: TrajectoryCellProps, t: TrajectoryTranslate): string {
  if (isToolCallOnly(cell, t)) return ''
  if (cell.previewMarkdown !== undefined) {
    const preview = trajectoryPreviewText(cell.previewMarkdown)
    if (cell.text === '') return preview
    return preview === '' ? cell.text : `${cell.text} · ${preview}`
  }
  if (cell.text !== '') return cell.text
  const markdown = cell.kind === 'user' || cell.kind === 'context'
    ? cell.inputDetail
    : cell.kind === 'message'
      ? cell.outputDetail ?? cell.thinkingDetail
      : undefined
  return markdown === undefined ? '' : trajectoryPreviewText(markdown)
}

function recordResultText(cell: TrajectoryCellProps): string | undefined {
  return cell.resultPreviewMarkdown === undefined
    ? cell.result
    : trajectoryPreviewText(cell.resultPreviewMarkdown)
}

function toolCallTextParts(
  kind: TrajectoryCellKind,
  text: string,
): ToolCallTextParts | undefined {
  if (kind !== 'tool' && kind !== 'subtool') return undefined
  const separator = text.indexOf(' · ')
  if (separator === -1) return { name: text }
  return {
    name: text.slice(0, separator),
    args: text.slice(separator + 3),
  }
}

function isToolCallOnly(cell: TrajectoryCellProps, t: TrajectoryTranslate): boolean {
  return cell.kind === 'message'
    && !cell.outputDetail
    && !cell.thinkingDetail
    && cell.text === t('layout.toolCallOnly')
}

interface RecordPresentationValue {
  displayText: string
  listDisplayText: string
  resultText: string | undefined
  toolCallOnly: boolean
  toolCallText: ToolCallTextParts | undefined
}

function RecordPresentation({
  cell,
  children,
  t,
}: {
  cell: TrajectoryCellProps
  children: (value: RecordPresentationValue) => ReactNode
  t: TrajectoryTranslate
}) {
  const displayText = useMemo(
    () => recordDisplayText(cell, t),
    [
      cell.kind, cell.text, cell.previewMarkdown,
      cell.inputDetail, cell.outputDetail, cell.thinkingDetail, t,
    ],
  )
  const resultText = useMemo(
    () => recordResultText(cell),
    [cell.result, cell.resultPreviewMarkdown],
  )
  const toolCallOnly = isToolCallOnly(cell, t)
  const toolCallText = toolCallTextParts(cell.kind, displayText)
  const listDisplayText = toolCallOnly
    ? t('record.toolCallOnly')
    : toolCallText === undefined
      ? displayText
      : [toolCallText.name, toolCallText.args].filter(Boolean).join(' ')
  return children({
    displayText,
    listDisplayText,
    resultText,
    toolCallOnly,
    toolCallText,
  })
}

function RecordListText({
  displayText,
  toolCallOnly,
  toolCallText,
  t,
}: Pick<RecordPresentationValue, 'displayText' | 'toolCallOnly' | 'toolCallText'> & {
  t: TrajectoryTranslate
}) {
  if (toolCallOnly) {
    return <span className={css.toolCallOnly}>{t('record.toolCallOnly')}</span>
  }
  if (toolCallText === undefined) return displayText || '—'
  return (
    <>
      <span className={css.toolCallNameTypeface}>
        {toolCallText.name || '—'}
      </span>
      {toolCallText.args !== undefined && (
        <span className={css.toolCallPayload}>
          {toolCallText.args}
        </span>
      )}
    </>
  )
}

function MarkdownFragment({
  text,
  rendered,
  preview,
  t,
}: {
  text: string
  rendered: boolean
  preview: boolean
  t: TrajectoryTranslate
}) {
  const labels = useMemo(() => markdownLabels(t), [t])
  if (rendered) {
    return (
      <div className={preview ? css.markdownPreview : css.markdownPayload}>
        <MarkdownText text={text} labels={labels} />
      </div>
    )
  }
  return (
    <pre className={`${css.payload} ${preview ? css.payloadPreview : ''}`}>
      {text}
    </pre>
  )
}

function SourceBlocks({
  blocks,
  onOpenCall,
  renderImages,
  t,
}: {
  blocks: readonly TrajectorySourceBlock[]
  onOpenCall: (callId: string) => void
  renderImages: RenderMessageImages
  t: TrajectoryTranslate
}) {
  return (
    <div className={css.sourceBlocks}>
      {blocks.map((block, index) => (
        <section className={css.sourceBlock} key={index}>
          {block.callId !== undefined
            ? (
              <button
                type="button"
                className={css.sourceBlockJumpTarget}
                aria-label={t('block.openSummary', { index: index + 1 })}
                title={t('block.openSummaryTitle')}
                onClick={() => {
                  if (block.callId !== undefined) onOpenCall(block.callId)
                }}
              >
                <span className={css.sourceBlockLabel}>
                  {t('block.label', { index: index + 1, type: block.type })}
                </span>
                <IconChevronRightOutline14 className={css.sourceBlockJumpIcon} size={12} />
              </button>
            )
            : (
              <div className={css.sourceBlockHeader}>
                <span className={css.sourceBlockLabel}>
                  {t('block.label', { index: index + 1, type: block.type })}
                </span>
              </div>
            )}
          {/* The Raw view keeps model block order and granularity: one
              gallery per image block, unlike the aggregated record gallery. */}
          {block.attachment !== undefined
            ? renderImages({ images: [{ attachment: block.attachment }], align: 'start' })
            : <pre className={css.sourceBlockContent}>{block.content}</pre>}
        </section>
      ))}
    </div>
  )
}

function recordImages(
  blocks: readonly TrajectorySourceBlock[] | undefined,
): { readonly attachment: ImageAttachmentRef }[] {
  return (blocks ?? []).flatMap(block =>
    block.attachment !== undefined ? [{ attachment: block.attachment }] : [])
}

function MessageImages({
  blocks,
  preview,
  renderImages,
}: {
  blocks: readonly TrajectorySourceBlock[] | undefined
  preview: boolean
  renderImages: RenderMessageImages
}) {
  const images = recordImages(blocks)
  if (images.length === 0) return null
  return (
    <div className={preview ? `${css.messageImages} ${css.messageImagesPreview}` : css.messageImages}>
      {renderImages({ images, align: 'start' })}
    </div>
  )
}

function AssistantToolCalls({
  blocks,
  preview,
  onOpenCall,
  t,
}: {
  blocks: readonly TrajectorySourceBlock[] | undefined
  preview: boolean
  onOpenCall: (callId: string) => void
  t: TrajectoryTranslate
}) {
  const calls = blocks?.filter(block => block.type === 'tool-call') ?? []
  if (calls.length === 0) return null
  return (
    <ul className={preview
      ? `${css.assistantToolCalls} ${css.assistantToolCallsPreview}`
      : css.assistantToolCalls}
    >
      {calls.map((call, index) => (
        <li key={call.callId ?? index}>
          <button
            type="button"
            className={css.assistantToolCallButton}
            title={t('block.openSummaryTitle')}
            onClick={() => {
              if (call.callId !== undefined) onOpenCall(call.callId)
            }}
          >
            <svg
              className={css.assistantToolCallIcon}
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94z"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span className={css.assistantToolCallText}>
              <span className={css.assistantToolCallName}>
                {call.toolName ?? t('details.toolCall')}
              </span>
              {call.content !== '' && (
                <span className={css.assistantToolCallArgs}>{call.content}</span>
              )}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}

function ToolGlyph() {
  return (
    <svg
      className={css.toolCatalogIcon}
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function ToolCatalog({
  tools,
  t,
}: { tools: ConversationPromptSnapshot['tools']; t: TrajectoryTranslate }) {
  if (tools.length === 0) return <p className={css.noPayload}>{t('record.toolsMissing')}</p>
  return (
    <div className={css.toolCatalog}>
      {tools.map((tool, index) => (
        <details className={css.toolCatalogItem} key={`${tool.name}:${index}`}>
          <summary className={css.toolCatalogSummary}>
            <IconChevronRightOutline14 className={css.toolCatalogChevron} size={12} />
            <ToolGlyph />
            <span className={css.toolCatalogName}>{tool.name}</span>
            <span className={css.toolCatalogDescription}>{tool.description}</span>
          </summary>
          <div className={css.toolCatalogDefinition}>
            {tool.description !== '' && (
              <p className={css.toolCatalogFullDescription}>{tool.description}</p>
            )}
            <JsonTree
              data={tool.parameters}
              label={t('record.namedParametersJson', { name: tool.name })}
              labels={jsonTreeLabels(t)}
              className={css.toolCatalogTree}
            />
          </div>
        </details>
      ))}
    </div>
  )
}

interface PromptDiffLine {
  kind: 'meta' | 'context' | 'added' | 'removed'
  text: string
}

function promptDiffLines(before: string, after: string): readonly PromptDiffLine[] {
  const patch = structuredPatch('', '', before, after, undefined, undefined, { context: 3 })
  return patch.hunks.flatMap((hunk, hunkIndex) => [
    ...(hunkIndex === 0 ? [] : [{ kind: 'meta' as const, text: '' }]),
    {
      kind: 'meta' as const,
      text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    },
    ...hunk.lines.flatMap((line): PromptDiffLine[] => {
      if (line.startsWith('\\')) return []
      if (line.startsWith('+')) return [{ kind: 'added', text: line }]
      if (line.startsWith('-')) return [{ kind: 'removed', text: line }]
      return [{ kind: 'context', text: line }]
    }),
  ])
}

function PromptDiffSection({
  title,
  before,
  after,
}: {
  title: string
  before: string
  after: string
}) {
  const lines = promptDiffLines(before, after)
  if (lines.length === 0) return null
  return (
    <section className={css.promptDiffSection}>
      <h3 className={css.promptDiffTitle}>{title}</h3>
      <pre className={css.promptDiff}>
        {lines.map((line, index) => (
          <span className={css[`promptDiffLine${line.kind}`]} key={index}>
            {line.text || ' '}
            {'\n'}
          </span>
        ))}
      </pre>
    </section>
  )
}

function SystemPromptDiff({
  before,
  after,
  t,
}: {
  before: ConversationPromptSnapshot
  after: ConversationPromptSnapshot
  t: TrajectoryTranslate
}) {
  const toolsBefore = JSON.stringify(before.tools, null, 2)
  const toolsAfter = JSON.stringify(after.tools, null, 2)
  return (
    <div className={css.promptDiffSections}>
      {before.system !== after.system && (
        <PromptDiffSection
          title={t('record.systemPrompt')}
          before={before.system}
          after={after.system}
        />
      )}
      {toolsBefore !== toolsAfter && (
        <PromptDiffSection
          title={t('record.tools')}
          before={toolsBefore}
          after={toolsAfter}
        />
      )}
    </div>
  )
}

function ToolOutputBlocks({
  blocks,
  error,
  errorDetail,
  preview,
  renderImages,
}: {
  blocks: readonly TrajectorySourceBlock[]
  error: boolean
  /** Failure name and code preserved beside image-only error content. */
  errorDetail?: string | undefined
  preview: boolean
  renderImages: RenderMessageImages
}) {
  return (
    <div className={[
      css.resultBlocks,
      preview ? css.resultBlocksPreview : undefined,
      error ? css.errorPayload : undefined,
    ].filter((value): value is string => value !== undefined).join(' ')}
    >
      {error && errorDetail !== undefined && errorDetail !== ''
        && <pre className={css.resultBlockText}>{errorDetail}</pre>}
      {blocks.map((block, index) => (
        block.attachment !== undefined
          ? (
            <div className={css.messageImages} key={index}>
              {renderImages({ images: [{ attachment: block.attachment }], align: 'start' })}
            </div>
          )
          : block.content !== ''
            ? <pre className={css.resultBlockText} key={index}>{block.content}</pre>
            : null
      ))}
    </div>
  )
}

function MarkdownRecordContent({
  record,
  rendered,
  preview = false,
  thinkingExpanded,
  onThinkingExpandedChange,
  onOpenCall,
  renderImages,
  t,
}: {
  record: TableRecord
  rendered: boolean
  preview?: boolean
  thinkingExpanded: boolean
  onThinkingExpandedChange: (expanded: boolean) => void
  onOpenCall: (callId: string) => void
  renderImages: RenderMessageImages
  t: TrajectoryTranslate
}) {
  if (!rendered && record.cell.sourceBlocks && record.cell.sourceBlocks.length > 0) {
    return (
      <SourceBlocks
        blocks={record.cell.sourceBlocks}
        onOpenCall={onOpenCall}
        renderImages={renderImages}
        t={t}
      />
    )
  }
  if (record.cell.thinkingDetail) {
    if (!rendered) {
      const source = [
        record.cell.thinkingDetail,
        record.cell.outputDetail,
      ].filter((value): value is string => value !== undefined && value !== '').join('\n\n')
      return <MarkdownFragment text={source} rendered={false} preview={preview} t={t} />
    }
    return (
      <div className={`${css.assistantContent} ${css.assistantContentRendered}`}>
        <div className={
          preview && !record.cell.outputDetail
            ? `${css.thinkingQuote} ${css.thinkingQuoteOnlyPreview}`
            : css.thinkingQuote
        }
        >
          <button
            type="button"
            className={css.thinkingToggle}
            aria-expanded={thinkingExpanded}
            onClick={() => { onThinkingExpandedChange(!thinkingExpanded) }}
          >
            {t('record.thinking')}
            <IconChevronRightOutline14 className={css.thinkingChevron} size={12} />
          </button>
          {thinkingExpanded && (
            <MarkdownFragment
              text={record.cell.thinkingDetail}
              rendered={rendered}
              preview={preview}
              t={t}
            />
          )}
        </div>
        {record.cell.outputDetail && (
          <div className={css.assistantOutput}>
            <MarkdownFragment
              text={record.cell.outputDetail}
              rendered={rendered}
              preview={preview}
              t={t}
            />
          </div>
        )}
        <AssistantToolCalls
          blocks={record.cell.sourceBlocks}
          preview={preview}
          onOpenCall={onOpenCall}
          t={t}
        />
        <MessageImages
          blocks={record.cell.sourceBlocks}
          preview={preview}
          renderImages={renderImages}
        />
      </div>
    )
  }
  const source = markdownSource(record)
  const hasImages = record.cell.sourceBlocks?.some(block => block.attachment !== undefined) === true
  const hasToolCalls = record.cell.kind === 'message'
    && record.cell.sourceBlocks?.some(block => block.type === 'tool-call') === true
  if (!source && !hasImages && !hasToolCalls) {
    const emptyLabel = isToolCallOnly(record.cell, t)
      ? t('record.toolCallOnly')
      : record.cell.text || t('record.noContent')
    return <p className={css.noPayload}>{emptyLabel}</p>
  }
  if (!rendered || (!hasImages && !hasToolCalls)) {
    return <MarkdownFragment text={source ?? ''} rendered={rendered} preview={preview} t={t} />
  }
  return (
    <div>
      {source && <MarkdownFragment text={source} rendered preview={preview} t={t} />}
      {record.cell.kind === 'message' && (
        <AssistantToolCalls
          blocks={record.cell.sourceBlocks}
          preview={preview}
          onOpenCall={onOpenCall}
          t={t}
        />
      )}
      <MessageImages blocks={record.cell.sourceBlocks} preview={preview} renderImages={renderImages} />
    </div>
  )
}

function RecordTiming({ record, t }: { record: TableRecord; t: TrajectoryTranslate }) {
  return record.cell.kind === 'message' && record.cell.assistantMetrics !== undefined
    ? <AssistantTimingPanel metrics={record.cell.assistantMetrics} t={t} />
    : (
      <dl className={css.overview}>
        <div><dt>{t('timing.started')}</dt><StartedAtValue timestamp={record.cell.startedAt ?? null} t={t} /></div>
        <div><dt>{t('timing.duration')}</dt><dd>{formatElapsedSeconds(record.cell.timeSeconds, t)}</dd></div>
        <div><dt>{t('timing.source')}</dt><dd>{record.cell.timeSeconds === null ? t('timing.notAvailable') : t('timing.sessionTimestamps')}</dd></div>
      </dl>
    )
}

function RequestTiming({
  assistant,
  anchor,
  request,
  t,
}: {
  assistant: TableRecord | undefined
  anchor: TableRecord | undefined
  request: TrajectoryRequestNumber | undefined
  t: TrajectoryTranslate
}) {
  if (assistant !== undefined) return <RecordTiming record={assistant} t={t} />
  if (request?.startedAt !== undefined) {
    const duration = request.completedAt === null || request.completedAt === undefined
      ? null
      : Math.max(0, (request.completedAt - request.startedAt) / 1000)
    return (
      <dl className={css.overview}>
        <div><dt>{t('timing.started')}</dt><StartedAtValue timestamp={request.startedAt} t={t} /></div>
        <div><dt>{t('timing.duration')}</dt><dd>{formatElapsedSeconds(duration, t)}</dd></div>
        <div>
          <dt>{t('timing.source')}</dt>
          <dd>{duration === null ? t('timing.sessionTimestampsRunning') : t('timing.sessionTimestamps')}</dd>
        </div>
      </dl>
    )
  }
  return (
    <dl className={css.overview}>
      <div>
        <dt>{t('timing.started')}</dt>
        <StartedAtValue timestamp={anchor?.cell.startedAt ?? null} t={t} />
      </div>
      <div><dt>{t('timing.duration')}</dt><dd>{formatElapsedSeconds(null, t)}</dd></div>
    </dl>
  )
}

function RecordPayload({
  record,
  direction,
  preview = false,
  renderImages,
  t,
}: {
  record: TableRecord
  direction: 'input' | 'output'
  preview?: boolean
  renderImages: RenderMessageImages
  t: TrajectoryTranslate
}) {
  const value = direction === 'input' ? record.cell.inputDetail : record.cell.outputDetail
  const missing = direction === 'input'
    ? t('record.noPayload')
    : t('record.noResult')
  if (!value) return <p className={css.noPayload}>{missing}</p>
  const error = direction === 'output' && record.cell.isError === true
  const payloadClass = preview ? css.jsonPreview : css.jsonPayload
  const payloadClassName = error ? `${payloadClass} ${css.errorPayload}` : payloadClass

  const json = parseJsonContainer(value)
  const singleTextResult = direction === 'output'
    && record.cell.outputBlocks?.length === 1
    && record.cell.outputBlocks[0]?.type === 'text'
  if (singleTextResult && json !== undefined) {
    return (
      <JsonTree
        data={json}
        label={t('record.resultJson')}
        labels={jsonTreeLabels(t)}
        className={payloadClassName}
      />
    )
  }

  if (
    direction === 'output'
    && record.cell.outputBlocks?.some(block =>
      block.attachment !== undefined || block.content !== '') === true
  ) {
    return (
      <ToolOutputBlocks
        blocks={record.cell.outputBlocks}
        error={error}
        errorDetail={error ? value : undefined}
        preview={preview}
        renderImages={renderImages}
      />
    )
  }

  const markdown = (
    direction === 'input'
    && (record.cell.kind === 'user' || record.cell.kind === 'context')
  ) || (
    direction === 'output' && record.cell.kind === 'message'
  )
  if (markdown) {
    return (
      <div className={[
        preview ? css.markdownPreview : css.markdownPayload,
        error ? css.errorPayload : undefined,
      ].filter((className): className is string => className !== undefined).join(' ')}
      >
        <MarkdownText text={value} labels={markdownLabels(t)} />
      </div>
    )
  }
  if (json !== undefined) {
    return (
      <JsonTree
        data={json}
        label={t(direction === 'input' ? 'record.payloadJson' : 'record.outputJson')}
        labels={jsonTreeLabels(t)}
        className={payloadClassName}
      />
    )
  }
  return (
    <pre className={[
      css.payload,
      preview ? css.payloadPreview : undefined,
      error ? css.errorPayload : undefined,
      value === t('record.noOutput') ? css.noOutputText : undefined,
    ].filter((value): value is string => value !== undefined).join(' ')}
    >
      {value}
    </pre>
  )
}

function RecordSchema({
  record,
  preview = false,
  t,
}: {
  record: TableRecord
  preview?: boolean
  t: TrajectoryTranslate
}) {
  if (!record.cell.schemaDetail) {
    return <p className={css.noPayload}>{t('record.schemaUnavailable')}</p>
  }
  const schema = parseToolSchema(record.cell.schemaDetail)
  if (schema !== undefined) {
    return (
      <div className={preview ? `${css.schema} ${css.schemaPreview}` : css.schema}>
        <header className={css.schemaIntro}>
          <h3 className={css.schemaName}>{schema.name}</h3>
          <p className={css.schemaDescription}>{schema.description}</p>
        </header>
        <section className={css.schemaParameters}>
          <h4 className={css.schemaParametersTitle}>{t('record.parameters')}</h4>
          <JsonTree
            data={schema.parameters}
            label={t('record.namedParametersJson', { name: schema.name })}
            labels={jsonTreeLabels(t)}
            className={css.schemaTree}
          />
        </section>
      </div>
    )
  }
  return (
    <pre className={`${css.payload} ${preview ? css.payloadPreview : ''}`}>
      {record.cell.schemaDetail}
    </pre>
  )
}

interface ParsedToolSchema {
  name: string
  description: string
  parameters: object
}

function parseToolSchema(value: string): ParsedToolSchema | undefined {
  try {
    const parsed: unknown = JSON.parse(value)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    const schema = parsed as Record<string, unknown>
    if (
      typeof schema.name !== 'string'
      || typeof schema.description !== 'string'
      || typeof schema.parameters !== 'object'
      || schema.parameters === null
      || Array.isArray(schema.parameters)
    ) return undefined
    return {
      name: schema.name,
      description: schema.description,
      parameters: schema.parameters,
    }
  } catch {
    return undefined
  }
}

function parseJsonContainer(value: string): object | undefined {
  try {
    const parsed: unknown = JSON.parse(value)
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined
  } catch {
    return undefined
  }
}

function OverviewSection({
  label,
  onOpen,
  children,
}: {
  label: string
  onOpen: () => void
  children: ReactNode
}) {
  return (
    <section className={css.overviewSection}>
      <h3 className={css.overviewHeading}>
        <button
          type="button"
          className={css.overviewTitle}
          onClick={onOpen}
        >
          <span>{label}</span>
          <IconChevronRightOutline14 className={css.overviewTitleIcon} size={12} />
        </button>
      </h3>
      <div
        className={`${css.overviewPreview} ${css.summaryScrollRegion}`}
        data-summary-scroll-region=""
      >
        {children}
      </div>
    </section>
  )
}

/**
 * Render trajectory events as a dense ledger with turn and step separators.
 * Clicking ledger whitespace clears the active record or request selection.
 * @param props - Grouped trajectory data and whole-ledger fold state.
 * @returns The ledger and an optional local record inspector.
 */
export function TrajectoryTable({
  t,
  renderImages,
  requestNumbers: sessionRequestNumbers,
  turns,
  streamingCells = [],
  timelineFocusIndexes = null,
  searchMatchIndexes = null,
  onSelectedIndexChange,
  onRecordSelect,
  recordSelection = null,
  recordFocus = null,
  historyLoading = false,
  olderHistoryLoading = false,
  historyStartSeq,
  hasOlderRecords = false,
  onLoadOlder,
  onClearSelection,
  collapsedTurns,
  onToggleTurn,
  collapsedAssistants,
  onToggleAssistant,
  inspectCallId = null,
  onInspectApplied,
}: TrajectoryTableProps) {
  const [selectedRecordId, setSelectedRecordId] = useState<string | null>(null)
  const [selectedRequest, setSelectedRequest] = useState<SelectedRequest | null>(null)
  const [activeTab, setActiveTab] = useState<DetailTab>('overview')
  const [thinkingExpanded, setThinkingExpanded] = useState(false)
  const [detailsWidth, setDetailsWidth] = useState<number | null>(null)
  const [toolRequestOffset, setToolRequestOffset] = useState<number | null>(null)
  const detailsResizeDrag = useRef<DetailsResizeDrag | null>(null)
  const appliedRecordSelection = useRef<TrajectoryTableProps['recordSelection']>(null)
  const appliedRecordFocus = useRef<TrajectoryTableProps['recordFocus']>(null)
  const tabHistory = useRef<Set<DetailTab>>(new Set(['overview']))
  const rootRef = useRef<HTMLDivElement>(null)
  const tablePaneRef = useRef<HTMLDivElement>(null)
  const followsTableTail = useRef(false)
  const tableScrollInitialized = useRef(false)
  const [tableScrollReady, setTableScrollReady] = useState(false)
  const pendingScrollRecordId = useRef<string | null>(null)
  const loadingOlder = useRef(false)
  const [olderLoading, setOlderLoading] = useState(false)
  const olderLoadAnchor = useRef<OlderLoadAnchor | null>(null)
  const allRecords = useMemo(() => flattenRecords(turns), [turns])
  const streamingCellsByIndex = useMemo(
    () => new Map(streamingCells.map(cell => [cell.index, cell])),
    [streamingCells],
  )
  const currentRecord = useCallback((record: TableRecord): TableRecord => {
    const cell = streamingCellsByIndex.get(record.cell.index)
    return cell === undefined ? record : { ...record, cell }
  }, [streamingCellsByIndex])
  const selectedTemplate = useMemo(() => selectedRecordId === null
    ? undefined
    : allRecords.find(record => trajectoryRecordId(record.cell) === selectedRecordId),
  [allRecords, selectedRecordId])
  const selected = selectedTemplate === undefined
    ? undefined
    : currentRecord(selectedTemplate)
  const selectedIndex = selected?.cell.index ?? null
  useEffect(() => {
    onSelectedIndexChange?.(selectedIndex)
  }, [onSelectedIndexChange, selectedIndex])
  const requestGroups = useMemo(() => new Set(
    (sessionRequestNumbers ?? []).map(request => requestKey(request.turn, request.group)),
  ), [sessionRequestNumbers])
  const requestBoundaries = useMemo(
    () => indexRequestBoundaries(allRecords, requestGroups),
    [allRecords, requestGroups],
  )
  const requestNumbers = useMemo(
    () => indexRequestNumbers(sessionRequestNumbers),
    [sessionRequestNumbers],
  )
  const records = useMemo(() => {
    if (searchMatchIndexes !== null) return filterRecords(allRecords, searchMatchIndexes)
    const turnRecords = collapsedTurns.size === 0
      ? allRecords
      : collapseTurnRecords(allRecords, collapsedTurns, requestGroups, t)
    return collapsedAssistants.size === 0
      ? turnRecords
      : collapseAssistantRecords(turnRecords, collapsedAssistants, t)
  }, [allRecords, collapsedAssistants, collapsedTurns, requestGroups, searchMatchIndexes, t])
  const projectedVirtualRows = useMemo(
    () => groupTrajectoryVirtualRows(records),
    [records],
  )
  const virtualRowStructure = useStableVirtualRowStructure(projectedVirtualRows)
  const virtualizationEnabled = hasOlderRecords
    || records.length > VIRTUALIZATION_THRESHOLD
  const virtualScrollMargin = hasOlderRecords ? HISTORY_LOAD_ROW_HEIGHT_PX : 0
  const estimateVirtualRowSize = useCallback(
    (index: number) => virtualRowStructure[index]?.height ?? 30,
    [virtualRowStructure],
  )
  const getVirtualRowKey = useCallback(
    (index: number) => virtualRowStructure[index]?.key ?? index,
    [virtualRowStructure],
  )
  const getTableScrollElement = useCallback(() => tablePaneRef.current, [])
  const rowVirtualizer = useVirtualizer<HTMLDivElement, HTMLTableRowElement>({
    count: virtualizationEnabled ? virtualRowStructure.length : 0,
    enabled: virtualizationEnabled,
    estimateSize: estimateVirtualRowSize,
    getItemKey: getVirtualRowKey,
    getScrollElement: getTableScrollElement,
    initialRect: { width: 0, height: VIRTUAL_INITIAL_VIEWPORT_HEIGHT_PX },
    anchorTo: 'end',
    overscan: VIRTUAL_OVERSCAN_ROWS,
    scrollMargin: virtualScrollMargin,
    scrollEndThreshold: BOTTOM_FOLLOW_THRESHOLD_PX,
    followOnAppend: 'auto',
  })
  const virtualIndexByRecordId = useMemo(() => {
    const indexes = new Map<string, number>()
    for (const [virtualIndex, row] of projectedVirtualRows.entries()) {
      for (const entry of row.entries) {
        if (entry.record.collapsedSummary === undefined) {
          indexes.set(trajectoryRecordId(entry.record.cell), virtualIndex)
        }
      }
    }
    return indexes
  }, [projectedVirtualRows])
  const virtualItems = virtualizationEnabled ? rowVirtualizer.getVirtualItems() : []
  const virtualTop = Math.max(0, (virtualItems[0]?.start ?? 0) - virtualScrollMargin)
  const virtualBottom = virtualItems.length === 0
    ? 0
    : Math.max(
      0,
      rowVirtualizer.getTotalSize()
        + virtualScrollMargin
        - (virtualItems.at(-1)?.end ?? 0),
    )
  const renderedRecords = virtualizationEnabled
    ? virtualItems.flatMap((item) => {
      const row = projectedVirtualRows[item.index]
      if (row === undefined) return []
      return row.entries.map((entry, entryIndex) => ({
        record: currentRecord(entry.record),
        position: entry.logicalIndex,
        terminalRequestBoundary:
          entry.record.cell.requestOnly === true
          && row.entries.at(-1)?.record.cell.requestOnly === true
          && entryIndex === row.entries.length - 1,
      }))
    })
    : records.map((record, position) => ({
      record: currentRecord(record),
      position,
      terminalRequestBoundary:
        record.cell.requestOnly === true && position === records.length - 1,
    }))
  const requestBoundaryRuns = useMemo(
    () => indexRequestBoundaryRuns(records, requestGroups),
    [records, requestGroups],
  )
  const selectedPrompt = selected?.cell.kind === 'system'
    ? selected.cell.promptDetail
    : undefined
  const selectedPreviousPrompt = selected?.cell.kind === 'system'
    ? selected.cell.previousPromptDetail
    : undefined
  const promptSelected = selectedPrompt !== undefined
  const selectedState = selected === undefined ? undefined : stateOf(selected)
  const selectedRequestInfo = selectedRequest === null
    ? undefined
    : sessionRequestNumbers?.find(request =>
      requestIdentity(request) === selectedRequest.identity)
  const selectedRequestRecordTemplates = useMemo(() => selectedRequestInfo === undefined
    ? []
    : allRecords.filter(record =>
      record.turn === selectedRequestInfo.turn
        && record.group === selectedRequestInfo.group,
    ), [allRecords, selectedRequestInfo])
  const selectedRequestRecords = selectedRequestRecordTemplates.map(currentRecord)
  const selectedRequestAssistant = selectedRequestRecords.find(
    record => record.cell.kind === 'message',
  )
  const selectedRequestAnchor = selectedRequestAssistant ?? selectedRequestRecords[0]
  const selectedRequestNumber = selectedRequestInfo?.number
  const selectedRequestState: RecordState | undefined = selectedRequestInfo === undefined
    ? undefined
    : selectedRequestInfo.status
      ?? (selectedRequestAssistant?.cell.assistantMetrics?.completedTime === null
        ? 'running'
        : selectedRequestAssistant === undefined
          && selectedRequestRecords.some(record => stateOf(record) === 'running')
          ? 'running'
          : 'complete')
  const selectedRequestToolCalls = selectedRequestRecords.filter(
    record => record.cell.kind === 'tool',
  ).length
  const selectedRequestSubtoolCalls = selectedRequestRecords.filter(
    record => record.cell.kind === 'subtool',
  ).length
  const selectedRequestResultTemplate = selectedRequestInfo?.resultSeq === undefined
    ? selectedRequestAssistant
    : allRecords.find(record => record.cell.sourceSeq === selectedRequestInfo.resultSeq)
  const selectedRequestResult = selectedRequestResultTemplate === undefined
    ? undefined
    : currentRecord(selectedRequestResultTemplate)
  const selectedRequestUsage = selectedRequestInfo?.usage ?? (
    selectedRequestAssistant === undefined
      ? undefined
      : {
        ...(selectedRequestAssistant.cell.input === undefined
          ? {}
          : { input: selectedRequestAssistant.cell.input }),
        ...(selectedRequestAssistant.cell.cacheRead === undefined
          ? {}
          : { cacheRead: selectedRequestAssistant.cell.cacheRead }),
        ...(selectedRequestAssistant.cell.cacheWrite === undefined
          ? {}
          : { cacheWrite: selectedRequestAssistant.cell.cacheWrite }),
        ...(selectedRequestAssistant.cell.output === undefined
          ? {}
          : { output: selectedRequestAssistant.cell.output }),
        ...(selectedRequestAssistant.cell.think === undefined
          ? {}
          : { reasoning: selectedRequestAssistant.cell.think }),
      }
  )
  const selectedRequestCumulativeUsage =
    selectedRequestInfo?.cumulativeUsage ?? selectedRequestUsage
  const selectedRequestOptions = selectedRequestInfo?.requestConfig
  const activeTurn = selectedRequestInfo === undefined ? selected?.turn : selectedRequestInfo.turn
  const activeSection = selectedRequestInfo === undefined
    ? selected?.section
    : selectedRequestRecords[0]?.section
  const selectedTabs = selectedRequestInfo !== undefined
    ? REQUEST_TABS.filter(tab => tab.id !== 'options' || selectedRequestOptions !== undefined)
    : selected === undefined ? [] : detailTabs(selected)
  const selectedParents: ParentRecords = selected === undefined
    ? {}
    : parentRecords(allRecords, selected)
  const selectedParentMessage = selectedParents.message
  const selectedParentTool = selectedParents.tool
  const selectedAssistantRequest = selected?.cell.kind === 'message'
    ? requestNumbers.get(requestKey(selected.turn, selected.group))
    : undefined
  const selectedAssistantRequestInfo = selectedAssistantRequest === undefined
    ? undefined
    : sessionRequestNumbers?.find(request => request.number === selectedAssistantRequest)
  const selectedAssistantRequestTarget: SelectedRequest | undefined =
    selectedAssistantRequestInfo === undefined
      ? undefined
      : { identity: requestIdentity(selectedAssistantRequestInfo) }
  const hasSelectedHierarchy = selectedAssistantRequestTarget !== undefined
    || selectedParents.message !== undefined
    || selectedParents.tool !== undefined
  const splitStyle: TrajectorySplitStyle | undefined = toolRequestOffset === null
    ? undefined
    : {
      '--trajectory-tool-request-width': `calc(58cqw - ${toolRequestOffset}px)`,
    }

  const activateTab = (tab: DetailTab) => {
    tabHistory.current.delete(tab)
    tabHistory.current.add(tab)
    setActiveTab(tab)
  }

  const clearInspectorSelection = () => {
    setSelectedRecordId(null)
    setSelectedRequest(null)
  }

  const clearAllSelections = () => {
    clearInspectorSelection()
    onClearSelection?.()
  }

  const selectRecord = useCallback((index: number) => {
    const record = allRecords.find(candidate => candidate.cell.index === index)
    onRecordSelect?.(index)
    setSelectedRequest(null)
    setSelectedRecordId(record === undefined ? null : trajectoryRecordId(record.cell))
    if (record === undefined) return
    const tabs = detailTabs(record)
    const available = new Set(tabs.map(tab => tab.id))
    const recent = [...tabHistory.current].reverse().find(tab => available.has(tab))
    setActiveTab(recent ?? tabs[0]?.id ?? 'overview')
  }, [allRecords, onRecordSelect])
  useEffect(() => {
    if (
      recordSelection === null
      || appliedRecordSelection.current === recordSelection
    ) return
    appliedRecordSelection.current = recordSelection
    selectRecord(recordSelection.index)
    const record = allRecords.find(candidate => candidate.cell.index === recordSelection.index)
    pendingScrollRecordId.current = record === undefined
      ? null
      : trajectoryRecordId(record.cell)
  }, [allRecords, recordSelection, selectRecord])
  useEffect(() => {
    if (recordFocus === null || appliedRecordFocus.current === recordFocus) return
    appliedRecordFocus.current = recordFocus
    const record = allRecords.find(candidate => candidate.cell.index === recordFocus.index)
    pendingScrollRecordId.current = record === undefined
      ? null
      : trajectoryRecordId(record.cell)
  }, [allRecords, recordFocus])

  const selectRequest = (
    request: SelectedRequest,
    tab: 'overview' | 'timing' = 'overview',
  ) => {
    setSelectedRecordId(null)
    setSelectedRequest(request)
    activateTab(tab)
  }

  const openRecordSummary = (target: TableRecord) => {
    const targetAt = allRecords.findIndex(record => record.cell.index === target.cell.index)
    if (target.turn !== null && collapsedTurns.has(target.turn)) onToggleTurn(target.turn)
    if (target.cell.kind === 'tool' || target.cell.kind === 'subtool') {
      for (let i = targetAt - 1; i >= 0; i--) {
        const candidate = allRecords[i]
        if (candidate === undefined || candidate.turn !== target.turn) break
        if (candidate.cell.kind !== 'message') continue
        const assistantId = trajectoryRecordId(candidate.cell)
        if (collapsedAssistants.has(assistantId)) onToggleAssistant(assistantId)
        break
      }
    }
    setSelectedRequest(null)
    setSelectedRecordId(trajectoryRecordId(target.cell))
    activateTab('overview')
  }

  const openCallSummary = (callId: string) => {
    const target = allRecords.find(record => record.cell.callId === callId)
    if (target !== undefined) openRecordSummary(target)
  }

  // Cross-view inspect handoff: resolve the requested call to its record,
  // open its summary, and remember the row to scroll once the un-collapsed
  // ledger has rendered. Not-found leaves the request pending (`turns` in the
  // deps retries as history pages in); the ack clears the store field.
  const openRecordSummaryRef = useRef(openRecordSummary)
  openRecordSummaryRef.current = openRecordSummary
  useEffect(() => {
    if (inspectCallId === null) return
    const target = flattenRecords(turns).find(record => record.cell.callId === inspectCallId)
    if (target === undefined) return
    openRecordSummaryRef.current(target)
    pendingScrollRecordId.current = trajectoryRecordId(target.cell)
    onInspectApplied?.()
  }, [inspectCallId, turns, onInspectApplied])
  useEffect(() => {
    const id = pendingScrollRecordId.current
    if (id === null) return
    const position = records.findIndex(record =>
      trajectoryRecordId(record.cell) === id && record.collapsedSummary === undefined)
    if (position === -1) return
    if (virtualizationEnabled) {
      const virtualIndex = virtualIndexByRecordId.get(id)
      if (virtualIndex === undefined) return
      pendingScrollRecordId.current = null
      followsTableTail.current = false
      rowVirtualizer.scrollToIndex(virtualIndex, { behavior: 'smooth', align: 'center' })
      return
    }
    pendingScrollRecordId.current = null
    followsTableTail.current = false
    const recordIndex = records[position]?.cell.index
    const row = recordIndex === undefined
      ? null
      : rootRef.current?.querySelector<HTMLElement>(`tr[data-record-index="${recordIndex}"]`)
    /* v8 ignore next -- jsdom lacks scrollIntoView; browsers always have it. */
    if (row !== undefined && row !== null && typeof row.scrollIntoView === 'function') {
      row.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [records, rowVirtualizer, virtualIndexByRecordId, virtualizationEnabled])
  useEffect(() => {
    if (timelineFocusIndexes === null || timelineFocusIndexes.size === 0) return
    const focusedPositions = records.flatMap((record, position) =>
      record.collapsedSummary === undefined
      && record.cell.requestOnly !== true
      && timelineFocusIndexes.has(record.cell.index)
        ? [position]
        : [])
    const first = focusedPositions.at(0)
    const last = focusedPositions.at(-1)
    if (first === undefined || last === undefined) return
    if (!virtualizationEnabled) {
      const ledger = rootRef.current
      if (ledger === null) return
      const focusedRows = [
        ...ledger.querySelectorAll<HTMLElement>('tr[data-timeline-focus="inside"]'),
      ]
      const firstRow = focusedRows.at(0)
      const lastRow = focusedRows.at(-1)
      if (firstRow === undefined || lastRow === undefined) return
      const focusHeight =
        lastRow.getBoundingClientRect().bottom - firstRow.getBoundingClientRect().top
      const target = focusHeight > ledger.clientHeight
        ? firstRow
        : focusedRows[Math.floor((focusedRows.length - 1) / 2)]
      /* v8 ignore next -- jsdom lacks scrollIntoView; browsers always have it. */
      if (target !== undefined && typeof target.scrollIntoView === 'function') {
        followsTableTail.current = false
        target.scrollIntoView({
          behavior: 'smooth',
          block: focusHeight > ledger.clientHeight ? 'start' : 'center',
        })
      }
      return
    }
    const focusedVirtualIndexes = [...new Set(focusedPositions.flatMap((position) => {
      const record = records[position]
      if (record === undefined) return []
      const virtualIndex = virtualIndexByRecordId.get(trajectoryRecordId(record.cell))
      return virtualIndex === undefined ? [] : [virtualIndex]
    }))].sort((left, right) => left - right)
    const firstVirtual = focusedVirtualIndexes.at(0)
    const lastVirtual = focusedVirtualIndexes.at(-1)
    if (firstVirtual === undefined || lastVirtual === undefined) return
    const paneHeight = tablePaneRef.current?.clientHeight ?? 0
    const focusHeight = projectedVirtualRows
      .slice(firstVirtual, lastVirtual + 1)
      .reduce((height, row) => height + row.height, 0)
    followsTableTail.current = false
    rowVirtualizer.scrollToIndex(
      focusHeight > paneHeight
        ? firstVirtual
        : focusedVirtualIndexes[Math.floor((focusedVirtualIndexes.length - 1) / 2)]
          ?? firstVirtual,
      {
        behavior: 'smooth',
        align: focusHeight > paneHeight ? 'start' : 'center',
      },
    )
  }, [
    projectedVirtualRows,
    records,
    rowVirtualizer,
    timelineFocusIndexes,
    virtualIndexByRecordId,
    virtualizationEnabled,
  ])
  const requestOlder = useCallback((pane: HTMLDivElement, requireTop: boolean) => {
    if (
      !hasOlderRecords
      || onLoadOlder === undefined
      || loadingOlder.current
      || olderHistoryLoading
      || (requireTop && pane.scrollTop > OLDER_LOAD_THRESHOLD_PX)
    ) return
    loadingOlder.current = true
    setOlderLoading(true)
    olderLoadAnchor.current = {
      historyStartSeq,
      scrollHeight: pane.scrollHeight,
      scrollTop: pane.scrollTop,
    }
    void onLoadOlder().then((advanced) => {
      if (!advanced) olderLoadAnchor.current = null
    }).finally(() => {
      loadingOlder.current = false
      setOlderLoading(false)
    })
  }, [hasOlderRecords, historyStartSeq, olderHistoryLoading, onLoadOlder])
  useLayoutEffect(() => {
    const pane = tablePaneRef.current
    if (pane === null) return
    const anchor = olderLoadAnchor.current
    if (anchor !== null && anchor.historyStartSeq !== historyStartSeq) {
      if (!virtualizationEnabled) {
        pane.scrollTop = anchor.scrollTop + pane.scrollHeight - anchor.scrollHeight
      }
      olderLoadAnchor.current = null
      followsTableTail.current = false
      return
    }
    if (!tableScrollInitialized.current) {
      if (historyLoading) return
      tableScrollInitialized.current = true
      followsTableTail.current = true
      if (virtualizationEnabled) rowVirtualizer.scrollToEnd({ behavior: 'auto' })
      else pane.scrollTop = pane.scrollHeight
      setTableScrollReady(true)
      return
    }
    if (!followsTableTail.current) return
    if (!virtualizationEnabled) pane.scrollTop = pane.scrollHeight
  }, [
    historyLoading,
    historyStartSeq,
    rowVirtualizer,
    virtualRowStructure,
    virtualizationEnabled,
  ])

  const olderBusy = olderHistoryLoading || olderLoading
  const showInitialLoading = historyLoading || !tableScrollReady
  const historyRowOffset = hasOlderRecords ? 1 : 0

  return (
    <div ref={rootRef} className={css.split} style={splitStyle}>
      <div
        ref={tablePaneRef}
        className={css.tablePane}
        data-trajectory-scroll=""
        onScroll={(event) => {
          const pane = event.currentTarget
          followsTableTail.current =
            pane.scrollHeight - pane.clientHeight - pane.scrollTop
              <= BOTTOM_FOLLOW_THRESHOLD_PX
          requestOlder(pane, true)
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) clearAllSelections()
        }}
      >
        {showInitialLoading && (
          <div className={css.historyLoading} role="status" aria-live="polite">
            <span className={css.historyLoadingBar}>
              <span className={css.historyLoadingSpinner} aria-hidden="true" />
              {t('history.loadingTrajectory')}
            </span>
          </div>
        )}
        <table
          className={css.table}
          data-scroll-ready={tableScrollReady || undefined}
          aria-rowcount={records.length + historyRowOffset}
        >
          <colgroup>
            <col className={css.eventColumn} />
            <col className={css.contentColumn} />
          </colgroup>
          <tbody>
            {hasOlderRecords && (
              <tr
                className={css.historyLoadRow}
                data-history-load=""
                aria-rowindex={1}
              >
                <td colSpan={2}>
                  <button
                    type="button"
                    className={css.historyLoadButton}
                    disabled={olderBusy || onLoadOlder === undefined}
                    aria-label={olderBusy
                      ? t('history.loadingEarlierAria')
                      : t('history.loadEarlier')}
                    onClick={() => {
                      const pane = tablePaneRef.current
                      if (pane !== null) requestOlder(pane, false)
                    }}
                  >
                    {olderBusy && (
                      <span className={css.historyLoadingSpinner} aria-hidden="true" />
                    )}
                    <span aria-hidden="true">
                      {olderBusy ? t('history.loadingEarlier') : t('history.loadEarlier')}
                    </span>
                    <span className={css.visuallyHidden} role="status" aria-live="polite">
                      {olderBusy ? t('history.loadingEarlier') : ''}
                    </span>
                  </button>
                </td>
              </tr>
            )}
            {virtualTop > 0 && (
              <tr className={css.virtualSpacer} data-virtual-spacer="top" aria-hidden="true">
                <td
                  colSpan={2}
                  style={{
                    '--trajectory-virtual-spacer-height': `${virtualTop}px`,
                  } as VirtualSpacerStyle}
                />
              </tr>
            )}
            {renderedRecords.map(({ record, position, terminalRequestBoundary }) => (
              <RecordPresentation
                key={trajectoryVirtualRecordKey(record)}
                cell={record.cell}
                t={t}
              >
                {({ displayText, listDisplayText, resultText, toolCallOnly, toolCallText }) => {
                  const isCollapsedSummary = record.collapsedSummary !== undefined
                  const isRequestOnly = record.cell.requestOnly === true
                  const isInitialSystem = record.cell.kind === 'system'
                && record.cell.index === allRecords[0]?.cell.index
                  const key = requestKey(record.turn, record.group)
                  const request = requestBoundaries.get(key) === record.cell.index
                && !isCollapsedSummary
                && (record.turn === null || !collapsedTurns.has(record.turn))
                    ? requestNumbers.get(key)
                    : undefined
                  const requestInfo = request === undefined
                    ? undefined
                    : sessionRequestNumbers?.find(candidate => candidate.number === request)
                  const requestStatus = requestInfo?.status
                ?? (record.cell.isError === true ? 'error' : undefined)
                  const requestRunIndex = requestBoundaryRuns.get(record.cell.index) ?? 0
                  const requestBoundaryStyle: RequestBoundaryStyle = {
                    '--request-boundary-offset': `${requestRunIndex * 8}px`,
                  }
                  const requestLabel = request === undefined
                    ? undefined
                    : t(requestInfo?.purpose === 'compaction'
                      ? 'request.labelCompaction'
                      : 'request.label', { request })
                  const requestSelected = requestInfo !== undefined
                && selectedRequest?.identity === requestIdentity(requestInfo)
                  const sectionActive = record.turn === null
                    ? activeSection === record.section
                    : activeTurn === record.turn
                  return (
                    <tr
                      tabIndex={isRequestOnly ? -1 : 0}
                      aria-rowindex={position + 1 + historyRowOffset}
                      aria-label={isCollapsedSummary
                        ? t('request.collapsedSummary', {
                          kind: t(record.collapsedSummaryKind === 'turn'
                            ? 'request.collapsedTurn'
                            : 'request.collapsedAssistant'),
                          summary: record.collapsedSummary,
                        })
                        : isRequestOnly
                          ? t('request.rowAriaCompaction', { request: request ?? '' })
                          : t('request.rowAria', {
                            request: request === undefined ? '' : t('request.rowPrefix', { request }),
                            kind: t(KIND_LABEL_KEY[record.cell.kind]),
                            content: listDisplayText || t('request.noContent'),
                          })}
                      aria-selected={!isCollapsedSummary && !isRequestOnly && selectedIndex === record.cell.index}
                      data-kind={record.cell.kind}
                      data-trajectory-row-key={trajectoryVirtualRecordKey(record)}
                      data-virtual-position={virtualizationEnabled ? position : undefined}
                      data-record-index={!isCollapsedSummary && !isRequestOnly
                        ? record.cell.index
                        : undefined}
                      data-request-only={isRequestOnly || undefined}
                      data-terminal-request-boundary={terminalRequestBoundary || undefined}
                      data-group-start={record.groupStart || undefined}
                      data-turn-start={record.turnStart || undefined}
                      data-error={record.cell.isError || undefined}
                      data-running={stateOf(record) === 'running' || undefined}
                      data-turn-end={record.turnEnd || undefined}
                      data-collapsed-summary={record.collapsedSummaryKind}
                      data-selected={!isCollapsedSummary && selectedIndex === record.cell.index || undefined}
                      data-timeline-focus={isCollapsedSummary || timelineFocusIndexes === null
                        ? undefined
                        : timelineFocusIndexes.has(record.cell.index) ? 'inside' : 'outside'}
                      onClick={isRequestOnly
                        ? undefined
                        : isCollapsedSummary
                          ? () => {
                            if (record.collapsedSummaryKind === 'turn' && record.turn !== null) {
                              onToggleTurn(record.turn)
                            } else onToggleAssistant(trajectoryRecordId(record.cell))
                          }
                          : () => { selectRecord(record.cell.index) }}
                      onDoubleClick={(event) => {
                        if (isCollapsedSummary || isRequestOnly) return
                        if (record.turn !== null && collapsedTurns.has(record.turn)) {
                          event.preventDefault()
                          onToggleTurn(record.turn)
                          return
                        }
                        if (
                          record.cell.kind === 'message'
                      && assistantToolCalls(allRecords, record.cell.index).length > 0
                        ) {
                          event.preventDefault()
                          onToggleAssistant(trajectoryRecordId(record.cell))
                          return
                        }
                        if (!record.turnStart) return
                        if (record.turn === null) return
                        if (allRecords.filter(candidate =>
                          candidate.turn === record.turn
                      && candidate.cell.requestOnly !== true
                      && candidate.cell.kind !== 'system').length <= 1) return
                        event.preventDefault()
                        onToggleTurn(record.turn)
                      }}
                      onKeyDown={(event) => {
                        if (isRequestOnly) return
                        if (event.key !== 'Enter' && event.key !== ' ') return
                        event.preventDefault()
                        if (isCollapsedSummary) {
                          if (record.collapsedSummaryKind === 'turn' && record.turn !== null) {
                            onToggleTurn(record.turn)
                          } else onToggleAssistant(trajectoryRecordId(record.cell))
                          return
                        }
                        selectRecord(record.cell.index)
                      }}
                    >
                      <td className={css.event}>
                        {request !== undefined && (
                          <button
                            type="button"
                            className={requestSelected
                              ? `${css.requestBoundaryControl} ${css.requestBoundaryControlActive}`
                              : css.requestBoundaryControl}
                            aria-label={requestLabel}
                            aria-pressed={requestSelected}
                            data-label={requestLabel}
                            data-request-run-index={requestRunIndex}
                            data-request-status={requestStatus}
                            style={requestBoundaryStyle}
                            onClick={(event) => {
                              event.stopPropagation()
                              if (requestInfo !== undefined) {
                                selectRequest({ identity: requestIdentity(requestInfo) })
                              }
                            }}
                            onDoubleClick={(event) => { event.stopPropagation() }}
                          />
                        )}
                        {record.turn !== null
                    && activeTurn === record.turn
                    && !isInitialSystem && (
                          <span className={css.turnRail} aria-hidden="true" />
                        )}
                        {!isCollapsedSummary && selectedIndex === record.cell.index && (
                          <span className={css.selectionRail} aria-hidden="true" />
                        )}
                        {!isCollapsedSummary
                    && !isRequestOnly
                    && record.turnStart && (
                          <span
                            className={sectionActive
                              ? `${css.turnLabel} ${css.turnLabelActive}`
                              : css.turnLabel}
                            aria-label={sectionLabel(record.turn, t)}
                          >
                            {record.turn === null
                              ? sectionLabel(record.turn, t)
                              : (
                                <>
                                  <span className={css.turnLabelFull} aria-hidden="true">
                                    {sectionLabel(record.turn, t)}
                                  </span>
                                  <span className={css.turnLabelCompact} aria-hidden="true">
                                    #{record.turn}
                                  </span>
                                </>
                              )}
                          </span>
                        )}
                        <div className={css.eventInner}>
                          {!isCollapsedSummary && !isRequestOnly && (
                            <span
                              className={css.kindSlot}
                            >
                              <span
                                className={`${css.kindTag} ${
                                  record.cell.kind === 'system'
                                    ? css.systemNeutral
                                    : record.cell.kind === 'context'
                                      ? css.contextGreen
                                      : record.cell.kind === 'compacted'
                                        ? css.compacted
                                        : record.cell.kind === 'tool'
                                          ? css.toolAmber
                                          : record.cell.kind === 'message'
                                            ? css.assistantVioletBright
                                            : record.cell.kind === 'subtool'
                                              ? css.subtoolAmber
                                              : css[record.cell.kind]
                                }`}
                                data-role-kind={record.cell.kind}
                              >
                                <Tooltip
                                  label={t(KIND_LABEL_KEY[record.cell.kind])}
                                  side="right"
                                >
                                  <span className={css.kindTagIcon} aria-hidden="true">
                                    {KIND_ICON[record.cell.kind]}
                                  </span>
                                </Tooltip>
                                <span className={css.kindTagLabel}>
                                  {t(KIND_LABEL_KEY[record.cell.kind])}
                                </span>
                              </span>
                            </span>
                          )}
                        </div>
                      </td>
                      <td className={css.content}>
                        {isRequestOnly
                          ? null
                          : record.collapsedSummary !== undefined
                            ? (
                              <span className={css.collapsedTurnContent} title={record.collapsedSummary}>
                                <span className={css.collapsedTurnEllipsis}>…</span>
                                <span className={css.collapsedTurnText}>{record.collapsedSummary}</span>
                              </span>
                            )
                            : (
                              <span
                                className={resultText === undefined ? css.contentText : css.resultPreview}
                                title={resultText === undefined
                                  ? listDisplayText
                                  : `${listDisplayText} → ${resultText}`}
                              >
                                <span className={resultText === undefined ? undefined : css.resultRequest}>
                                  <RecordListText
                                    displayText={displayText}
                                    toolCallOnly={toolCallOnly}
                                    toolCallText={toolCallText}
                                    t={t}
                                  />
                                </span>
                                {resultText !== undefined && (
                                  <span className={record.cell.isError ? `${css.inlineResult} ${css.error}` : css.inlineResult}>
                                    <span className={css.arrow}>→</span>
                                    <span className={resultText === t('record.noOutput')
                                      ? `${css.inlineResultText} ${css.noOutputText}`
                                      : css.inlineResultText}
                                    >
                                      {resultText}
                                    </span>
                                  </span>
                                )}
                              </span>
                            )}
                      </td>
                    </tr>
                  )
                }}
              </RecordPresentation>
            ))}
            {virtualBottom > 0 && (
              <tr className={css.virtualSpacer} data-virtual-spacer="bottom" aria-hidden="true">
                <td
                  colSpan={2}
                  style={{
                    '--trajectory-virtual-spacer-height': `${virtualBottom}px`,
                  } as VirtualSpacerStyle}
                />
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {(selectedRequestInfo !== undefined
        || promptSelected
        || (selected !== undefined && selectedState !== undefined)) && (
        <aside
          className={css.details}
          aria-label={t('details.event')}
          style={detailsWidth === null ? undefined : { width: detailsWidth }}
        >
          <div
            className={css.detailsResizeHandle}
            role="separator"
            aria-label={t('details.resize')}
            aria-controls="trajectory-detail-panel"
            aria-orientation="vertical"
            tabIndex={0}
            title={t('details.resizeTitle')}
            onDoubleClick={() => {
              setDetailsWidth(null)
              setToolRequestOffset(null)
            }}
            onPointerDown={(event) => {
              if (event.button !== 0) return
              const details = event.currentTarget.parentElement
              if (details === null) return
              const split = details.parentElement
              if (split === null) return
              const splitWidth = split.getBoundingClientRect().width
              detailsResizeDrag.current = {
                pointerId: event.pointerId,
                startX: event.clientX,
                startWidth: details.getBoundingClientRect().width,
                splitWidth,
                startToolRequestOffset: toolRequestOffset ?? (
                  splitWidth * TOOL_REQUEST_SHARE - defaultToolRequestWidth(splitWidth)
                ),
              }
              event.currentTarget.setPointerCapture(event.pointerId)
              event.preventDefault()
            }}
            onPointerMove={(event) => {
              const drag = detailsResizeDrag.current
              if (drag === null || drag.pointerId !== event.pointerId) return
              const nextDetailsWidth = clampDetailsWidth(
                drag.startWidth + drag.startX - event.clientX,
                drag.splitWidth,
              )
              setDetailsWidth(nextDetailsWidth)
              setToolRequestOffset(
                drag.startToolRequestOffset
                + (nextDetailsWidth - drag.startWidth) * TOOL_REQUEST_SHARE,
              )
            }}
            onPointerUp={(event) => {
              if (detailsResizeDrag.current?.pointerId !== event.pointerId) return
              detailsResizeDrag.current = null
              event.currentTarget.releasePointerCapture(event.pointerId)
            }}
            onPointerCancel={() => {
              detailsResizeDrag.current = null
            }}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
              const details = event.currentTarget.parentElement
              if (details === null) return
              const split = details.parentElement
              if (split === null) return
              const direction = event.key === 'ArrowLeft' ? 1 : -1
              const currentDetailsWidth = details.getBoundingClientRect().width
              const splitWidth = split.getBoundingClientRect().width
              const nextDetailsWidth = clampDetailsWidth(
                currentDetailsWidth + direction * DETAILS_RESIZE_STEP,
                splitWidth,
              )
              const currentToolRequestOffset = toolRequestOffset ?? (
                splitWidth * TOOL_REQUEST_SHARE - defaultToolRequestWidth(splitWidth)
              )
              setDetailsWidth(nextDetailsWidth)
              setToolRequestOffset(
                currentToolRequestOffset
                + (nextDetailsWidth - currentDetailsWidth) * TOOL_REQUEST_SHARE,
              )
              event.preventDefault()
            }}
          />
          <div className={css.detailsHeader}>
            <div className={css.detailsTitle}>
              {selectedRequestInfo !== undefined
                ? (
                  <>
                    <span className={css.requestDetailsDot} aria-hidden="true" />
                    <span className={css.requestDetailsName}>
                      {t('request.label', { request: selectedRequestNumber ?? '—' })}
                    </span>
                    <span className={css.detailsLocation}>
                      {selectedRequestInfo.purpose === 'compaction'
                        ? t('request.compaction', { section: sectionLabel(selectedRequestInfo.turn, t) })
                        : sectionLabel(selectedRequestInfo.turn, t)}
                    </span>
                  </>
                )
                : promptSelected
                  ? (
                    <>
                      <span className={`${css.kindTag} ${css.systemNeutral}`}>{t('kind.system')}</span>
                      <span className={css.detailsLocation}>{selected?.cell.text}</span>
                    </>
                  )
                  : selected !== undefined && (
                    <>
                      <span className={`${css.kindTag} ${
                        selected.cell.kind === 'context'
                          ? css.contextGreen
                          : selected.cell.kind === 'compacted'
                            ? css.compacted
                            : selected.cell.kind === 'tool'
                              ? css.toolAmber
                              : selected.cell.kind === 'message'
                                ? css.assistantVioletBright
                                : selected.cell.kind === 'subtool'
                                  ? css.subtoolAmber
                                  : css[selected.cell.kind]
                      }`}
                      >
                        {t(KIND_LABEL_KEY[selected.cell.kind])}
                      </span>
                      <span className={css.detailsLocation}>
                        {selected.cell.kind === 'compacted'
                          ? sectionLabel(selected.turn, t)
                          : `${sectionLabel(selected.turn, t)} · ${selected.group}`}
                      </span>
                    </>
                  )}
            </div>
            <button
              type="button"
              className={css.close}
              aria-label={t('details.close')}
              onClick={clearInspectorSelection}
            >
              <span aria-hidden="true">×</span>
            </button>
          </div>
          <div className={css.detailTabs} role="tablist" aria-label={t('details.event')}>
            {selectedTabs.map(tab => (
              <button
                key={tab.id}
                id={`trajectory-detail-${tab.id}`}
                type="button"
                role="tab"
                aria-controls="trajectory-detail-panel"
                aria-selected={activeTab === tab.id}
                className={activeTab === tab.id ? `${css.detailTab} ${css.detailTabActive}` : css.detailTab}
                onClick={() => { activateTab(tab.id) }}
              >
                {t(tab.labelKey)}
              </button>
            ))}
          </div>
          <div
            id="trajectory-detail-panel"
            className={activeTab === 'overview'
              ? `${css.detailBody} ${css.detailBodySummary}`
              : css.detailBody}
            role="tabpanel"
            aria-labelledby={`trajectory-detail-${activeTab}`}
          >
            {selectedRequestInfo !== undefined
              && selectedRequestState !== undefined
              && activeTab === 'overview' && (
              <>
                <dl
                  className={`${css.overview} ${css.summaryScrollRegion}`}
                  data-summary-scroll-region=""
                >
                  <div>
                    <dt>{t('details.status')}</dt>
                    <dd className={selectedRequestState === 'error' ? css.error : undefined}>
                      {statusLabel(selectedRequestState, t)}
                    </dd>
                  </div>
                  {selectedRequestInfo.purpose === 'compaction' && (
                    <div>
                      <dt>{t('details.purpose')}</dt>
                      <dd>{t('request.compactionPurpose')}</dd>
                    </div>
                  )}
                  {(selectedRequestInfo.provider
                    ?? selectedRequestInfo.requestConfig?.provider) !== undefined && (
                    <div>
                      <dt>{t('details.provider')}</dt>
                      <dd>
                        {selectedRequestInfo.provider
                          ?? selectedRequestInfo.requestConfig?.provider}
                      </dd>
                    </div>
                  )}
                  {(selectedRequestInfo.model
                    ?? selectedRequestInfo.requestConfig?.model) !== undefined && (
                    <div>
                      <dt>{t('details.model')}</dt>
                      <dd>
                        {selectedRequestInfo.model
                          ?? selectedRequestInfo.requestConfig?.model}
                      </dd>
                    </div>
                  )}
                  <div>
                    <dt>{t('details.toolCalls')}</dt>
                    <dd>{selectedRequestToolCalls}</dd>
                  </div>
                  {selectedRequestSubtoolCalls > 0 && (
                    <div>
                      <dt>{t('details.subtoolCalls')}</dt>
                      <dd>{selectedRequestSubtoolCalls}</dd>
                    </div>
                  )}
                  {selectedRequestInfo.error !== undefined && (
                    <div>
                      <dt>{t('details.error')}</dt>
                      <dd className={css.error}>{requestErrorMessage(selectedRequestInfo, t)}</dd>
                    </div>
                  )}
                  {selectedRequestInfo.retry !== undefined && (
                    <div>
                      <dt>{t('details.retry')}</dt>
                      <dd>
                        {t('details.scheduled')} {selectedRequestInfo.maxRetries === undefined
                          ? selectedRequestInfo.retry
                          : t('request.retryProgress', {
                            retry: selectedRequestInfo.retry,
                            maximum: selectedRequestInfo.maxRetries,
                          })}
                      </dd>
                    </div>
                  )}
                  {selectedRequestInfo.retryDelayMs !== undefined && (
                    <div>
                      <dt>{t('details.retryDelay')}</dt>
                      <dd>{formatDurationMs(selectedRequestInfo.retryDelayMs, t)}</dd>
                    </div>
                  )}
                  {selectedRequestResult !== undefined && (
                    <div>
                      <dt>{t('details.result')}</dt>
                      <dd className={css.overviewParentLinks}>
                        <button
                          type="button"
                          className={css.overviewHierarchyNavLink}
                          onClick={() => {
                            openRecordSummary(selectedRequestResult)
                          }}
                        >
                          <span>
                            {selectedRequestInfo.purpose === 'compaction'
                              ? t('details.compacted')
                              : t('details.assistantMessage')}
                          </span>
                          <IconChevronRightOutline14
                            className={css.overviewHierarchyJumpIconTight}
                            size={11}
                          />
                        </button>
                      </dd>
                    </div>
                  )}
                </dl>
                <div className={css.overviewSections}>
                  {selectedRequestOptions !== undefined && (
                    <OverviewSection label={t('tab.options')} onOpen={() => { activateTab('options') }}>
                      <RequestOptions options={selectedRequestOptions} preview t={t} />
                    </OverviewSection>
                  )}
                  <OverviewSection label={t('tab.usage')} onOpen={() => { activateTab('usage') }}>
                    <UsageRows usage={selectedRequestUsage} t={t} />
                  </OverviewSection>
                  <OverviewSection label={t('tab.timing')} onOpen={() => { activateTab('timing') }}>
                    <RequestTiming
                      assistant={selectedRequestAssistant}
                      anchor={selectedRequestAnchor}
                      request={selectedRequestInfo}
                      t={t}
                    />
                  </OverviewSection>
                </div>
              </>
            )}
            {selectedRequestInfo !== undefined && activeTab === 'options' && (
              <RequestOptions options={selectedRequestOptions} t={t} />
            )}
            {selectedRequestInfo !== undefined && activeTab === 'usage' && (
              <RequestUsagePanel
                usage={selectedRequestUsage}
                cumulative={selectedRequestCumulativeUsage}
                t={t}
              />
            )}
            {selectedRequestInfo !== undefined && activeTab === 'timing' && (
              <RequestTiming
                assistant={selectedRequestAssistant}
                anchor={selectedRequestAnchor}
                request={selectedRequestInfo}
                t={t}
              />
            )}
            {promptSelected
              && selectedPreviousPrompt !== undefined
              && activeTab === 'diff' && (
              <SystemPromptDiff
                before={selectedPreviousPrompt}
                after={selectedPrompt}
                t={t}
              />
            )}
            {promptSelected && activeTab === 'system-prompt' && (
              selectedPrompt.system === ''
                ? <p className={css.noPayload}>{t('record.systemPromptMissing')}</p>
                : (
                  <div className={`${css.markdownPayload} ${css.systemPrompt}`}>
                    <MarkdownText text={selectedPrompt.system} labels={markdownLabels(t)} />
                  </div>
                )
            )}
            {promptSelected && activeTab === 'tools' && (
              <ToolCatalog tools={selectedPrompt.tools} t={t} />
            )}
            {!promptSelected
              && selected?.cell.kind === 'compacted'
              && selectedState !== undefined
              && activeTab === 'overview' && (
              <>
                <dl
                  className={`${css.overview} ${css.summaryScrollRegion}`}
                  data-summary-scroll-region=""
                >
                  <div>
                    <dt>{t('details.status')}</dt>
                    <dd className={selectedState === 'error' ? css.error : undefined}>
                      {statusLabel(selectedState, t)}
                    </dd>
                  </div>
                  <div>
                    <dt>{t('timing.duration')}</dt>
                    <dd>{formatElapsedSeconds(selected.cell.timeSeconds, t)}</dd>
                  </div>
                  <div>
                    <dt>{t('usage.tokens')}</dt>
                    <dd>—</dd>
                  </div>
                </dl>
                {selected.cell.outputDetail !== undefined && (
                  <div
                    className={`${css.compactedSummary} ${css.summaryScrollRegion}`}
                    data-summary-scroll-region=""
                  >
                    <MarkdownRecordContent
                      record={selected}
                      renderImages={renderImages}
                      rendered
                      thinkingExpanded={thinkingExpanded}
                      onThinkingExpandedChange={setThinkingExpanded}
                      onOpenCall={openCallSummary}
                      t={t}
                    />
                  </div>
                )}
              </>
            )}
            {!promptSelected
              && selected !== undefined
              && selected.cell.kind !== 'compacted'
              && selectedState !== undefined
              && activeTab === 'overview' && (
              <>
                <dl
                  className={`${css.overview} ${css.summaryScrollRegion}`}
                  data-summary-scroll-region=""
                >
                  {selected.cell.messageSource !== undefined && (
                    <div>
                      <dt>{t('details.source')}</dt>
                      <dd className={css.overviewParentLinks}>
                        <button
                          type="button"
                          className={css.overviewHierarchyNavLink}
                          onClick={() => { activateTab('source') }}
                        >
                          <span>{messageSourceLabel(selected.cell.messageSource, t)}</span>
                          <IconChevronRightOutline14
                            className={css.overviewHierarchyJumpIconTight}
                            size={11}
                          />
                        </button>
                      </dd>
                    </div>
                  )}
                  {hasSelectedHierarchy && (
                    <div>
                      <dt>
                        {selectedAssistantRequestTarget !== undefined
                          ? t('details.source')
                          : t('details.hierarchy')}
                      </dt>
                      <dd className={css.overviewParentLinks}>
                        {selectedAssistantRequestTarget !== undefined && (
                          <button
                            type="button"
                            className={css.overviewHierarchyNavLink}
                            onClick={() => {
                              selectRequest(selectedAssistantRequestTarget)
                            }}
                          >
                            <span>{t('request.label', { request: selectedAssistantRequest ?? '—' })}</span>
                            <IconChevronRightOutline14
                              className={css.overviewHierarchyJumpIconTight}
                              size={11}
                            />
                          </button>
                        )}
                        {selectedParentMessage !== undefined && (
                          <button
                            type="button"
                            className={css.overviewHierarchyNavLink}
                            onClick={() => { openRecordSummary(selectedParentMessage) }}
                          >
                            <span>{t('details.assistantMessage')}</span>
                            <IconChevronRightOutline14
                              className={css.overviewHierarchyJumpIconTight}
                              size={11}
                            />
                          </button>
                        )}
                        {selectedParentTool !== undefined && (
                          <button
                            type="button"
                            className={css.overviewHierarchyNavLink}
                            onClick={() => { openRecordSummary(selectedParentTool) }}
                          >
                            <span>{t('details.toolCall')}</span>
                            <IconChevronRightOutline14
                              className={css.overviewHierarchyJumpIconTight}
                              size={11}
                            />
                          </button>
                        )}
                      </dd>
                    </div>
                  )}
                  <div>
                    <dt>{t('details.status')}</dt>
                    <dd className={selectedState === 'error' ? css.error : undefined}>
                      {statusLabel(selectedState, t)}
                    </dd>
                  </div>
                  {selected.cell.kind === 'message' && (
                    <TokenRows cell={selected.cell} t={t} />
                  )}
                  {(selected.cell.kind === 'user' || selected.cell.kind === 'context') && (
                    <div>
                      <dt>{t('timing.duration')}</dt>
                      <dd>{formatElapsedSeconds(selected.cell.timeSeconds, t)}</dd>
                    </div>
                  )}
                </dl>
                <div className={css.overviewSections}>
                  {isMarkdownRecord(selected)
                    ? (
                      <>
                        <OverviewSection label={t('tab.preview')} onOpen={() => { activateTab('rendered') }}>
                          <MarkdownRecordContent
                            record={selected}
                            renderImages={renderImages}
                            rendered
                            preview
                            thinkingExpanded={thinkingExpanded}
                            onThinkingExpandedChange={setThinkingExpanded}
                            onOpenCall={openCallSummary}
                            t={t}
                          />
                        </OverviewSection>
                      </>
                    )
                    : (
                      <>
                        {selected.cell.inputDetail && (
                          <OverviewSection label={t('tab.payload')} onOpen={() => { activateTab('input') }}>
                            <RecordPayload record={selected} direction="input" preview renderImages={renderImages} t={t} />
                          </OverviewSection>
                        )}
                        {selected.cell.outputDetail && (
                          <OverviewSection label={t('tab.result')} onOpen={() => { activateTab('output') }}>
                            <RecordPayload record={selected} direction="output" preview renderImages={renderImages} t={t} />
                          </OverviewSection>
                        )}
                        <OverviewSection label={t('tab.schema')} onOpen={() => { activateTab('schema') }}>
                          <RecordSchema record={selected} preview t={t} />
                        </OverviewSection>
                      </>
                    )}
                  {selectedAssistantRequestTarget !== undefined && (
                    <OverviewSection
                      label={t('timing.request')}
                      onOpen={() => {
                        selectRequest(selectedAssistantRequestTarget, 'timing')
                      }}
                    >
                      <RecordTiming record={selected} t={t} />
                    </OverviewSection>
                  )}
                  {(selected.cell.kind === 'tool' || selected.cell.kind === 'subtool') && (
                    <OverviewSection label={t('tab.timing')} onOpen={() => { activateTab('timing') }}>
                      <RecordTiming record={selected} t={t} />
                    </OverviewSection>
                  )}
                </div>
              </>
            )}
            {!promptSelected && selected !== undefined && activeTab === 'rendered' && (
              <MarkdownRecordContent
                record={selected}
                renderImages={renderImages}
                rendered
                thinkingExpanded={thinkingExpanded}
                onThinkingExpandedChange={setThinkingExpanded}
                onOpenCall={openCallSummary}
                t={t}
              />
            )}
            {!promptSelected && selected !== undefined && activeTab === 'raw' && (
              <MarkdownRecordContent
                record={selected}
                renderImages={renderImages}
                rendered={false}
                thinkingExpanded={thinkingExpanded}
                onThinkingExpandedChange={setThinkingExpanded}
                onOpenCall={openCallSummary}
                t={t}
              />
            )}
            {!promptSelected && selected !== undefined && activeTab === 'source' && (
              <MessageSource record={selected} t={t} />
            )}
            {!promptSelected && selected !== undefined && activeTab === 'input' && (
              <RecordPayload record={selected} direction="input" renderImages={renderImages} t={t} />
            )}
            {!promptSelected && selected !== undefined && activeTab === 'output' && (
              <RecordPayload record={selected} direction="output" renderImages={renderImages} t={t} />
            )}
            {!promptSelected && selected !== undefined && activeTab === 'schema' && (
              <RecordSchema record={selected} t={t} />
            )}
            {!promptSelected && selected !== undefined && activeTab === 'timing' && (
              <RecordTiming record={selected} t={t} />
            )}
          </div>
        </aside>
      )}
    </div>
  )
}
