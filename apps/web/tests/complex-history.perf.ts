// Opt-in browser benchmark for high-cardinality workspace and history
// rendering. It reports measurements without timing assertions because host
// speed is not a correctness contract; structural assertions keep the number
// of workspaces and history entries from silently shrinking.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import type { Browser, CDPSession, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  ToolCallId,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  expandAssistantStream,
} from '@deepseek-ai/dsh-llm'
import type { ReplayEntry, ReplayOverrideDoc } from '@deepseek-ai/dsh-llm-replay'
import type { SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import {
  SESSION_FORMAT_VERSION,
  Session,
  SessionId,
} from '@deepseek-ai/dsh-session'
// Carries the session/title event declaration into the fixture builder.
import type {} from '@deepseek-ai/dsh-session-title'
import {
  launchWebScaffold,
  seedSession,
  watchConsole,
  webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage } from './support.ts'

const SIDEBAR_SESSION_COUNT = 1_000
const LONG_SESSION_ID = 'perf-long-history'
const LONG_SESSION_TITLE = 'LONG_PERF_SENTINEL 500-turn session'
const LONG_HISTORY_TURNS = 500
const TOOL_TURN_INTERVAL = 10
const TOOLS_PER_TOOL_TURN = 10
const EXPECTED_TOOL_CALLS = LONG_HISTORY_TURNS / TOOL_TURN_INTERVAL * TOOLS_PER_TOOL_TURN
const EXPECTED_TRAJECTORY_ROWS = 2_100
const DEFAULT_HISTORY_TURNS = 24
const PERF_REPLAY_CONTEXT_WINDOW = 10_000_000
const STREAM_PACE_MS = 8
const STREAM_DELTA_COUNT = 120
const COMPARISON_TURNS = 8
const COMPARISON_DELTA_COUNT = 24
const COMPARISON_TOOL_INTERVAL = 3
const SOAK_TURNS = 100
const POST_SOAK_RENDER_TURN = SOAK_TURNS + 1
const SOAK_DELTA_COUNT = 8
const SOAK_TOOL_INTERVAL = 10
const SOAK_CHECKPOINT_INTERVAL = 10
const LONG_CONTINUATION_USER_PREFIX = 'LONG_CONTINUATION_USER'
const LONG_CONTINUATION_FIRST_PREFIX = 'LONG_CONTINUATION_FIRST'
const LONG_CONTINUATION_DONE_PREFIX = 'LONG_CONTINUATION_DONE'
const SOAK_USER_PREFIX = 'SOAK_CONVERSATION_USER'
const SOAK_FIRST_PREFIX = 'SOAK_CONVERSATION_FIRST'
const SOAK_DONE_PREFIX = 'SOAK_CONVERSATION_DONE'
const LIVE_PROMPT_MARKER = 'STREAM_PERF_USER_INPUT'
const STREAM_FIRST_MARKER = 'STREAM_PERF_FIRST'
const STREAM_DONE_MARKER = 'STREAM_PERF_DONE'
const LIVE_PROMPT = [
  LIVE_PROMPT_MARKER,
  'Analyze the following mixed-language project context and return a concise diagnostic.',
  ...Array.from(
    { length: 48 },
    (_, index) =>
      `Context ${String(index + 1).padStart(2, '0')}: 用户正在检查长会话中的增量渲染性能。`
      + ` Preserve item ${String(index)} and compare ${'payload'.repeat(8)}.`,
  ),
  '```ts',
  ...Array.from(
    { length: 40 },
    (_, index) => `const sample_${String(index)} = ${JSON.stringify(`value-${String(index)}-${'x'.repeat(32)}`)}`,
  ),
  '```',
].join('\n')
const STREAM_DELTAS = Array.from({ length: STREAM_DELTA_COUNT }, (_, index) => {
  if (index === 0) return `${STREAM_FIRST_MARKER} `
  if (index === STREAM_DELTA_COUNT - 1) return `${STREAM_DONE_MARKER}.`
  return `chunk-${String(index).padStart(3, '0')} ${'response'.repeat(3)} `
})

interface ChromiumMetrics {
  readonly [name: string]: number
}

interface Measurement {
  readonly wallMs: number
  readonly taskMs: number
  readonly scriptMs: number
  readonly layoutMs: number
  readonly recalcStyleMs: number
  readonly devtoolsMs: number
  readonly nodesDelta: number
  readonly listenersDelta: number
  readonly heapDeltaMb: number
  readonly totalNodes: number
  readonly heapMb: number
}

interface MutationProbeResult {
  readonly batches: number
  readonly records: number
}

interface UserRenderProbeResult {
  readonly trustedClick: boolean
  readonly sendToDomMs: number
  readonly sendToPaintMs: number
  readonly domToPaintMs: number
  readonly mutationBatches: number
  readonly mutationRecords: number
}

interface RetainedBrowserState {
  readonly domElements: number
  readonly nodes: number
  readonly listeners: number
  readonly heapMb: number
}

interface ContinuedTurnReport {
  readonly ordinal: number
  readonly resultingTurns: number
  readonly kind: 'text' | 'tool'
  readonly promptChars: number
  readonly composerFill: Measurement
  readonly stream: MutationProbeResult & Measurement & {
    readonly paceMs: number
    readonly deltaChunks: number
    readonly persistedChunks: number
    readonly toolCalls: number
    readonly toolResults: number
    readonly clickToUserEchoMs: number
    readonly clickToFirstChunkMs: number
    readonly firstChunkToSettledMs: number
  }
}

interface ConversationTurnSpec {
  readonly prompt: string
  readonly deltas: readonly string[]
  readonly userMarker: string
  readonly firstMarker: string
  readonly doneMarker: string
  readonly toolResultMarker?: string
}

interface RetainedCheckpoint {
  readonly turns: number
  readonly state: RetainedBrowserState
}

interface ConversationReport {
  readonly startingTurns: number
  readonly turnsAdded: number
  readonly toolTurns: number
  readonly retainedBefore: RetainedBrowserState
  readonly retainedAfter: RetainedBrowserState
  readonly retainedDelta: RetainedBrowserState
  readonly checkpoints: readonly RetainedCheckpoint[]
  readonly turns: readonly ContinuedTurnReport[]
}

interface PerformanceWorld {
  readonly scaffold: WebScaffold
  readonly page: Page
  readonly tripwire: ReturnType<typeof watchConsole>
  readonly sessionEvents: SessionEvent[]
  readonly setupMs: number
  readonly replayDir?: string
}

interface PerformanceWorldOptions {
  readonly browser: Browser
  readonly replay?: ReplayOverrideDoc
  readonly sidebarSessions?: number
  readonly seedLongHistory?: boolean
}

function text(value: string): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: value }]
}

