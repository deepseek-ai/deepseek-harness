import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { AttachmentId, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { LlmAttemptId } from '@deepseek-ai/dsh-llm/brand'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type {
  AssistantLiveChunkEvent, SessionEventLike, SessionEventLikeEntry,
  SessionLiveEventEntry, SessionTransientEventEntry,
} from '@deepseek-ai/dsh-api-session-controller/client'
import { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session/types'
import { ConversationNodeAssembler } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {
  ConversationContextReader, ConversationLocation, ConversationMatch,
  ConversationNodeContext, ConversationNodeDefinition, ConversationStartMatch,
  ConversationViewDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import { de, en, es, fr, ja, NS, pt, ru, zh } from '../src/client/locales.ts'
import type {
  StatsCall, StatsContribution, StatsSnapshot, StatsStepMetrics, StatsStepState, StatsViewNode,
} from '../src/client/stats-contract.ts'
import { TARGET } from '../src/client/stats-definition.ts'
import { eventMetrics } from '../src/client/stats-event.ts'
import { StatsView } from '../src/client/StatsView.tsx'
import {
  EMPTY_STATS_SNAPSHOT, statsViewDefinition, registerStatsConversationView,
} from '../src/client/stats-snapshot-builder.ts'
import { apply as clientApply, inject as clientInject } from '../src/client/index.ts'
import type { StatsViewInjected } from '../src/client/StatsView.tsx'
import { apply as hostApply } from '../src/index.ts'

const SID = 'stats-session' as SessionId

/** One durable image the prompt fixtures attach. */
const IMAGE: ImageAttachmentRef = {
  attachmentId: AttachmentId('sha256:image'),
  mediaType: 'image/png',
  bytes: 12,
  width: 2,
  height: 2,
}

let seq = 0

/**
 * One durable session event with a deterministic sequence and time. Payloads
 * are fixtures, so this is where the test stops type-checking them.
 */
function event(type: string, data: unknown, time?: number): SessionEvent {
  seq += 1
  return { type, seq: SessionSeq(seq), time: time ?? 1_000 + seq, data } as SessionEvent
}

/** One event with an explicit surface operation. */
function surfaceEvent(type: string, data: unknown, surfaceOp: string, time?: number): SessionEvent {
  return { ...event(type, data, time), surfaceOp } as SessionEvent
}

/** One durable window entry. */
function entry(event: SessionEvent): SessionLiveEventEntry {
  return { type: 'event', event }
}

/** One client-only live chunk entry. */
function transient(turn: number, step: number, chunk: StreamChunk, time?: number): SessionTransientEventEntry {
  seq += 1
  const chunkEvent: AssistantLiveChunkEvent = {
    type: 'assistant/live-chunk',
    seq,
    time: time ?? 1_000 + seq,
    data: { attemptId: LlmAttemptId('attempt-1'), turn, step, chunk },
  }
  return { type: 'transient', event: chunkEvent }
}

/** The text delta one live chunk reports. */
const delta: StreamChunk = { type: 'text-delta', index: 0, text: 'x' }

/** Usage reported by one assistant message. */
const usage = { inputTokens: 100, outputTokens: 40, cacheReadTokens: 400, cacheWriteTokens: 100 }

/** A compact assistant stream whose first token arrives `at` milliseconds. */
function stream(at: number): readonly { readonly type: 'chunk'; readonly time: number; readonly chunk: StreamChunk }[] {
  return [
    { type: 'chunk', time: at - 100, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
    { type: 'chunk', time: at, chunk: delta },
  ]
}

/** A definition registry over the Definitions captured from registration. */
class TestEventDefinitions {
  constructor(readonly definitions: readonly ConversationNodeDefinition[]) {}

  entries(): readonly ConversationNodeDefinition[] {
    return this.definitions
  }

  fallbackEntry(): ConversationNodeDefinition | undefined {
    return undefined
  }
}

/** A view registry over the builders captured from registration. */
class TestViewDefinitions {
  constructor(readonly definitions: readonly ConversationViewDefinition[]) {}

  entries(): readonly ConversationViewDefinition[] {
    return this.definitions
  }
}

/** Assembler that activates every registered target, like the Conversation store. */
class StatsAssembler extends ConversationNodeAssembler {
  constructor(events: TestEventDefinitions, views: TestViewDefinitions) {
    super(events, views)
    for (const view of views.entries()) this.activateTarget(view.target)
  }
}

/** Recorded browser-plugin surface: locale, Definitions, views, and the injected source. */
interface PluginBench {
  readonly ctx: Context
  readonly fiber: { dispose(): Promise<void> }
  readonly localeDispose: ReturnType<typeof vi.fn>
  readonly events: readonly ConversationNodeDefinition[]
  readonly views: readonly ConversationViewDefinition[]
  readonly localeRegister: ReturnType<typeof vi.fn>
  readonly binding: ReturnType<typeof vi.fn>
  readonly loadOlder: ReturnType<typeof vi.fn>
  readonly imageUrl: ReturnType<typeof vi.fn>
  readonly setOpenState: (state: 'cold' | 'open' | 'error') => void
  readonly settleOnNextSubscribe: () => void
  readonly setHasMore: (value: boolean) => void
  readonly setLoadingOlder: (value: boolean) => void
  readonly entries: () => readonly StoredEntry[]
  readonly setSnapshot: (next: StatsSnapshot | undefined) => void
  readonly notify: () => void
}

/** Mount the browser plugin on a real Cordis context with stub services. */
async function mountPlugin(): Promise<PluginBench> {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const events: ConversationNodeDefinition[] = []
  const views: ConversationViewDefinition[] = []
  let snapshot: StatsSnapshot | undefined
  let listener: (() => void) | undefined
  const localeDispose = vi.fn()
  const localeRegister = vi.fn(() => localeDispose)
  const binding = vi.fn(() => ({
    target: () => ({
      getSnapshot: () => snapshot,
      subscribe: (next: () => void) => {
        listener = next
        return () => { listener = undefined }
      },
    }),
  }))
  const loadOlder = vi.fn(async () => undefined)
  const imageUrl = vi.fn(async () => 'blob:image')
  let openState: 'cold' | 'open' | 'error' = 'open'
  let hasMore = false
  let loadingOlder = false
  let openListener: (() => void) | undefined
  let settleOnSubscribe = false
  const sessionBinding = {
    session: {
      loadOlder,
      getSnapshot: () => ({ openState, hasMore, loadingOlder }),
      subscribe: (next: () => void) => {
        openListener = next
        if (settleOnSubscribe) {
          settleOnSubscribe = false
          openState = 'open'
        }
        return () => { openListener = undefined }
      },
    },
  }
  ctx.provide('sessions', { binding: (id: SessionId) => (id === SID ? sessionBinding : undefined) } as never)
  ctx.provide('locale', { register: localeRegister, bind: () => makeTranslate(zh) } as never)
  ctx.provide('uiConversation', {
    binding,
    imageUrl,
    events: {
      register: (definition: ConversationNodeDefinition) => {
        events.push(definition)
        return () => undefined
      },
    },
    views: {
      register: (definition: ConversationViewDefinition) => {
        views.push(definition)
        return () => undefined
      },
    },
  } as never)
  ctx.slots.register({
    name: 'root',
    children: { 'conversation.view': { kind: 'list', scope: 'session' } },
  } as never, () => null)
  const fiber = ctx.plugin({ inject: [...clientInject], apply: clientApply })
  await fiber.await()
  return {
    ctx,
    fiber,
    localeDispose,
    events,
    views,
    localeRegister,
    binding,
    loadOlder,
    imageUrl,
    setOpenState: (state: 'cold' | 'open' | 'error') => {
      openState = state
      openListener?.()
    },
    settleOnNextSubscribe: () => { settleOnSubscribe = true },
    setHasMore: (value: boolean) => { hasMore = value },
    setLoadingOlder: (value: boolean) => { loadingOlder = value },
    entries: () => ctx.slots.entries('conversation.view'),
    setSnapshot: (next) => { snapshot = next },
    notify: () => { listener?.() },
  }
}

/** Run one assembler window and return the published stats snapshot. */
function assemble(
  definitions: readonly ConversationNodeDefinition[],
  entries: readonly SessionEventLikeEntry[],
  options: { readonly upserts?: readonly SessionEventLikeEntry[] } = {},
): StatsSnapshot | undefined {
  const assembler = new StatsAssembler(
    new TestEventDefinitions(definitions),
    new TestViewDefinitions([statsViewDefinition]),
  )
  assembler.replaceWindow(entries, false)
  assembler.flush()
  for (const record of options.upserts ?? []) {
    assembler.append(record)
    assembler.flush()
  }
  return assembler.get(TARGET)
}

/** The Definitions captured by one plugin registration. */
async function registeredDefinitions(): Promise<readonly ConversationNodeDefinition[]> {
  const bench = await mountPlugin()
  const definitions = bench.events
  await bench.fiber.dispose()
  return definitions
}

/** One measured step metrics value. */
function measuredStep(turn: number, step: number, startTime: number, endTime: number): StatsStepMetrics {
  const call: StatsCall = {
    callId: 'call-1',
    seq: 2,
    name: 'read',
    hint: 'b/c.ts',
    chars: 7,
    lines: 2,
    error: false,
    added: null,
    removed: null,
    before: null,
    after: null,
    args: '{"file_path":"/a/b/c.ts"}',
    inner: false,
    text: 'one\ntwo',
    truncated: false,
    ms: 200,
    startedAt: startTime + 50,
    endedAt: endTime - 10,
  }
  return {
    turn,
    step,
    startTime,
    endTime,
    context: 600,
    ttft: 100,
    model: 400,
    decode: 300,
    tps: 40 / 0.3,
    output: 40,
    tool: 200,
    toolWall: 200,
    tools: [{ name: 'read', count: 1 }],
    calls: [call],
    toolOutput: 7,
    retries: 0,
    toolErrors: 0,
    answer: null,
    answerBody: null,
    answerTruncated: false,
    cacheRead: 400,
    cacheWrite: 100,
    cacheHit: 400 / 600,
    wall: endTime - startTime,
    toolPending: 0,
    running: false,
    interrupted: false,
    aborted: false,
  }
}

/** One view node carrying the given contribution. */
function node(key: string, data: StatsContribution): StatsViewNode {
  return {
    key,
    kind: key.split(':')[0] ?? key,
    id: key,
    target: TARGET,
    anchorSeq: 0,
    location: { kind: 'unresolved' },
    data,
  }
}

/** A start-role match for one event. */
function startMatch(event: SessionEventLike): ConversationStartMatch {
  return { event, role: 'start', location: { kind: 'unresolved' } }
}

/** An update-role match for one event. */
function updateMatch(event: SessionEventLike): ConversationMatch {
  return { event, role: 'update', location: { kind: 'unresolved' } }
}

/** The reader a start callback receives; the stats Definitions read no predecessors. */
const reader: ConversationContextReader = { previous: () => undefined }

/** One hand-built Definition context. */
function contextOf(
  definition: ConversationNodeDefinition<StatsStepState>,
  state: StatsStepState | undefined,
  matches: readonly ConversationMatch[] = [],
  start?: ConversationStartMatch,
): ConversationNodeContext<StatsStepState> {
  return {
    key: `${definition.kind}:fixture`,
    kind: definition.kind,
    id: 'fixture',
    matches,
    start,
    state,
    current: new Map(),
  }
}

/** Location data store the hand-built Locations never let a Definition read. */
const LOCATION_DATA = {
  get: () => undefined,
  source: () => ({ getSnapshot: () => undefined, subscribe: () => () => undefined }),
} as never

/** Fabricated Turn Location carrying only the number a Definition reads. */
function turnAt(turn: number): ConversationLocation {
  return {
    kind: 'turn',
    turn: { turn, start: undefined, end: undefined, status: 'open', steps: [], data: LOCATION_DATA },
  }
}

/** Fabricated Step Location carrying only the numbers a Definition reads. */
function stepAt(turn: number, step: number): ConversationLocation {
  return {
    kind: 'step',
    turn: { turn, start: undefined, end: undefined, status: 'open', steps: [], data: LOCATION_DATA },
    step: { turn, step, start: undefined, end: undefined, status: 'unknown', data: LOCATION_DATA },
  }
}

/** A start-role match placed at a fabricated Location. */
function locatedStart(event: SessionEventLike, location: ConversationLocation): ConversationStartMatch {
  return { event, role: 'start', location }
}

/** An update-role match placed at a fabricated Location. */
function locatedUpdate(event: SessionEventLike, location: ConversationLocation): ConversationMatch {
  return { event, role: 'update', location }
}

describe('browser plugin registration', () => {
  it('registers the performance tab, dictionaries, Definitions, and view target', async () => {
    const bench = await mountPlugin()
    expect(bench.localeRegister).toHaveBeenCalledWith(NS, { zh, en, ja, de, es, fr, pt, ru })
    expect(bench.events.map(definition => definition.kind)).toEqual([
      'stats-step', 'stats-prompt', 'stats-turn-end', 'stats-code-mode', 'stats-compaction', 'stats-event',
    ])
    expect(clientInject).toEqual(['slots', 'sessions', 'uiConversation', 'locale'])
    expect(bench.views).toEqual([statsViewDefinition])
    expect(bench.entries()).toHaveLength(1)
    const registered = bench.entries()[0]!
    expect(registered.component).toBe(StatsView)
    expect(registered.options).toMatchObject({ id: 'stats', order: 40 })
    expect(registered.locale).toBe(NS)
    expect(resolveSlotLabel(registered.options.label)).toBe('统计')
    await bench.fiber.dispose()
    expect(bench.entries()).toEqual([])
    // The dictionary registration rides the plugin fiber effect; Definitions and
    // view targets dispose through their own registries in the wiring suites.
    expect(bench.localeDispose).toHaveBeenCalledTimes(1)
  })

  it('settles when the subscription resolves while it is being set up', async () => {
    const bench = await mountPlugin()
    const injectEntry = bench.entries()[0]!.inject as ((sessionId: SessionId) => StatsViewInjected) | undefined
    const injected = injectEntry!(SID)
    bench.setOpenState('cold')
    bench.settleOnNextSubscribe()
    expect(await injected.loadOlder()).toBe('exhausted')
    expect(bench.loadOlder).toHaveBeenCalledTimes(1)
    // A no-progress page with older history left is surfaced, not hidden as exhausted.
    bench.setHasMore(true)
    expect(await injected.loadOlder()).toBe('retry')
    await bench.fiber.dispose()
  })

  it('waits for a cold Session to open before asking for older history', async () => {
    const bench = await mountPlugin()
    const injectEntry = bench.entries()[0]!.inject as ((sessionId: SessionId) => StatsViewInjected) | undefined
    const injected = injectEntry!(SID)
    bench.setOpenState('cold')
    let settled = false
    const page = injected.loadOlder().then((value) => { settled = true; return value })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(bench.loadOlder).not.toHaveBeenCalled()
    // A notification while still cold keeps waiting.
    bench.setOpenState('cold')
    await Promise.resolve()
    expect(settled).toBe(false)
    bench.setOpenState('open')
    await page
    expect(bench.loadOlder).toHaveBeenCalledTimes(1)
    // A failed open also settles instead of leaving the view waiting forever.
    bench.setOpenState('error')
    expect(await injected.loadOlder()).toBe('exhausted')
    await bench.fiber.dispose()
  })

  it('single-flights older pages and keeps a busy or no-progress page retryable', async () => {
    const bench = await mountPlugin()
    const injectEntry = bench.entries()[0]!.inject as ((sessionId: SessionId) => StatsViewInjected) | undefined
    const injected = injectEntry!(SID)
    bench.setHasMore(true)
    bench.loadOlder.mockImplementationOnce(() => undefined)
    const first = injected.loadOlder()
    const second = injected.loadOlder()
    expect(second).toBe(first)
    await Promise.resolve()
    expect(bench.loadOlder).toHaveBeenCalledTimes(1)
    expect(await first).toBe('retry')
    expect(bench.loadOlder).toHaveBeenCalledTimes(1)

    // Chat/Trajectory may own the next page; do not start a second request or
    // claim exhaustion while the Session reports that page in flight.
    bench.setLoadingOlder(true)
    expect(await injected.loadOlder()).toBe('retry')
    expect(bench.loadOlder).toHaveBeenCalledTimes(1)
    bench.setLoadingOlder(false)
    expect(await injected.loadOlder()).toBe('retry')
    expect(bench.loadOlder).toHaveBeenCalledTimes(2)
    await bench.fiber.dispose()
  })

  it('cancels a pending open-window wait without asking for a page', async () => {
    const bench = await mountPlugin()
    const injectEntry = bench.entries()[0]!.inject as ((sessionId: SessionId) => StatsViewInjected) | undefined
    const injected = injectEntry!(SID)
    bench.setOpenState('cold')
    const page = injected.loadOlder()
    injected.cancel()
    expect(await page).toBe('retry')
    expect(bench.loadOlder).not.toHaveBeenCalled()
    await bench.fiber.dispose()
  })

  it('resolves prompt images through the shared Conversation image cache', async () => {
    const bench = await mountPlugin()
    const injectEntry = bench.entries()[0]!.inject as ((sessionId: SessionId) => StatsViewInjected) | undefined
    const injected = injectEntry!(SID)
    await expect(injected.loadImage(IMAGE)).resolves.toBe('blob:image')
    expect(bench.imageUrl).toHaveBeenCalledWith(SID, IMAGE)
    await bench.fiber.dispose()
  })

  it('serves the empty snapshot until the target publishes turns', async () => {
    const bench = await mountPlugin()
    const injectEntry = bench.entries()[0]!.inject as ((sessionId: SessionId) => StatsViewInjected) | undefined
    expect(injectEntry).toBeDefined()
    const injected = injectEntry!(SID)
    expect(bench.binding).toHaveBeenCalledWith(SID)
    expect(injected.hooks.stats.getSnapshot()).toBe(EMPTY_STATS_SNAPSHOT)
    const published: StatsSnapshot = { turns: [], stepCount: 0 }
    bench.setSnapshot(published)
    expect(injected.hooks.stats.getSnapshot()).toBe(published)
    const listener = vi.fn()
    const unsubscribe = injected.hooks.stats.subscribe(listener)
    bench.notify()
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
    // A page that grew the published snapshot reports progress.
    bench.loadOlder.mockImplementationOnce(() => {
      bench.setSnapshot({ turns: [], stepCount: 0 })
      bench.notify()
    })
    expect(await injected.loadOlder()).toBe('grew')
    expect(bench.loadOlder).toHaveBeenCalledTimes(1)
    // A page that leaves the snapshot unchanged and has no history left is exhausted.
    expect(await injected.loadOlder()).toBe('exhausted')
    expect(bench.loadOlder).toHaveBeenCalledTimes(2)
    // A no-progress page with older history left is surfaced, not hidden as exhausted.
    bench.setHasMore(true)
    expect(await injected.loadOlder()).toBe('retry')
    // The source is cached per Session binding; a second injection reuses it.
    expect(injectEntry!(SID).hooks.stats).toBe(injected.hooks.stats)
    expect(() => injectEntry!('stats-missing' as SessionId)).toThrow(/unavailable/)
    await bench.fiber.dispose()
  })
})

describe('host entry', () => {
  it('contributes no host-side behavior', () => {
    expect(() => { hostApply() }).not.toThrow()
  })
})

describe('locale dictionaries', () => {
  it('ships the same key set in both languages', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
    expect(Object.values(en).every(value => value !== '')).toBe(true)
    expect(en['view.stats']).toBe('Statistics')
    expect(en['summary']).toContain('{turns}')
    expect(en['loadOlder']).toBe('Load earlier')
  })
})

describe('snapshot builder', () => {
  it('starts empty and turns step nodes into turn rows', () => {
    const builder = statsViewDefinition.create()
    expect(builder.empty).toBe(EMPTY_STATS_SNAPSHOT)
    const empty = builder.replace({ nodes: [], timeline: { turnOrder: [], turns: new Map() } })
    expect(empty).toEqual({ turns: [], stepCount: 0 })
    const snapshot = builder.replace({
      nodes: [node('stats-step:1:1', { kind: 'step', metrics: measuredStep(1, 1, 1_000, 1_800) })],
      timeline: { turnOrder: [1], turns: new Map() },
    })
    expect(snapshot.turns).toHaveLength(1)
    expect(snapshot.turns[0]?.steps).toHaveLength(1)
    expect(snapshot.stepCount).toBe(1)
  })

  it('keeps the current snapshot for an empty incremental batch', () => {
    const builder = statsViewDefinition.create()
    const first = builder.apply({ upserts: [], timeline: { turnOrder: [], turns: new Map() } })
    expect(first).toBe(EMPTY_STATS_SNAPSHOT)
    expect(builder.apply({ upserts: [], timeline: { turnOrder: [], turns: new Map() } })).toBe(first)
    const upserted = builder.apply({
      upserts: [
        node('stats-prompt:1:0', { kind: 'prompt', turn: 1, prompt: '问', images: [IMAGE], source: 'user', sender: null }),
        node('stats-step:1:1', { kind: 'step', metrics: measuredStep(1, 1, 1_000, 1_800) }),
        node('stats-turn-end:1:100000', { kind: 'end', turn: 1, closeKind: 'completed', endTime: 1_800 }),
      ],
      timeline: { turnOrder: [1], turns: new Map() },
    })
    expect(upserted.turns[0]?.prompt).toBe('问')
    expect(upserted.stepCount).toBe(1)
  })

  it('registers its target through the conversation view registry', () => {
    const register = vi.fn(() => () => undefined)
    const ctx = new Context()
    ctx.provide('uiConversation', { views: { register } } as never)
    registerStatsConversationView(ctx)
    expect(register).toHaveBeenCalledWith(statsViewDefinition)
  })
})

describe('conversation Definitions', () => {
  it('publishes one prompt, one step, and one turn end from a live window', async () => {
    const definitions = await registeredDefinitions()
    const snapshot = assemble(definitions, [
      entry(event('turn/start', { turn: 1 })),
      entry(event('user/message', {
        role: 'user', id: 'u1', content: [{ type: 'text', text: '看看这个' }, { type: 'image', attachment: IMAGE }], source: { kind: 'user' },
      })),
      entry(event('step/start', { turn: 1, step: 1 }, 2_000)),
      transient(1, 1, delta, 2_100),
      entry(event('assistant/message', {
        turn: 1,
        step: 1,
        message: { id: 'm1', role: 'assistant', content: [], source: { provider: 'p', model: 'm' } },
        stream: stream(2_300),
        usage,
      }, 2_400)),
      entry(event('tool/call', {
        turn: 1, step: 1, callId: 'call-1', name: 'read', arguments: '{"file_path":"/a/b/c.ts"}',
      }, 2_500)),
      entry(event('tool/result', {
        turn: 1, step: 1, message: { role: 'tool', content: [{ type: 'text', text: 'one\ntwo' }], source: { callId: 'call-1' } },
      }, 2_700)),
      entry(event('step/end', { turn: 1, step: 1 }, 2_800)),
      entry(event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 2_800)),
    ])
    expect(snapshot?.turns).toHaveLength(1)
    expect(snapshot?.stepCount).toBe(1)
    const turn = snapshot!.turns[0]!
    expect(turn.prompt).toBe('看看这个')
    expect(turn.promptImages).toEqual([IMAGE])
    expect(turn.interrupted).toBe(false)
    expect(turn.steps[0]?.startTime).toBe(2_000)
    expect(turn.steps[0]?.calls).toHaveLength(1)
    expect(turn.steps[0]?.toolOutput).toBe(7)
  })

  it('closes an interrupted tail whose last step never ended', async () => {
    const definitions = await registeredDefinitions()
    const snapshot = assemble(definitions, [
      entry(event('turn/start', { turn: 2 })),
      entry(event('step/start', { turn: 2, step: 1 }, 5_000)),
      transient(2, 1, delta, 5_100),
      entry(event('turn/end', { turn: 2, reason: { kind: 'interrupted' } }, 5_800)),
    ])
    const turn = snapshot!.turns[0]!
    expect(turn.interrupted).toBe(true)
    expect(turn.steps[0]?.endTime).toBe(5_800)
    expect(turn.steps[0]?.wall).toBe(800)
    expect(turn.steps[0]?.aborted).toBe(true)
    expect(turn.steps[0]?.running).toBe(false)
  })

  it('ignores a compaction re-delivery for a turn the window does not hold', async () => {
    const definitions = await registeredDefinitions()
    const snapshot = assemble(definitions, [
      entry(event('turn/start', { turn: 575 }, 8_000)),
      entry(event('step/start', { turn: 575, step: 1 }, 8_100)),
      entry(event('assistant/message', {
        turn: 575,
        step: 1,
        message: { id: 'm', role: 'assistant', content: [], source: { provider: 'p', model: 'm' } },
        stream: stream(8_200),
      }, 8_200)),
      // Compaction restores a pruned result under its original (unloaded) turn.
      entry(event('tool/result', {
        turn: 451, step: 1, message: { role: 'tool', content: [], source: { callId: 'call-old' } },
      }, 8_300)),
    ])
    expect(snapshot?.turns.map(turn => turn.turn)).toEqual([575])
    expect(snapshot?.stepCount).toBe(1)
  })

  it('folds a trimmed window from the update events it still holds', async () => {
    const definitions = await registeredDefinitions()
    const snapshot = assemble(definitions, [
      entry(event('user/message', {
        role: 'user', id: 'u2', content: [{ type: 'text', text: '问题' }], source: { kind: 'user' },
      })),
      entry(event('assistant/message', {
        turn: 4,
        step: 1,
        message: { id: 'm2', role: 'assistant', content: [], source: { provider: 'p', model: 'm' } },
        stream: stream(7_300),
        usage,
      }, 7_400)),
      entry(event('tool/call', {
        turn: 4, step: 1, callId: 'call-2', name: 'grep', arguments: '{"pattern":"x","include":"*.ts"}',
      }, 7_500)),
      entry(event('tool/result', {
        turn: 4, step: 1, message: { role: 'tool', content: [{ type: 'text', text: 'hit' }], source: { callId: 'call-2' } },
      }, 7_600)),
      entry(event('turn/end', { turn: 4, reason: { kind: 'completed' } }, 7_700)),
    ])
    expect(snapshot?.turns).toHaveLength(1)
    const step = snapshot!.turns[0]!.steps[0]!
    expect(step.startTime).toBeNull()
    expect(step.context).toBe(600)
    expect(step.tools).toEqual([{ name: 'grep', count: 1 }])
    expect(snapshot!.turns[0]!.prompt).toBeNull()
  })

  it('publishes a compaction row with its summary call facts', async () => {
    const definitions = await registeredDefinitions()
    const snapshot = assemble(definitions, [
      entry(event('turn/start', { turn: 6 })),
      entry(event('step/start', { turn: 6, step: 1 }, 5_000)),
      entry(event('user/message', {
        content: [{ type: 'text', text: 'go' }],
        source: { kind: 'user' },
      }, 5_100)),
      entry(event('compaction/start', { compactionId: '', turn: 6 }, 4_800)),
      entry(event('compaction/start', { compactionId: 'cmp-0', turn: null }, 4_900)),
      entry(event('compaction/summary', {
        compactionId: 'cmp-0',
        turn: 6,
        summary: [{ type: 'text', text: 'older summary' }],
        shadowedRange: { start: 1 as SessionSeq, end: 2 as SessionSeq },
        shadowedSeqs: [],
        shadowedTokenCount: 1_000,
        provider: 'p',
        model: 'm',
        llmStreamCall: false,
      }, 5_000)),
      entry(event('compaction/end', { compactionId: 'cmp-0', turn: 6 }, 5_100)),
      entry(event('compaction/start', { compactionId: 'another', turn: null }, 5_150)),
      entry(event('compaction/end', { compactionId: 'another', turn: null }, 5_160)),
      entry(event('compaction/start', { compactionId: 'cmp-1', turn: 6 }, 5_200)),
      entry(event('compaction/summary', {
        compactionId: 'cmp-1',
        turn: 6,
        summary: [{ type: 'text', text: 'sum' }, { type: 'reasoning', text: 'why' }],
        shadowedRange: { start: 1 as SessionSeq, end: 2 as SessionSeq },
        shadowedSeqs: [],
        shadowedTokenCount: 4_000,
        provider: 'deepseek-official',
        model: 'deepseek-flash',
        usage: { inputTokens: 1_000, cacheReadTokens: 100, outputTokens: 50 },
        llmStreamCall: false,
      }, 5_300)),
      entry(event('compaction/end', { compactionId: 'cmp-1', turn: 6 }, 5_400)),
      entry(event('step/end', { turn: 6, step: 1 }, 5_500)),
      entry(event('turn/end', { turn: 6, reason: { kind: 'completed' } }, 5_600)),
    ])
    expect(snapshot?.turns).toHaveLength(1)
    expect(snapshot?.turns[0]?.compactions).toHaveLength(2)
    expect(snapshot?.turns[0]?.compactions.find(entry => entry.compactionId === 'cmp-0')).toMatchObject({
      turn: 6, context: null, output: null, cacheHit: null, summaryChars: 13,
    })
    expect(snapshot?.turns[0]?.compactions[1]).toEqual({
      compactionId: 'cmp-1',
      turn: 6,
      startTime: 5_200,
      endTime: 5_400,
      wall: 200,
      running: false,
      context: 1_100,
      output: 50,
      cacheHit: 100 / 1_100,
      cacheRead: 100,
      cacheWrite: null,
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      shadowedTokens: 4_000,
      summaryChars: 3,
      error: null,
    })

    const interrupted = assemble(definitions, [
      entry(event('turn/start', { turn: 7 })),
      entry(event('step/start', { turn: 7, step: 1 }, 6_000)),
      entry(event('user/message', { content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }, 6_010)),
      entry(event('compaction/start', { compactionId: 'cmp-2', turn: 7 }, 6_100)),
      entry(event('compaction/end', { compactionId: 'cmp-2', turn: 7, error: 'aborted' }, 6_200)),
      entry(event('turn/end', { turn: 7, reason: { kind: 'completed' } }, 6_300)),
    ])
    expect(interrupted?.turns[0]?.compactions[0]?.error).toBe('aborted')
    expect(interrupted?.turns[0]?.compactions[0]?.running).toBe(false)

    const running = assemble(definitions, [
      entry(event('turn/start', { turn: 8 })),
      entry(event('step/start', { turn: 8, step: 1 }, 6_400)),
      entry(event('user/message', { content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }, 6_410)),
      entry(event('compaction/start', { compactionId: 'cmp-3', turn: 8 }, 6_500)),
      entry(event('step/end', { turn: 8, step: 1 }, 6_600)),
      entry(event('turn/end', { turn: 8, reason: { kind: 'interrupted' } }, 6_700)),
    ])
    expect(running?.turns[0]?.compactions[0]).toMatchObject({
      running: true, wall: null, context: null, provider: null, shadowedTokens: null, summaryChars: null, error: null,
    })
  })

  it('publishes request, prompt, tool-set, and prune event rows', async () => {
    const definitions = await registeredDefinitions()
    const snapshot = assemble(definitions, [
      entry(event('compaction/prune', {
        shadowedRange: { start: 1, end: 2 }, shadowedSeqs: [], shadowedTokenCount: 10,
      }, 6_900)),
      entry(event('turn/start', { turn: 9 })),
      entry(event('request/header', {
        header: { config: { provider: 'p', model: 'm', reasoningEffort: 'max', maxTokens: 1_000 } },
        reason: 'initial',
      }, 6_950)),
      entry(event('step/start', { turn: 9, step: 1 }, 7_000)),
      entry(event('user/message', { content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }, 7_010)),
      entry(event('request/header', {
        header: { config: { provider: 'p', model: 'm', reasoningEffort: 'max', maxTokens: 1_000 }, tools: [{ name: 'read' }] },
        reason: 'series',
        startsSeries: true,
      }, 7_100)),
      entry(surfaceEvent('system/message', {
        turn: 9,
        step: 1,
        message: { role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'prompt' }] },
      }, 'append', 7_200)),
      entry(surfaceEvent('system/message', {
        turn: 9,
        step: 1,
        message: { role: 'system', source: { kind: 'system-prompt' }, content: [] },
      }, 'replace', 7_300)),
      entry(event('developer/message', {
        turn: 9,
        step: 1,
        message: {
          role: 'developer',
          source: { kind: 'tool-registry' },
          content: [{ type: 'tool-addition', toolName: 'read' }, { type: 'tool-removal', toolName: 'edit' }],
        },
      }, 7_400)),
      entry(event('developer/message', {
        turn: 9,
        step: 1,
        message: { role: 'developer', source: { kind: 'plugin' }, content: [{ type: 'text', text: 'note' }] },
      }, 7_450)),
      entry(event('developer/message', {
        turn: 9,
        step: 1,
        message: { role: 'developer', source: { kind: 'tool-registry' }, content: [{ type: 'text', text: 'noop' }] },
      }, 7_480)),
      entry(event('compaction/prune', {
        shadowedRange: { start: 1, end: 2 }, shadowedSeqs: [], shadowedTokenCount: 5_000,
      }, 7_600)),
      entry(event('step/end', { turn: 9, step: 1 }, 7_700)),
      entry(event('turn/end', { turn: 9, reason: { kind: 'completed' } }, 7_800)),
    ])
    expect(snapshot?.turns).toHaveLength(1)
    const events = snapshot!.turns[0]!.events
    expect(events.map(event => event.kind)).toEqual([
      'request-header', 'request-header', 'system-prompt', 'system-prompt', 'tool-set', 'context-prune',
    ])
    expect(events[0]).toMatchObject({ kind: 'request-header', turn: 9, step: null, toolCount: null })
    expect(events[1]).toMatchObject({
      reason: 'series', series: true, provider: 'p', model: 'm', toolCount: 1, turn: 9, step: 1,
    })
    expect(events[2]).toMatchObject({ kind: 'system-prompt', surfaceOp: 'append', chars: 6 })
    expect(events[3]).toMatchObject({ kind: 'system-prompt', surfaceOp: 'clear', chars: 0 })
    expect(events[4]).toMatchObject({ kind: 'tool-set', added: ['read'], removed: ['edit'] })
    expect(events[5]).toMatchObject({ kind: 'context-prune', shadowedTokens: 5_000 })

    const turnLocation = { kind: 'turn', turn: { turn: 9 } } as Parameters<typeof eventMetrics>[1]
    expect(eventMetrics(event('request/header', {
      header: { config: { provider: 'p', model: 'm' } }, reason: 'initial',
    }), turnLocation)).toMatchObject({ turn: 9, step: null, toolCount: null })
    expect(eventMetrics(surfaceEvent('system/message', {
      message: { role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'reasoning', text: 'r' }] },
    }, 'replace'), undefined)).toMatchObject({ surfaceOp: 'clear', chars: 0 })
    expect(eventMetrics(surfaceEvent('system/message', {
      message: { role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'next' }] },
    }, 'replace'), undefined)).toMatchObject({ surfaceOp: 'replace', chars: 4 })
    expect(eventMetrics(event('developer/message', {
      message: { role: 'developer', source: { kind: 'tool-registry' }, content: [{ type: 'text', text: 'noop' }] },
    }), undefined)).toBeNull()
    expect(eventMetrics(event('developer/message', {
      message: {
        role: 'developer',
        source: { kind: 'tool-registry' },
        content: [{ type: 'text', text: 'x', toolName: 'unknown' }],
      },
    }), undefined)).toBeNull()
  })

  it('normalizes lifecycle events for the event rows', () => {
    const turnLocation = { kind: 'turn', turn: { turn: 9 } } as Parameters<typeof eventMetrics>[1]
    expect(eventMetrics(event('request/context', {
      provider: 'p', model: 'm', contextWindow: 128_000, systemPromptUpdate: 'in-history',
    }), turnLocation)).toMatchObject({
      kind: 'request-context', turn: 9, step: null, provider: 'p', model: 'm', status: 'in-history', chars: 128_000,
    })
    expect(eventMetrics(event('request/context', { provider: 'p', model: 'm' }), undefined)).toMatchObject({
      status: null, chars: null,
    })
    expect(eventMetrics(event('llm/retry', {
      retryId: 'r1', turn: 3, step: 2, provider: 'p', mode: 'normal', policyKey: 'k', retry: 2, maxRetries: 5,
      delayMs: 1_500, failure: { message: 'rate limited', code: 'RATE_LIMIT' },
    }), undefined)).toMatchObject({
      kind: 'model-retry', turn: 3, step: 2, provider: 'p', status: 'normal', retry: 2, delayMs: 1_500,
      error: 'rate limited',
    })
    expect(eventMetrics(event('assistant/attempt', { turn: 3, step: 2, stream: [] }), undefined)).toMatchObject({
      kind: 'model-attempt', turn: 3, step: 2, status: 'attempt',
    })
    expect(eventMetrics(surfaceEvent('user/message', {
      role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'ctx' }],
    }, 'append'), undefined)).toMatchObject({ kind: 'context-refresh', status: 'runtime-context', chars: 3 })
    expect(eventMetrics(surfaceEvent('user/message', {
      role: 'user', source: { kind: 'time-context' }, content: [],
    }, 'append'), undefined)).toMatchObject({ kind: 'context-refresh', status: 'time-context', chars: 0 })
    expect(eventMetrics(surfaceEvent('user/message', {
      role: 'user', source: { kind: 'user' }, content: [],
    }, 'append'), undefined)).toBeNull()
    expect(eventMetrics(event('approval/asked', {
      id: 'a1', toolName: 'bash', reason: 'needs approval',
    }), turnLocation)).toMatchObject({
      kind: 'approval', turn: 9, step: null, status: 'asked', label: 'bash', error: 'needs approval',
    })
    expect(eventMetrics(event('approval/asked', { id: 'a2', toolName: 'read' }), undefined)).toMatchObject({
      kind: 'approval', status: 'asked', label: 'read', error: null,
    })
    expect(eventMetrics(event('approval/decided', { id: 'a1', outcome: 'rejected' }), turnLocation)).toMatchObject({
      kind: 'approval', turn: 9, status: 'rejected',
    })
  })

  it('attributes Code-Mode dispatch events through the root call table', async () => {
    const definitions = await registeredDefinitions()
    const snapshot = assemble(definitions, [
      entry(event('turn/start', { turn: 5 })),
      entry(event('step/start', { turn: 5, step: 1 }, 8_000)),
      entry(event('tool/call', { turn: 5, step: 1, callId: 'root-1', name: 'run_code', arguments: '{}' }, 8_100)),
      entry(event('tool/ptc-dispatch-start', {
        rootCallId: 'root-1', parentCallId: 'root-1', subCallId: 'sub-1', name: 'grep', arguments: '{"pattern":"x"}',
      }, 8_200)),
      entry(event('tool/ptc-dispatch', {
        rootCallId: 'root-1', parentCallId: 'root-1', subCallId: 'sub-1', name: 'grep',
        arguments: '{"pattern":"x"}', isError: false, content: [{ type: 'text', text: 'hit' }],
      }, 8_300)),
      entry(event('step/end', { turn: 5, step: 1 }, 8_400)),
      entry(event('turn/end', { turn: 5, reason: { kind: 'completed' } }, 8_400)),
    ])
    const step = snapshot!.turns[0]!.steps[0]!
    expect(step.calls).toHaveLength(1)
    expect(step.calls[0]?.inner).toBe(true)
    expect(step.calls[0]?.name).toBe('grep')
    expect(step.tools).toEqual([{ name: 'grep', count: 1 }])
  })

  it('incrementally applies the live tail after the window', async () => {
    const definitions = await registeredDefinitions()
    const snapshot = assemble(
      definitions,
      [entry(event('turn/start', { turn: 6 })), entry(event('step/start', { turn: 6, step: 1 }, 9_000))],
      {
        upserts: [
          entry(event('assistant/message', {
            turn: 6,
            step: 1,
            message: { id: 'm3', role: 'assistant', content: [], source: { provider: 'p', model: 'm' } },
            stream: stream(9_300),
            usage,
          }, 9_400)),
          entry(event('step/end', { turn: 6, step: 1 }, 9_500)),
        ],
      },
    )
    expect(snapshot?.stepCount).toBe(1)
    expect(snapshot!.turns[0]!.steps[0]!.ttft).toBe(300)
  })

  it('publishes a prompt node from a human-typed user message location', async () => {
    const definitions = await registeredDefinitions()
    const prompt = definitions[1] as ConversationNodeDefinition<StatsStepState>
    expect(prompt.match(event('turn/start', { turn: 9 }))).toBeNull()
    const runtime = event('user/message', {
      role: 'user', id: 'u4', content: [{ type: 'text', text: '<system-reminder>' }], source: { kind: 'runtime-context' },
    })
    expect(prompt.match(runtime)).toEqual({ id: `${runtime.seq}`, role: 'start' })
    const user = event('user/message', {
      role: 'user', id: 'u6', content: [{ type: 'text', text: '继续' }, { type: 'image', attachment: IMAGE }], source: { kind: 'user' },
    })
    expect(prompt.match(user)).toEqual({ id: `${user.seq}`, role: 'start' })
    const match = locatedStart(user, turnAt(9))
    const state = prompt.start(contextOf(prompt, undefined), match, reader)
    expect(state.turn).toBe(9)
    expect(state.mark).toBe('prompt')
    expect(state.prompt).toBe('继续')
    expect(state.images).toEqual([IMAGE])
    expect(state.trigger).toBe('user')
    const node = prompt.buildViewNode!({
      ...contextOf(prompt, state, [match], match),
    }) as StatsViewNode
    expect(node.data).toEqual({ kind: 'prompt', turn: 9, prompt: '继续', images: [IMAGE], source: 'user', sender: null })
    const context: ConversationNodeContext<StatsStepState> & { readonly state: StatsStepState } = {
      ...contextOf(prompt, state, [match], match),
      state,
    }
    expect(prompt.update(context, match)).toBe(state)
  })

  it('takes a prompt turn from a step location and anchors without a start', async () => {
    const definitions = await registeredDefinitions()
    const prompt = definitions[1] as ConversationNodeDefinition<StatsStepState>
    const user = event('user/message', {
      role: 'user', id: 'u7', content: [{ type: 'text', text: '问题' }], source: { kind: 'user' },
    })
    const located = locatedStart(user, stepAt(4, 1))
    const state = prompt.start(contextOf(prompt, undefined), located, reader)
    expect(state.turn).toBe(4)
    const update = locatedUpdate(user, stepAt(4, 1))
    const node = prompt.buildViewNode!({
      ...contextOf(prompt, state, [update]),
    }) as StatsViewNode
    expect(node.anchorSeq).toBe(0)
    expect(node.data).toMatchObject({ kind: 'prompt', turn: 4 })
    // A message the window cannot place publishes no row.
    expect(prompt.buildViewNode!({ ...contextOf(prompt, state) })).toBeNull()
  })

  it('falls back to the generic trigger when the source kind is unrecorded', async () => {
    const definitions = await registeredDefinitions()
    const prompt = definitions[1] as ConversationNodeDefinition<StatsStepState>
    const user = event('user/message', {
      role: 'user', id: 'u8', content: [{ type: 'text', text: '问题' }], source: { kind: 'user' },
    })
    const match = locatedStart(user, turnAt(3))
    const state = { ...prompt.start(contextOf(prompt, undefined), match, reader), trigger: null }
    const node = prompt.buildViewNode!({
      ...contextOf(prompt, state, [match], match),
    }) as StatsViewNode
    expect(node.data).toMatchObject({ kind: 'prompt', source: 'other' })
  })

  it('folds Code-Mode dispatches into one node per root call', async () => {
    const definitions = await registeredDefinitions()
    const codeMode = definitions[3] as ConversationNodeDefinition<StatsStepState>
    const startEvent = event('tool/ptc-dispatch-start', {
      rootCallId: 'root-1', parentCallId: 'root-1', subCallId: 'sub-1', name: 'grep', arguments: '{"pattern":"x"}',
    }, 8_200)
    const dispatch = event('tool/ptc-dispatch', {
      rootCallId: 'root-1', parentCallId: 'root-1', subCallId: 'sub-1', name: 'grep',
      arguments: '{"pattern":"x"}', isError: false, content: [{ type: 'text', text: 'hit' }],
    }, 8_300)
    expect(codeMode.match(startEvent)).toEqual({ id: 'code:root-1', role: 'start' })
    expect(codeMode.match(dispatch)).toEqual({ id: 'code:root-1', role: 'update' })
    expect(codeMode.match(event('step/start', { turn: 1, step: 1 }))).toBeNull()
    const start = locatedStart(startEvent, stepAt(5, 1))
    const update = locatedUpdate(dispatch, stepAt(5, 1))
    const state = codeMode.start(contextOf(codeMode, undefined), start, reader)
    expect(state.starts).toEqual({ 'sub-1': 8_200 })
    const context: ConversationNodeContext<StatsStepState> & { readonly state: StatsStepState } = {
      ...contextOf(codeMode, state, [start, update], start),
      state,
    }
    const folded = codeMode.update(context, update)
    expect(folded.calls?.['sub-1']?.name).toBe('grep')
    const node = codeMode.buildViewNode!({
      ...contextOf(codeMode, folded, [start, update], start),
    }) as StatsViewNode
    expect(node.data).toMatchObject({ kind: 'inner', turn: 5, step: 1 })
    const inner = node.data
    if (inner.kind !== 'inner') throw new Error('expected an inner contribution')
    expect(inner.calls.map(call => call.name)).toEqual(['grep'])
    expect(inner.calls[0]?.ms).toBe(100)
    // Without a step location the contribution has no row to merge into.
    expect(codeMode.buildViewNode!({
      ...contextOf(codeMode, folded, [start, update], locatedStart(startEvent, turnAt(5))),
    })).toBeNull()
  })

  it('publishes an inner node only when the window still knows its step', async () => {
    const definitions = await registeredDefinitions()
    const codeMode = definitions[3] as ConversationNodeDefinition<StatsStepState>
    const startEvent = event('tool/ptc-dispatch-start', {
      rootCallId: 'root-2', parentCallId: 'root-2', subCallId: 'sub-2', name: 'read', arguments: '{}',
    }, 6_200)
    const dispatch = event('tool/ptc-dispatch', {
      rootCallId: 'root-2', parentCallId: 'root-2', subCallId: 'sub-2', name: 'read',
      arguments: '{}', isError: false, content: [],
    }, 6_300)
    const start = locatedStart(startEvent, stepAt(6, 1))
    const update = locatedUpdate(dispatch, stepAt(6, 1))
    const state = codeMode.start(contextOf(codeMode, undefined), start, reader)
    const folded = codeMode.update({
      ...contextOf(codeMode, state, [start, update], start),
      state,
    }, update)
    // Without a start match the node anchors at zero and takes the last location.
    const noStart = codeMode.buildViewNode!({
      ...contextOf(codeMode, folded, [update]),
    }) as StatsViewNode
    expect(noStart.anchorSeq).toBe(0)
    expect(noStart.data).toMatchObject({ kind: 'inner', turn: 6, step: 1 })
    // A turn-only location, or no location evidence, publishes no row.
    expect(codeMode.buildViewNode!({
      ...contextOf(codeMode, folded, [locatedUpdate(dispatch, turnAt(6))]),
    })).toBeNull()
    expect(codeMode.buildViewNode!({ ...contextOf(codeMode, folded) })).toBeNull()
    // The node still merges even when the dispatch lost its own start.
    const lostStart = { ...folded, calls: { 'sub-2': { ...folded.calls!['sub-2']!, ms: null, startedAt: null } } }
    const node = codeMode.buildViewNode!({
      ...contextOf(codeMode, lostStart, [update]),
    }) as StatsViewNode
    expect(node.data).toMatchObject({ kind: 'inner', turn: 6, step: 1 })
  })

  it('keeps a Code-Mode start unplaced when the window has no step location', async () => {
    const definitions = await registeredDefinitions()
    const codeMode = definitions[3] as ConversationNodeDefinition<StatsStepState>
    const startEvent = event('tool/ptc-dispatch-start', {
      rootCallId: 'root-3', parentCallId: 'root-3', subCallId: 'sub-3', name: 'grep', arguments: '{}',
    }, 7_200)
    const turnOnly = codeMode.start(
      contextOf(codeMode, undefined),
      locatedStart(startEvent, turnAt(7)),
      reader,
    )
    expect(turnOnly.turn).toBe(0)
    expect(turnOnly.step).toBe(0)
    const unlocated = codeMode.start(
      contextOf(codeMode, undefined),
      { ...startMatch(startEvent), location: undefined as never },
      reader,
    )
    expect(unlocated.turn).toBe(0)
    // An update that arrives before any start keeps the absent state.
    const orphan = event('tool/ptc-dispatch', {
      rootCallId: 'root-4', parentCallId: 'root-4', subCallId: 'sub-4', name: 'read',
      arguments: '{}', isError: false, content: [],
    }, 7_300)
    expect(codeMode.update(contextOf(codeMode, undefined) as never, updateMatch(orphan))).toBeUndefined()
  })

  it('rejects a start callback handed the wrong lifecycle event', async () => {
    const definitions = await registeredDefinitions()
    const wrong = updateMatch(event('assistant/message', { turn: 1, step: 1 }))
    for (const definition of definitions) {
      expect(() => definition.start(
        contextOf(definition as ConversationNodeDefinition<StatsStepState>, undefined),
        wrong as ConversationStartMatch,
        reader,
      )).toThrow(/requires/)
    }
  })

  it('publishes no view node for a Context without state or evidence', async () => {
    const definitions = await registeredDefinitions()
    for (const definition of definitions) {
      expect(definition.buildViewNode!(contextOf(definition as ConversationNodeDefinition<StatsStepState>, undefined))).toBeNull()
    }
  })

  it('names the update cadence of live chunks and start events', async () => {
    const definitions = await registeredDefinitions()
    const step = definitions[0] as ConversationNodeDefinition<StatsStepState>
    expect(step.publication!(startMatch(event('step/start', { turn: 1, step: 1 })))).toBe('none')
    expect(step.publication!(updateMatch(transient(1, 1, delta).event))).toBe('none')
    expect(step.publication!(updateMatch(event('assistant/attempt', { turn: 1, step: 1 })))).toBe('none')
    expect(step.publication!(updateMatch(event('step/end', { turn: 1, step: 1 })))).toBe('immediate')
    const prompt = definitions[1] as ConversationNodeDefinition<StatsStepState>
    expect(prompt.publication!(startMatch(event('user/message', {
      role: 'user', id: 'u', content: [], source: { kind: 'user' },
    })))).toBe('immediate')
    expect(Object.hasOwn(definitions[3]!, 'publication')).toBe(false)
  })

  it('anchors and locates a step node from its folded state', async () => {
    const definitions = await registeredDefinitions()
    const step = definitions[0] as ConversationNodeDefinition<StatsStepState>
    const startEvent = event('step/start', { turn: 11, step: 2 }, 11_000)
    const start = startMatch(startEvent)
    const update = updateMatch(event('assistant/message', {
      turn: 11,
      step: 2,
      message: { id: 'm', role: 'assistant', content: [], source: { provider: 'p', model: 'm' } },
      stream: stream(11_300),
      usage,
    }, 11_400))
    const state = step.start(
      contextOf(step, undefined),
      start,
      reader,
    )
    const folded = step.update(
      {
        ...contextOf(step, state, [start, update], start),
        state,
      },
      update,
    )
    const withStart = step.buildViewNode!({
      ...contextOf(step, folded, [start, update], start),
    }) as StatsViewNode
    expect(withStart.anchorSeq).toBe(startEvent.seq)
    expect(withStart.location).toEqual({ kind: 'unresolved' })
    expect(withStart.data.kind).toBe('step')
    const contribution = withStart.data
    if (contribution.kind !== 'step') throw new Error('expected a step contribution')
    expect(contribution.metrics.context).toBe(600)
    expect(contribution.metrics.toolWall).toBeNull()

    // Without a start match, the node anchors at 0 and takes the last match location.
    const trimmed = step.buildViewNode!({
      ...contextOf(step,
        { ...folded, startSeq: null }, [{ ...update, location: stepAt(11, 2) }]),
    }) as StatsViewNode
    expect(trimmed.anchorSeq).toBe(0)
    expect(trimmed.location).toEqual(stepAt(11, 2))
    const unresolved = step.buildViewNode!({
      ...contextOf(step, { ...folded, startSeq: null }, []),
    }) as StatsViewNode
    expect(unresolved.location).toEqual({ kind: 'unresolved' })
  })

  it('matches every step lifecycle event by turn and step', async () => {
    const definitions = await registeredDefinitions()
    const step = definitions[0] as ConversationNodeDefinition<StatsStepState>
    const cases: readonly [SessionEventLike, string][] = [
      [event('step/start', { turn: 12, step: 3 }), '12:3'],
      [event('step/end', { turn: 12, step: 3 }), '12:3'],
      [event('assistant/attempt', { turn: 12, step: 3 }), '12:3'],
      [event('assistant/message', { turn: 12, step: 3 }), '12:3'],
      [event('llm/retry', { turn: 12, step: 3 }), '12:3'],
      [event('tool/call', { turn: 12, step: 3, callId: 'c', name: 'read', arguments: '{}' }), '12:3'],
      [event('tool/result', {
        turn: 12, step: 3, message: { role: 'tool', content: [], source: { callId: 'c' }, toolCallId: 'c' },
      }), '12:3'],
      [transient(12, 3, delta).event, '12:3'],
    ]
    for (const [fixture, id] of cases) {
      expect(step.match(fixture)?.id).toBe(id)
    }
    expect(step.match(event('developer/message', { turn: 12, step: 3 }))).toBeNull()
    expect(step.match(event('user/message', { role: 'user', id: 'u', content: [], source: { kind: 'user' } }))).toBeNull()
  })

  it('builds prompt and end markers from their folded states', async () => {
    const definitions = await registeredDefinitions()
    const end = definitions[2] as ConversationNodeDefinition<StatsStepState>
    const endStart = startMatch(event('turn/end', { turn: 13, reason: { kind: 'interrupted' } }, 13_500))
    const ended = end.start(
      contextOf(end, undefined),
      endStart,
      reader,
    )
    expect(ended.closed).toBe(true)
    expect(ended.closeKind).toBe('interrupted')
    const endNode = end.buildViewNode!({
      ...contextOf(end, ended, [], endStart),
    }) as StatsViewNode
    expect(endNode.data).toEqual({ kind: 'end', turn: 13, closeKind: 'interrupted', endTime: 13_500 })
    expect(end.match(event('step/start', { turn: 13, step: 1 }))).toBeNull()
  })

  it('keeps the end state and anchors it at zero without a recorded start', async () => {
    const definitions = await registeredDefinitions()
    const end = definitions[2] as ConversationNodeDefinition<StatsStepState>
    const endState = end.start(
      contextOf(end, undefined),
      startMatch(event('turn/end', { turn: 14, reason: { kind: 'completed' } }, 14_500)),
      reader,
    )
    const endContext: ConversationNodeContext<StatsStepState> & { readonly state: StatsStepState } = {
      ...contextOf(end, endState),
      state: endState,
    }
    expect(end.update(
      endContext,
      updateMatch(event('turn/end', { turn: 14, reason: { kind: 'completed' } })),
    )).toBe(endState)
    const endNode = end.buildViewNode!({
      ...contextOf(end, endState),
    }) as StatsViewNode
    expect(endNode.anchorSeq).toBe(0)
  })
})