function appendTitle(session: Session, title: string, messageSeq: SessionSeq): void {
  session.append('session/title', {
    title,
    messageSeqs: [messageSeq],
    source: { kind: 'fallback' },
  })
}

function appendRequestHeader(session: Session, turn: number, step: number): void {
  session.append('request/header', {
    header: {
      config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      system: `Synthetic performance system prompt for turn ${String(turn)}, step ${String(step)}.`,
    },
    reason: turn === 1 && step === 1 ? 'initial' : 'change',
  })
}

function appendAssistant(
  session: Session,
  turn: number,
  step: number,
  body: string,
): void {
  session.append('assistant/message', {
    stream: [],
    turn,
    step,
    message: createAssistantMessage({
      content: text(body),
      source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    }),
    usage: {
      inputTokens: 4_000 + turn * 10,
      outputTokens: 200 + step * 20,
      cacheReadTokens: turn % 2 === 0 ? 2_000 : 0,
    },
  }, { surfaceOp: 'append' })
}

function appendToolStep(
  session: Session,
  turn: number,
  step: number,
  toolCount: number,
): void {
  const calls = Array.from({ length: toolCount }, (_, index) => {
    const callId = ToolCallId(`perf-call-${String(turn)}-${String(index)}`)
    const args = JSON.stringify({
      turn,
      index,
      payload: 'x'.repeat(120),
    })
    return { callId, index, args }
  })

  session.append('assistant/message', {
    stream: [],
    turn,
    step,
    message: createAssistantMessage({
      content: [
        {
          type: 'reasoning',
          text: `Dispatching ${String(toolCount)} synthetic tools for turn ${String(turn)}.`,
        },
        ...calls.map(({ callId, args }) => ({
          type: 'tool-call' as const,
          id: callId,
          name: 'synthetic_tool',
          arguments: args,
        })),
      ],
      source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    }),
    usage: {
      inputTokens: 6_000 + turn * 10,
      outputTokens: 500,
      cacheReadTokens: 3_000,
      reasoningTokens: 50,
    },
  }, { surfaceOp: 'append' })

  const callEvents = calls.map(({ callId, args }) =>
    session.append('tool/call', {
      turn,
      step,
      callId,
      name: 'synthetic_tool',
      arguments: args,
    }))

  for (const [index, call] of calls.entries()) {
    const source = callEvents[index]
    if (source === undefined) throw new Error(`missing synthetic tool call ${String(index)}`)
    session.append('tool/result', {
      turn,
      step,
      message: createToolResultMessage({
        callId: call.callId,
        content: text(
          `synthetic result turn=${String(turn)} index=${String(call.index)} ${'r'.repeat(400)}`,
        ),
        isError: false,
      }),
    }, { surfaceOp: 'append', sourceEventSeqs: [source.seq] })
  }
}

function fencedCode(turn: number): string {
  if (turn % 25 !== 0) return ''
  const lines = Array.from(
    { length: 80 },
    (_, index) => `const value_${String(index)} = ${String(turn + index)}`,
  )
  return `\n\n\`\`\`ts\n${lines.join('\n')}\n\`\`\``
}

function fixtureLog(session: Session): string {
  const header = {
    type: 'session',
    version: SESSION_FORMAT_VERSION,
    id: '{{sessionId}}',
    createdAt: Date.now() - 60_000,
    cwd: '{{cwd}}',
    isSeeded: false,
    delegationDepth: 0,
  }
  return [
    JSON.stringify(header),
    ...session.snapshotEvents().map(event => JSON.stringify(event)),
    '',
  ].join('\n')
}

function smallSidebarFixture(): string {
  const session = Session.create(SessionId('perf-small-template'))
  session.append('turn/start', {
    turn: 1,
  })
  const user = session.append('user/message', createUserMessage({
    content: text('Inspect this compact synthetic session.'),
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  appendTitle(session, 'Synthetic sidebar session', user.seq)
  session.append('step/start', { turn: 1, step: 1 })
  appendRequestHeader(session, 1, 1)
  appendToolStep(session, 1, 1, 2)
  session.append('step/end', { turn: 1, step: 1 })
  session.append('step/start', { turn: 1, step: 2 })
  appendRequestHeader(session, 1, 2)
  appendAssistant(session, 1, 2, 'Synthetic sidebar fixture complete.')
  session.append('step/end', { turn: 1, step: 2 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return fixtureLog(session)
}

function longHistoryFixture(): string {
  const session = Session.create(SessionId(LONG_SESSION_ID))
  for (let turn = 1; turn <= LONG_HISTORY_TURNS; turn += 1) {
    session.append('turn/start', {
      turn,
    })
    const user = session.append('user/message', createUserMessage({
      content: text(
        `LONG_PERF_SENTINEL turn ${String(turn)}: analyze payload ${'u'.repeat(200)}`,
      ),
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    if (turn === 1) appendTitle(session, LONG_SESSION_TITLE, user.seq)

    session.append('step/start', { turn, step: 1 })
    appendRequestHeader(session, turn, 1)
    if (turn % TOOL_TURN_INTERVAL === 0) {
      appendToolStep(session, turn, 1, TOOLS_PER_TOOL_TURN)
      session.append('step/end', { turn, step: 1 })
      session.append('step/start', { turn, step: 2 })
      appendRequestHeader(session, turn, 2)
      appendAssistant(
        session,
        turn,
        2,
        `All synthetic tools completed for turn ${String(turn)}. ${'z'.repeat(320)}${fencedCode(turn)}`,
      )
      session.append('step/end', { turn, step: 2 })
    } else {
      appendAssistant(
        session,
        turn,
        1,
        `Synthetic assistant response for turn ${String(turn)}. ${'a'.repeat(320)}${fencedCode(turn)}`,
      )
      session.append('step/end', { turn, step: 1 })
    }
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  return fixtureLog(session)
}

function textStream(deltas: readonly string[], inputTokens: number): StreamChunk[] {
  const response = deltas.join('')
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...deltas.map(text => ({
      type: 'text-delta' as const,
      index: 0,
      text,
    })),
    {
      type: 'block-end',
      index: 0,
      block: { type: 'text', text: response },
    },
    {
      type: 'usage',
      usage: {
        inputTokens,
        outputTokens: Math.ceil(response.length / 4),
      },
    },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function comparisonPrompt(index: number): string {
  if (index === COMPARISON_TURNS) return LIVE_PROMPT
  return (`${LONG_CONTINUATION_USER_PREFIX}_${String(index)} `
    + `继续分析这个长会话的第 ${String(index)} 个增量问题，并保留当前滚动和输入响应。 `
    + 'context '.repeat(80)).trimEnd()
}

function comparisonDeltas(index: number): string[] {
  if (index === COMPARISON_TURNS) return STREAM_DELTAS
  return Array.from({ length: COMPARISON_DELTA_COUNT }, (_, chunkIndex) => {
    if (chunkIndex === 0) return `${LONG_CONTINUATION_FIRST_PREFIX}_${String(index)} `
    if (chunkIndex === COMPARISON_DELTA_COUNT - 1) {
      return `${LONG_CONTINUATION_DONE_PREFIX}_${String(index)}.`
    }
    return `turn-${String(index)}-chunk-${String(chunkIndex).padStart(2, '0')} ${'response'.repeat(2)} `
  })
}

function comparisonTurn(index: number): ConversationTurnSpec {
  const toolResultMarker = index % COMPARISON_TOOL_INTERVAL === 0
    ? `LONG_CONTINUATION_TOOL_RESULT_${String(index)}`
    : undefined
  return {
    prompt: comparisonPrompt(index),
    deltas: comparisonDeltas(index),
    userMarker: index === COMPARISON_TURNS
      ? LIVE_PROMPT_MARKER
      : `${LONG_CONTINUATION_USER_PREFIX}_${String(index)}`,
    firstMarker: index === COMPARISON_TURNS
      ? STREAM_FIRST_MARKER
      : `${LONG_CONTINUATION_FIRST_PREFIX}_${String(index)}`,
    doneMarker: index === COMPARISON_TURNS
      ? STREAM_DONE_MARKER
      : `${LONG_CONTINUATION_DONE_PREFIX}_${String(index)}`,
    ...toolResultMarker === undefined ? {} : { toolResultMarker },
  }
}

function soakTurn(index: number): ConversationTurnSpec {
  const suffix = String(index).padStart(3, '0')
  const toolResultMarker = index % SOAK_TOOL_INTERVAL === 0
    ? `SOAK_CONVERSATION_TOOL_RESULT_${suffix}`
    : undefined
  return {
    prompt: (`${SOAK_USER_PREFIX}_${suffix} `
      + `持续对话第 ${String(index)} 轮，检查增量渲染与保留状态。 `
      + 'context '.repeat(20)).trimEnd(),
    deltas: Array.from({ length: SOAK_DELTA_COUNT }, (_, chunkIndex) => {
      if (chunkIndex === 0) return `${SOAK_FIRST_PREFIX}_${suffix} `
      if (chunkIndex === SOAK_DELTA_COUNT - 1) return `${SOAK_DONE_PREFIX}_${suffix}.`
      return `soak-${suffix}-${String(chunkIndex).padStart(2, '0')} response `
    }),
    userMarker: `${SOAK_USER_PREFIX}_${suffix}`,
    firstMarker: `${SOAK_FIRST_PREFIX}_${suffix}`,
    doneMarker: `${SOAK_DONE_PREFIX}_${suffix}`,
    ...toolResultMarker === undefined ? {} : { toolResultMarker },
  }
}

function toolStream(index: number, marker: string): StreamChunk[] {
  const callId = ToolCallId(`performance-tool-${marker.toLowerCase()}-${String(index)}`)
  const args = JSON.stringify({
    command: `printf '${marker}\\n'`,
    description: `Emit performance marker ${String(index)}`,
  })
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    {
      type: 'tool-call-delta',
      index: 0,
      id: callId,
      name: 'bash',
      argumentsDelta: args,
    },
    {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: callId, name: 'bash', arguments: args },
    },
    { type: 'usage', usage: { inputTokens: 256, outputTokens: 32 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function performanceReplayOverride(
  turnCount: number,
  turnSpec: (index: number) => ConversationTurnSpec,
): ReplayOverrideDoc {
  const continuationEntries = Array.from(
    { length: turnCount },
    (_, offset): ReplayEntry[] => {
      const index = offset + 1
      const spec = turnSpec(index)
      const finalResponse: ReplayEntry = {
        kind: 'chunks',
        chunks: textStream(spec.deltas, Math.ceil(spec.prompt.length / 4)),
      }
      return spec.toolResultMarker === undefined
        ? [finalResponse]
        : [{ kind: 'chunks', chunks: toolStream(index, spec.toolResultMarker) }, finalResponse]
    },
  ).flat()
  return continuationEntries
}

function rounded(value: number): number {
  return Math.round(value * 1_000) / 1_000
}

async function chromiumMetrics(cdp: CDPSession): Promise<ChromiumMetrics> {
  const payload = await cdp.send('Performance.getMetrics')
  return Object.fromEntries(payload.metrics.map(metric => [metric.name, metric.value]))
}

async function retainedBrowserState(
  cdp: CDPSession,
  page: Page,
): Promise<RetainedBrowserState> {
  await cdp.send('HeapProfiler.collectGarbage')
  const metrics = await chromiumMetrics(cdp)
  return {
    domElements: await page.evaluate(() => document.querySelectorAll('*').length),
    nodes: requiredMetric(metrics, 'Nodes'),
    listeners: requiredMetric(metrics, 'JSEventListeners'),
    heapMb: rounded(requiredMetric(metrics, 'JSHeapUsedSize') / 1_048_576),
  }
}

function requiredMetric(metrics: ChromiumMetrics, name: string): number {
  const value = metrics[name]
  if (value === undefined) throw new Error(`Chromium performance metric ${name} is unavailable`)
  return value
}

function metricDelta(
  before: ChromiumMetrics,
  after: ChromiumMetrics,
  wallMs: number,
): Measurement {
  return {
    wallMs: rounded(wallMs),
    taskMs: rounded((requiredMetric(after, 'TaskDuration') - requiredMetric(before, 'TaskDuration')) * 1_000),
    scriptMs: rounded((requiredMetric(after, 'ScriptDuration') - requiredMetric(before, 'ScriptDuration')) * 1_000),
    layoutMs: rounded((requiredMetric(after, 'LayoutDuration') - requiredMetric(before, 'LayoutDuration')) * 1_000),
    recalcStyleMs: rounded(
      (requiredMetric(after, 'RecalcStyleDuration') - requiredMetric(before, 'RecalcStyleDuration')) * 1_000,
    ),
    devtoolsMs: rounded(
      (requiredMetric(after, 'DevToolsCommandDuration') - requiredMetric(before, 'DevToolsCommandDuration')) * 1_000,
    ),
    nodesDelta: requiredMetric(after, 'Nodes') - requiredMetric(before, 'Nodes'),
    listenersDelta: requiredMetric(after, 'JSEventListeners') - requiredMetric(before, 'JSEventListeners'),
    heapDeltaMb: rounded(
      (requiredMetric(after, 'JSHeapUsedSize') - requiredMetric(before, 'JSHeapUsedSize')) / 1_048_576,
    ),
    totalNodes: requiredMetric(after, 'Nodes'),
    heapMb: rounded(requiredMetric(after, 'JSHeapUsedSize') / 1_048_576),
  }
}

async function measure<T>(
  cdp: CDPSession,
  action: () => Promise<T>,
): Promise<{ measurement: Measurement; value: T }> {
  const before = await chromiumMetrics(cdp)
  const started = performance.now()
  const value = await action()
  const wallMs = performance.now() - started
  const after = await chromiumMetrics(cdp)
  return { measurement: metricDelta(before, after, wallMs), value }
}

async function startMutationProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const target = document.querySelector('[class*="centerCol"]')
    if (target === null) throw new Error('stream mutation probe target is unavailable')
    const probe = {
      batches: 0,
      records: 0,
      observer: undefined as MutationObserver | undefined,
    }
    const observer = new MutationObserver((records) => {
      probe.batches += 1
      probe.records += records.length
    })
    probe.observer = observer
    observer.observe(target, {
      attributes: true,
      attributeFilter: ['data-streaming'],
      characterData: true,
      childList: true,
      subtree: true,
    })
    Reflect.set(globalThis, '__dshPerfMutationProbe', probe)
  })
}

async function stopMutationProbe(page: Page): Promise<MutationProbeResult> {
  return page.evaluate(() => {
    const probe = Reflect.get(globalThis, '__dshPerfMutationProbe') as
      | { batches: number; records: number; observer: MutationObserver }
      | undefined
    if (probe === undefined) throw new Error('stream mutation probe was not started')
    probe.observer.disconnect()
    Reflect.deleteProperty(globalThis, '__dshPerfMutationProbe')
    return { batches: probe.batches, records: probe.records }
  })
}

async function startUserRenderProbe(
  page: Page,
  marker: string,
): Promise<void> {
  const send = page.getByRole('button', { name: 'Send message', exact: true })
  await send.waitFor({ timeout: 15_000 })
  await expect.poll(() => send.isEnabled(), { timeout: 15_000 }).toBe(true)
  await page.evaluate((expectedMarker) => {
    const target = document.querySelector('[data-conversation-scroll]')
    if (target === null) throw new Error('user render probe target is unavailable')
    const probe: {
      sendAt?: number
      domAt?: number
      paintAt?: number
      trustedClick?: boolean
      batches: number
      records: number
      observer?: MutationObserver
      pollForMarker?: () => void
    } = { batches: 0, records: 0 }
    const transcriptContainsMarker = (): boolean => {
      // The composer projects the draft into a backdrop and hidden sizing
      // mirror; only a matching text node outside that card proves delivery.
      const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        if (!node.textContent?.includes(expectedMarker)) continue
        const parent = node.parentElement
        if (parent !== null && parent.closest('[data-composer-card]') === null) return true
      }
      return false
    }
    const markDomVisible = (): void => {
      if (
        probe.sendAt === undefined
        || probe.domAt !== undefined
        || !transcriptContainsMarker()
      ) return
      probe.domAt = globalThis.performance.now()
      // The second callback runs only after a render opportunity for the DOM
      // insertion observed before the first callback.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          probe.paintAt = globalThis.performance.now()
          observer.disconnect()
        })
      })
    }
    const pollForMarker = (): void => {
      markDomVisible()
      if (probe.domAt === undefined) requestAnimationFrame(pollForMarker)
    }
    const observer = new MutationObserver((records) => {
      if (probe.sendAt === undefined) return
      probe.batches += 1
      probe.records += records.length
      markDomVisible()
    })
    probe.observer = observer
    probe.pollForMarker = pollForMarker
    observer.observe(target, {
      attributes: true,
      attributeFilter: ['data-streaming'],
      characterData: true,
      childList: true,
      subtree: true,
    })
    Reflect.set(globalThis, '__dshPerfUserRenderProbe', probe)
  }, marker)
  await send.evaluate((button) => {
    button.addEventListener('click', (event) => {
      const probe = Reflect.get(globalThis, '__dshPerfUserRenderProbe') as
        | { sendAt?: number; trustedClick?: boolean; pollForMarker?: () => void }
        | undefined
      if (probe?.pollForMarker === undefined) throw new Error('user render probe was not started')
      probe.trustedClick = event.isTrusted
      probe.sendAt = globalThis.performance.now()
      requestAnimationFrame(probe.pollForMarker)
    }, { capture: true, once: true })
  })
}

async function triggerUserRenderProbe(page: Page): Promise<void> {
  const send = page.getByRole('button', { name: 'Send message', exact: true })
  await send.click()
}

async function stopUserRenderProbe(
  page: Page,
  marker: string,
): Promise<UserRenderProbeResult> {
  try {
    await page.waitForFunction(() => {
      const probe = Reflect.get(globalThis, '__dshPerfUserRenderProbe') as
        | { paintAt?: number }
        | undefined
      return probe?.paintAt !== undefined
    }, undefined, { timeout: 15_000 })
  } catch (error) {
    const diagnostic = await page.evaluate((expectedMarker) => {
      const probe = Reflect.get(globalThis, '__dshPerfUserRenderProbe') as
        | {
          sendAt?: number
          domAt?: number
          paintAt?: number
          trustedClick?: boolean
          batches: number
          records: number
        }
        | undefined
      const target = document.querySelector('[data-conversation-scroll]')
      let markerOutsideComposer = false
      if (target !== null) {
        const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT)
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
          if (!node.textContent?.includes(expectedMarker)) continue
          const parent = node.parentElement
          if (parent !== null && parent.closest('[data-composer-card]') === null) {
            markerOutsideComposer = true
            break
          }
        }
      }
      return {
        probe,
        markerOutsideComposer,
        markerInComposer: document.querySelector('[data-composer-card]')
          ?.textContent?.includes(expectedMarker) ?? false,
      }
    }, marker)
    throw new Error(`user render probe timed out: ${JSON.stringify(diagnostic)}`, { cause: error })
  }
  return page.evaluate(() => {
    const probe = Reflect.get(globalThis, '__dshPerfUserRenderProbe') as
      | {
        sendAt?: number
        domAt?: number
        paintAt?: number
        trustedClick?: boolean
        batches: number
        records: number
      }
      | undefined
    Reflect.deleteProperty(globalThis, '__dshPerfUserRenderProbe')
    if (
      probe?.trustedClick !== true
      || probe.sendAt === undefined
      || probe.domAt === undefined
      || probe.paintAt === undefined
    ) {
      throw new Error('user render probe did not observe a trusted click, DOM insertion, and paint')
    }
    return {
      trustedClick: probe.trustedClick,
      sendToDomMs: probe.domAt - probe.sendAt,
      sendToPaintMs: probe.paintAt - probe.sendAt,
      domToPaintMs: probe.paintAt - probe.domAt,
      mutationBatches: probe.batches,
      mutationRecords: probe.records,
    }
  })
}

async function stableCount(
  locator: Locator,
  accepts: (count: number) => boolean,
  timeoutMs = 60_000,
): Promise<number> {
  const deadline = performance.now() + timeoutMs
  let previous = -1
  let stableReads = 0
  while (performance.now() < deadline) {
    const count = await locator.count()
    stableReads = accepts(count) && count === previous ? stableReads + 1 : 0
    if (stableReads >= 4) return count
    previous = count
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`browser row count did not stabilize; last count ${String(previous)}`)
}

async function conversationTurns(page: Page): Promise<number> {
  // Loaded-window turn count: one mounted turn-tail footer per settled turn in
  // the window (context keys are `${kind.length}:${kind}${id}`). The stats
  // strip cannot serve as this probe: its counts ride the whole-log
  // sessionStats projection and stay fixed across paging by design.
  return stableCount(page.locator('[data-chat-flow-key^="9:turn-tail"]'), count => count > 0)
}

function retainedDelta(
  before: RetainedBrowserState,
  after: RetainedBrowserState,
): RetainedBrowserState {
  return {
    domElements: after.domElements - before.domElements,
    nodes: after.nodes - before.nodes,
    listeners: after.listeners - before.listeners,
    heapMb: rounded(after.heapMb - before.heapMb),
  }
}

async function launchPerformanceWorld(
  options: PerformanceWorldOptions,
): Promise<PerformanceWorld> {
  const setupStarted = performance.now()
  let replayDir: string | undefined
  let scaffold: WebScaffold | undefined
  let page: Page | undefined
  try {
    if (options.replay === undefined) {
      scaffold = await launchWebScaffold()
    } else {
      replayDir = await mkdtemp(join(tmpdir(), 'dsh-web-perf-replay-'))
      const replayOverride = join(replayDir, 'replay.override.json')
      await writeFile(replayOverride, JSON.stringify(options.replay))
      scaffold = await launchWebScaffold({
        // The override-only fixture supplies one positional script for this
        // world's single live session.
        replayFixture: join(replayDir, 'override-only.jsonl'),
        replayOverride,
        paceMs: STREAM_PACE_MS,
        replayContextWindow: PERF_REPLAY_CONTEXT_WINDOW,
      })
    }

    const sessionEvents: SessionEvent[] = []
    scaffold.ctx.on('session/event', (_session, event: SessionEvent) => {
      sessionEvents.push(event)
    })
    if ((options.sidebarSessions ?? 0) > 0) {
      const small = smallSidebarFixture()
      for (let index = 0; index < (options.sidebarSessions ?? 0); index += 1) {
        await seedSession(scaffold, small, `perf-sidebar-${String(index).padStart(4, '0')}`)
      }
    }
    if (options.seedLongHistory === true) {
      await seedSession(scaffold, longHistoryFixture(), LONG_SESSION_ID)
    }
    const setupMs = performance.now() - setupStarted
    page = await newEnglishPage(options.browser)
    return {
      scaffold,
      page,
      tripwire: watchConsole(page),
      sessionEvents,
      setupMs,
      ...replayDir === undefined ? {} : { replayDir },
    }
  } catch (error) {
    const failures: unknown[] = [error]
    if (page !== undefined) {
      try {
        await page.close()
      } catch (cleanupError) {
        failures.push(cleanupError)
      }
    }
    if (scaffold !== undefined) {
      try {
        await scaffold.close()
      } catch (cleanupError) {
        failures.push(cleanupError)
      }
    }
    if (replayDir !== undefined) {
      try {
        await rm(replayDir, { recursive: true, force: true })
      } catch (cleanupError) {
        failures.push(cleanupError)
      }
    }
    if (failures.length === 1) throw error
    throw new AggregateError(failures, 'web performance setup and cleanup failed')
  }
}

async function closePerformanceWorld(world: PerformanceWorld): Promise<void> {
  const failures: unknown[] = []
  await world.page.close().catch((error: unknown) => failures.push(error))
  await world.scaffold.close().catch((error: unknown) => failures.push(error))
  if (world.replayDir !== undefined) {
    await rm(world.replayDir, { recursive: true, force: true })
      .catch((error: unknown) => failures.push(error))
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'web performance teardown failed')
}

async function openPerformancePage(
  world: PerformanceWorld,
  expectedSessions: number,
): Promise<Locator> {
  await world.page.goto(world.scaffold.authenticatedUrl, { waitUntil: 'load' })
  await world.page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  const group = world.page.getByRole('treeitem').first()
  await expect.poll(() => group.textContent(), { timeout: 30_000 })
    .toContain(`${String(expectedSessions)} ${expectedSessions === 1 ? 'session' : 'sessions'}`)
  return group
}

async function openLongHistory(page: Page): Promise<number> {
  await page.getByRole('textbox', { name: 'Search name, keywords...', exact: true })
    .fill('LONG_PERF_SENTINEL')
  const results = page.getByRole('tree', { name: 'Search results' }).getByRole('treeitem')
  await expect.poll(() => results.count(), { timeout: 60_000 }).toBe(1)
  await results.first().click()
  await page.getByRole('tab', { name: 'Chat', exact: true }).waitFor({ timeout: 30_000 })
  return conversationTurns(page)
}

async function continueConversation(
  world: PerformanceWorld,
  cdp: CDPSession,
  options: {
    readonly startingTurns: number
    readonly turnCount: number
    readonly turnSpec: (index: number) => ConversationTurnSpec
    readonly expectedSessionId?: SessionId
    readonly checkpointInterval?: number
  },
): Promise<ConversationReport> {
  const composer = world.page.locator('[data-composer-input][contenteditable="true"]').last()
  await composer.waitFor({ timeout: 15_000 })
  const retainedBefore = await retainedBrowserState(cdp, world.page)
  const checkpoints: RetainedCheckpoint[] = [{ turns: options.startingTurns, state: retainedBefore }]
  const turns: ContinuedTurnReport[] = []
  let liveSessionId = options.expectedSessionId

  for (let index = 1; index <= options.turnCount; index += 1) {
    const spec = options.turnSpec(index)
    const composerFill = await measure(cdp, async () => {
      await composer.fill(spec.prompt)
      await expect.poll(() => composer.textContent()).toBe(spec.prompt)
      return ((await composer.textContent()) ?? '').length
    })
    expect(composerFill.value).toBe(spec.prompt.length)

    const eventStart = world.sessionEvents.length
    await startMutationProbe(world.page)
    const streamBefore = await chromiumMetrics(cdp)
    const streamStarted = performance.now()
    const settled = world.scaffold.whenTurnSettled(60_000)
    await world.page.getByRole('button', { name: 'Send message', exact: true }).click()
    await world.page.getByText(spec.userMarker, { exact: false }).last().waitFor({ timeout: 15_000 })
    const clickToUserEchoMs = performance.now() - streamStarted
    await world.page.getByText(spec.firstMarker, { exact: false }).last().waitFor({ timeout: 15_000 })
    const clickToFirstChunkMs = performance.now() - streamStarted
    const settledSessionId = await settled
    if (liveSessionId === undefined) {
      liveSessionId = settledSessionId
    } else {
      expect(settledSessionId).toBe(liveSessionId)
    }
    await expect.poll(
      () => world.page.locator('[data-streaming="true"]').count(),
      { timeout: 15_000 },
    ).toBe(0)
    await world.page.getByText(spec.doneMarker, { exact: false }).last().waitFor({ timeout: 15_000 })
    const clickToSettledMs = performance.now() - streamStarted
    const streamAfter = await chromiumMetrics(cdp)
    const mutations = await stopMutationProbe(world.page)
    const turnEvents = world.sessionEvents.slice(eventStart)
    const chunks = turnEvents.flatMap(event => (
      event.type === 'assistant/message' || event.type === 'assistant/attempt'
        ? expandAssistantStream(event.data.stream)
        : []
    ))
    const toolCalls = turnEvents.filter(event => event.type === 'tool/call')
    const toolResults = turnEvents.filter(event => event.type === 'tool/result')
    const toolTurn = spec.toolResultMarker !== undefined
    expect(chunks).toHaveLength(spec.deltas.length + (toolTurn ? 9 : 4))
    expect(toolCalls).toHaveLength(toolTurn ? 1 : 0)
    expect(toolResults).toHaveLength(toolTurn ? 1 : 0)
    if (spec.toolResultMarker !== undefined) {
      expect(toolCalls[0]?.data.name).toBe('bash')
      const toolResult = toolResults[0]
      if (toolResult?.type !== 'tool/result') {
        throw new Error(`continued turn ${String(index)} did not log its tool result`)
      }
      const resultBlock = toolResult.data.message.content.find(block => block.type === 'tool-result')
      expect(resultBlock?.isError).toBe(false)
      expect(resultBlock?.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')).toContain(spec.toolResultMarker)
    }
    const user = turnEvents.find(
      event => event.type === 'user/message' && event.data.source.kind === 'user',
    )
    if (user?.type !== 'user/message') {
      throw new Error(`continued turn ${String(index)} did not log its user message`)
    }
    expect(user.data.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')).toBe(spec.prompt)
    const resultingTurns = await conversationTurns(world.page)
    expect(resultingTurns).toBe(options.startingTurns + index)
    turns.push({
      ordinal: index,
      resultingTurns,
      kind: toolTurn ? 'tool' : 'text',
      promptChars: spec.prompt.length,
      composerFill: composerFill.measurement,
      stream: {
        paceMs: STREAM_PACE_MS,
        deltaChunks: spec.deltas.length,
        persistedChunks: chunks.length,
        toolCalls: toolCalls.length,
        toolResults: toolResults.length,
        clickToUserEchoMs: rounded(clickToUserEchoMs),
        clickToFirstChunkMs: rounded(clickToFirstChunkMs),
        firstChunkToSettledMs: rounded(clickToSettledMs - clickToFirstChunkMs),
        ...mutations,
        ...metricDelta(streamBefore, streamAfter, clickToSettledMs),
      },
    })

    if (options.checkpointInterval !== undefined && index % options.checkpointInterval === 0) {
      checkpoints.push({
        turns: options.startingTurns + index,
        state: await retainedBrowserState(cdp, world.page),
      })
    }
  }

  const lastCheckpoint = checkpoints.at(-1)
  const retainedAfter = lastCheckpoint?.turns === options.startingTurns + options.turnCount
    ? lastCheckpoint.state
    : await retainedBrowserState(cdp, world.page)
  if (lastCheckpoint?.turns !== options.startingTurns + options.turnCount) {
    checkpoints.push({ turns: options.startingTurns + options.turnCount, state: retainedAfter })
  }
  return {
    startingTurns: options.startingTurns,
    turnsAdded: options.turnCount,
    toolTurns: turns.filter(turn => turn.kind === 'tool').length,
    retainedBefore,
    retainedAfter,
    retainedDelta: retainedDelta(retainedBefore, retainedAfter),
    checkpoints,
    turns,
  }
}

async function measurePostSoakUserRender(
  world: PerformanceWorld,
  cdp: CDPSession,
): Promise<object> {
  const spec = soakTurn(POST_SOAK_RENDER_TURN)
  if (spec.toolResultMarker !== undefined) {
    throw new Error('post-soak render probe must remain a text-only turn')
  }
  const composer = world.page.locator('[data-composer-input][contenteditable="true"]').last()
  const composerFill = await measure(cdp, async () => {
    await composer.fill(spec.prompt)
    await expect.poll(() => composer.textContent()).toBe(spec.prompt)
    return ((await composer.textContent()) ?? '').length
  })
  expect(composerFill.value).toBe(spec.prompt.length)

  const eventStart = world.sessionEvents.length
  await startUserRenderProbe(world.page, spec.userMarker)
  const browserBefore = await chromiumMetrics(cdp)
  const fullTurnStarted = performance.now()
  const settled = world.scaffold.whenTurnSettled(60_000)
  await triggerUserRenderProbe(world.page)
  const browserTiming = await stopUserRenderProbe(world.page, spec.userMarker)
  const browserAfter = await chromiumMetrics(cdp)
  const browserAfterPaintSample = metricDelta(
    browserBefore,
    browserAfter,
    performance.now() - fullTurnStarted,
  )
  await world.page.getByText(spec.firstMarker, { exact: false }).last().waitFor({ timeout: 15_000 })
  const settledSessionId = await settled
  await expect.poll(
    () => world.page.locator('[data-streaming="true"]').count(),
    { timeout: 15_000 },
  ).toBe(0)
  await world.page.getByText(spec.doneMarker, { exact: false }).last().waitFor({ timeout: 15_000 })
  const fullTurnMs = performance.now() - fullTurnStarted

  const turnEvents = world.sessionEvents.slice(eventStart)
  const chunks = turnEvents.flatMap(event => (
    event.type === 'assistant/message' || event.type === 'assistant/attempt'
      ? expandAssistantStream(event.data.stream)
      : []
  ))
  const user = turnEvents.find(
    event => event.type === 'user/message' && event.data.source.kind === 'user',
  )
  if (user?.type !== 'user/message') throw new Error('post-soak render probe did not log its user message')
  expect(user.data.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')).toBe(spec.prompt)
  expect(chunks).toHaveLength(spec.deltas.length + 4)
  expect(turnEvents.filter(event => event.type === 'tool/call')).toHaveLength(0)
  expect(turnEvents.filter(event => event.type === 'tool/result')).toHaveLength(0)
  expect(world.scaffold.ctx.agents.get(settledSessionId)).toBeDefined()
  expect(await conversationTurns(world.page)).toBe(POST_SOAK_RENDER_TURN)

  return {
    ordinal: POST_SOAK_RENDER_TURN,
    resultingTurns: POST_SOAK_RENDER_TURN,
    promptChars: spec.prompt.length,
    composerFill: composerFill.measurement,
    trustedClick: browserTiming.trustedClick,
    sendToDomMs: rounded(browserTiming.sendToDomMs),
    sendToPaintMs: rounded(browserTiming.sendToPaintMs),
    domToPaintMs: rounded(browserTiming.domToPaintMs),
    mutationBatchesThroughPaint: browserTiming.mutationBatches,
    mutationRecordsThroughPaint: browserTiming.mutationRecords,
    browserAfterPaintSample,
    fullTurnMs: rounded(fullTurnMs),
    persistedChunks: chunks.length,
  }
}

function average(values: readonly number[]): number {
  return rounded(values.reduce((sum, value) => sum + value, 0) / values.length)
}

function p95(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0
}

function summarizeTurnWindows(
  turns: readonly ContinuedTurnReport[],
  windowSize: number,
): object[] {
  const windows: object[] = []
  for (let start = 0; start < turns.length; start += windowSize) {
    const window = turns.slice(start, start + windowSize)
    const streamWall = window.map(turn => turn.stream.wallMs)
    const userEcho = window.map(turn => turn.stream.clickToUserEchoMs)
    const firstChunk = window.map(turn => turn.stream.clickToFirstChunkMs)
    windows.push({
      turns: `${String(start + 1)}-${String(start + window.length)}`,
      toolTurns: window.filter(turn => turn.kind === 'tool').length,
      average: {
        composerFillWallMs: average(window.map(turn => turn.composerFill.wallMs)),
        streamWallMs: average(streamWall),
        clickToUserEchoMs: average(userEcho),
        clickToFirstChunkMs: average(firstChunk),
        taskMs: average(window.map(turn => turn.stream.taskMs)),
        scriptMs: average(window.map(turn => turn.stream.scriptMs)),
        recalcStyleMs: average(window.map(turn => turn.stream.recalcStyleMs)),
        mutationBatches: average(window.map(turn => turn.stream.batches)),
      },
      p95: {
        streamWallMs: rounded(p95(streamWall)),
        clickToUserEchoMs: rounded(p95(userEcho)),
        clickToFirstChunkMs: rounded(p95(firstChunk)),
      },
    })
  }
  return windows
}

describe('manual web performance: complex workspace and history', () => {
  let browser: Browser

  beforeAll(async () => {
    if (webSnapshotMode() === 'record') {
      throw new Error('manual web performance runs only with deterministic replay')
    }
    browser = await chromium.launch()
  })

  afterAll(async () => {
    await browser?.close()
  })

  it('reports workspace, history, and trajectory cardinality costs', async () => {
    const world = await launchPerformanceWorld({
      browser,
      sidebarSessions: SIDEBAR_SESSION_COUNT,
      seedLongHistory: true,
    })
    try {
      const bootStarted = performance.now()
      const group = await openPerformancePage(world, SIDEBAR_SESSION_COUNT + 1)
      const bootReadyMs = performance.now() - bootStarted
      const page = world.page
      const cdp = await page.context().newCDPSession(page)
      await cdp.send('Performance.enable')
      const firstContentfulPaintMs = await page.evaluate(
        () => globalThis.performance.getEntriesByName('first-contentful-paint')[0]?.startTime,
      )

      const sidebar = await measure(cdp, async () => {
        await group.click()
        return stableCount(
          page.getByRole('treeitem'),
          count => count === SIDEBAR_SESSION_COUNT + 2,
        )
      })
      expect(sidebar.value).toBe(SIDEBAR_SESSION_COUNT + 2)
      await group.click()
      await expect.poll(() => page.getByRole('treeitem').count()).toBe(1)

      const contentSearch = await measure(cdp, async () => {
        await page.getByRole('textbox', { name: 'Search name, keywords...', exact: true })
          .fill('LONG_PERF_SENTINEL')
        const results = page.getByRole('tree', { name: 'Search results' }).getByRole('treeitem')
        await expect.poll(() => results.count(), { timeout: 60_000 }).toBe(1)
        await results.first().waitFor({ timeout: 60_000 })
        return results.first()
      })
      const opened = await measure(cdp, async () => {
        await contentSearch.value.click()
        await page.getByRole('tab', { name: 'Trajectory', exact: true }).waitFor({ timeout: 30_000 })
        return conversationTurns(page)
      })
      expect(opened.value).toBe(DEFAULT_HISTORY_TURNS)

      const trajectoryRows = page.getByRole('row')
      const coldTrajectory = await measure(cdp, async () => {
        await page.getByRole('tab', { name: 'Trajectory', exact: true }).click()
        return stableCount(trajectoryRows, count => count === EXPECTED_TRAJECTORY_ROWS)
      })
      expect(coldTrajectory.value).toBe(EXPECTED_TRAJECTORY_ROWS)

      const collapseTurns = await measure(cdp, async () => {
        await page.getByRole('button', { name: 'Collapse turns', exact: true }).click()
        return stableCount(trajectoryRows, count => count > 0 && count < EXPECTED_TRAJECTORY_ROWS)
      })
      expect(collapseTurns.value).toBeLessThan(EXPECTED_TRAJECTORY_ROWS)
      const trajectorySearch = await measure(cdp, async () => {
        await page.getByRole('searchbox', { name: 'Search trajectory', exact: true }).fill('turn 499')
        return stableCount(trajectoryRows, count => count > 0 && count < 20)
      })
      expect(trajectorySearch.value).toBeLessThan(20)

      await page.getByRole('tab', { name: 'Chat', exact: true }).click()
      const historyPages: { turns: number; measurement: Measurement }[] = []
      let turns = await conversationTurns(page)
      while (turns < LONG_HISTORY_TURNS) {
        const previousTurns = turns
        const older = await measure(cdp, async () => {
          await page.getByRole('button', { name: 'Load earlier', exact: true }).click()
          await expect.poll(() => conversationTurns(page), { timeout: 30_000 })
            .toBeGreaterThan(previousTurns)
          return conversationTurns(page)
        })
        turns = older.value
        historyPages.push({ turns, measurement: older.measurement })
      }

      const warmTrajectory = await measure(cdp, async () => {
        await page.getByRole('tab', { name: 'Trajectory', exact: true }).click()
        return stableCount(trajectoryRows, count => count === EXPECTED_TRAJECTORY_ROWS)
      })
      expect(warmTrajectory.value).toBe(EXPECTED_TRAJECTORY_ROWS)
      const warmConversation = await measure(cdp, async () => {
        await page.getByRole('tab', { name: 'Chat', exact: true }).click()
        return conversationTurns(page)
      })
      expect(warmConversation.value).toBe(LONG_HISTORY_TURNS)

      console.info(`WEB_PERF_RESULT ${JSON.stringify({
        scenario: 'workspace-history-trajectory',
        fixture: {
          sidebarSessions: SIDEBAR_SESSION_COUNT,
          totalSessions: SIDEBAR_SESSION_COUNT + 1,
          longHistoryTurns: LONG_HISTORY_TURNS,
          toolCalls: EXPECTED_TOOL_CALLS,
          trajectoryRows: EXPECTED_TRAJECTORY_ROWS,
        },
        setupMs: rounded(world.setupMs),
        boot: {
          readyMs: rounded(bootReadyMs),
          firstContentfulPaintMs: firstContentfulPaintMs === undefined
            ? null
            : rounded(firstContentfulPaintMs),
        },
        sidebarExpand: sidebar.measurement,
        contentSearch: contentSearch.measurement,
        openLongHistory: { initialTurns: opened.value, ...opened.measurement },
        coldTrajectory: { rows: coldTrajectory.value, ...coldTrajectory.measurement },
        collapseTurns: { rows: collapseTurns.value, ...collapseTurns.measurement },
        trajectorySearch: { rows: trajectorySearch.value, ...trajectorySearch.measurement },
        historyPages,
        warmTrajectory: { rows: warmTrajectory.value, ...warmTrajectory.measurement },
        warmConversation: { turns: warmConversation.value, ...warmConversation.measurement },
      }, null, 2)}`)
      expect(world.tripwire.warnings).toEqual([])
      expect(world.tripwire.pageErrors).toEqual([])
    } finally {
      await closePerformanceWorld(world)
    }
  })

  it('reports default 24-turn history plus eight continued turns', async () => {
    const world = await launchPerformanceWorld({
      browser,
      replay: performanceReplayOverride(COMPARISON_TURNS, comparisonTurn),
      seedLongHistory: true,
    })
    try {
      await openPerformancePage(world, 1)
      const cdp = await world.page.context().newCDPSession(world.page)
      await cdp.send('Performance.enable')
      const opened = await measure(cdp, () => openLongHistory(world.page))
      expect(opened.value).toBe(DEFAULT_HISTORY_TURNS)
      const conversation = await continueConversation(world, cdp, {
        startingTurns: DEFAULT_HISTORY_TURNS,
        turnCount: COMPARISON_TURNS,
        turnSpec: comparisonTurn,
        expectedSessionId: SessionId(LONG_SESSION_ID),
      })
      expect(conversation.toolTurns).toBe(2)
      console.info(`WEB_PERF_RESULT ${JSON.stringify({
        scenario: 'default-resume-24-plus-8',
        setupMs: rounded(world.setupMs),
        replayContextWindow: PERF_REPLAY_CONTEXT_WINDOW,
        openLongHistory: { turns: opened.value, ...opened.measurement },
        conversation,
      }, null, 2)}`)
      expect(world.tripwire.warnings).toEqual([])
      expect(world.tripwire.pageErrors).toEqual([])
    } finally {
      await closePerformanceWorld(world)
    }
  })

  it('reports fully expanded 500-turn history plus eight continued turns', async () => {
    const world = await launchPerformanceWorld({
      browser,
      replay: performanceReplayOverride(COMPARISON_TURNS, comparisonTurn),
      seedLongHistory: true,
    })
    try {
      await openPerformancePage(world, 1)
      const cdp = await world.page.context().newCDPSession(world.page)
      await cdp.send('Performance.enable')
      expect(await openLongHistory(world.page)).toBe(DEFAULT_HISTORY_TURNS)
      const historyPages: { turns: number; measurement: Measurement }[] = []
      let turns = DEFAULT_HISTORY_TURNS
      while (turns < LONG_HISTORY_TURNS) {
        const previousTurns = turns
        const older = await measure(cdp, async () => {
          await world.page.getByRole('button', { name: 'Load earlier', exact: true }).click()
          await expect.poll(() => conversationTurns(world.page), { timeout: 30_000 })
            .toBeGreaterThan(previousTurns)
          return conversationTurns(world.page)
        })
        turns = older.value
        historyPages.push({ turns, measurement: older.measurement })
      }
      expect(turns).toBe(LONG_HISTORY_TURNS)
      const conversation = await continueConversation(world, cdp, {
        startingTurns: LONG_HISTORY_TURNS,
        turnCount: COMPARISON_TURNS,
        turnSpec: comparisonTurn,
        expectedSessionId: SessionId(LONG_SESSION_ID),
      })
      expect(conversation.toolTurns).toBe(2)
      console.info(`WEB_PERF_RESULT ${JSON.stringify({
        scenario: 'expanded-history-500-plus-8',
        setupMs: rounded(world.setupMs),
        replayContextWindow: PERF_REPLAY_CONTEXT_WINDOW,
        historyPages,
        conversation,
      }, null, 2)}`)
      expect(world.tripwire.warnings).toEqual([])
      expect(world.tripwire.pageErrors).toEqual([])
    } finally {
      await closePerformanceWorld(world)
    }
  })

  it('reports one hundred generated turns and the next user-message paint', async () => {
    const world = await launchPerformanceWorld({
      browser,
      replay: performanceReplayOverride(POST_SOAK_RENDER_TURN, soakTurn),
    })
    let testFailure: unknown
    try {
      await world.page.goto(world.scaffold.authenticatedUrl, { waitUntil: 'load' })
      await world.page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      await connectFreshWorkspace(world.page, world.scaffold.workspaceCwd, 'continuous-conversation-perf')
      const cdp = await world.page.context().newCDPSession(world.page)
      await cdp.send('Performance.enable')
      const conversation = await continueConversation(world, cdp, {
        startingTurns: 0,
        turnCount: SOAK_TURNS,
        turnSpec: soakTurn,
        checkpointInterval: SOAK_CHECKPOINT_INTERVAL,
      })
      expect(conversation.toolTurns).toBe(SOAK_TURNS / SOAK_TOOL_INTERVAL)
      const postSoakUserRender = await measurePostSoakUserRender(world, cdp)
      const { turns, ...retained } = conversation
      console.info(`WEB_PERF_RESULT ${JSON.stringify({
        scenario: 'continuous-100-turn-soak',
        setupMs: rounded(world.setupMs),
        replayContextWindow: PERF_REPLAY_CONTEXT_WINDOW,
        ...retained,
        windows: summarizeTurnWindows(turns, SOAK_CHECKPOINT_INTERVAL),
        postSoakUserRender,
      }, null, 2)}`)
      expect(world.tripwire.warnings).toEqual([])
      expect(world.tripwire.pageErrors).toEqual([])
    } catch (error) {
      testFailure = error
      throw error
    } finally {
      try {
        await closePerformanceWorld(world)
      } catch (cleanupError) {
        if (testFailure === undefined) throw cleanupError
        throw new AggregateError(
          [testFailure, cleanupError],
          'continuous conversation performance test and teardown failed',
        )
      }
    }
  })
})
