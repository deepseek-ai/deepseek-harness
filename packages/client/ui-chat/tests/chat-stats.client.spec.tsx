// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type {
  AssistantMessageNode, ChatSnapshot, LegacyConversationSlice, ToolResultNode,
} from '@deepseek-ai/dsh-client-ui-chat/client'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { StatsLine, deriveStats, formatDuration, type StatsLineProps } from '../src/client/chat/StatsLine.tsx'
import { formatTokens } from '../src/client/chat/token-format.ts'
import { en, zh } from '../src/client/locale.ts'
import { chatSnapshotFixture } from './chat-snapshot-fixture.client.ts'

const t: StatsLineProps['t'] = makeTranslate(zh, commonZh)
const tEn: StatsLineProps['t'] = makeTranslate(en, commonEn)

/** jsdom has no ResizeObserver; StatsLine watches its row for ellipsis truncation through one. */
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => { vi.stubGlobal('ResizeObserver', ResizeObserverStub) })
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const assistant = (seq: number, turn: number, usage?: unknown): AssistantMessageNode => ({
  kind: 'assistant', seq, time: seq * 1_000, turn, step: seq, blocks: [{ kind: 'text', text: `t${seq}` }],
  ...(usage === undefined ? {} : { usage }),
})

type ChatUpdate = Partial<LegacyConversationSlice>

function makeSource(init: ChatUpdate = {}) {
  let snap = chatSnapshotFixture(init)
  const subs = new Set<() => void>()
  return {
    set: (next: ChatUpdate) => {
      snap = chatSnapshotFixture({ ...snap.legacy, ...next }, snap)
      for (const fn of [...subs]) fn()
    },
    source: {
      getSnapshot: () => snap,
      subscribe: (fn: () => void) => {
        subs.add(fn)
        return () => subs.delete(fn)
      },
    },
  }
}

describe('deriveStats', () => {
  it('counts turns and steps and never folds node usage into accounting', () => {
    const stats = deriveStats([
      assistant(1, 1, { inputTokens: 100, outputTokens: 50, cacheReadTokens: 900 }),
      assistant(2, 1, { inputTokens: 100, outputTokens: 50 }),
      assistant(3, 2),
    ])
    expect(stats.turns).toBe(2)
    expect(stats.steps).toBe(3)
    // The window fold's counts are only the fallback for assemblies without
    // the sessionStats projection; the paged window is not an accounting
    // source either, so the fold exposes no billing fields (billing rides the
    // tokenUsage projection); decodeTokens is a throughput input, not a
    // billed total.
    expect(Object.keys(stats).sort()).toEqual(
      ['decodeMs', 'decodeTokens', 'llmMs', 'steps', 'toolMs', 'ttftMs', 'ttftSteps', 'turns'],
    )
  })

  it('ignores tool results with no call time', () => {
    const tool: ToolResultNode = {
      kind: 'tool-result', seq: 5, time: 5_000, callId: 'c', call: null, callTime: null, content: [],
      isError: false, subCalls: [],
    }
    const stats = deriveStats([tool, assistant(1, 1)])
    expect(stats.steps).toBe(1)
    expect(stats.toolMs).toBe(0)
  })

  it('sums LLM wall time from assistant timing and tool wall time from call/result pairs', () => {
    const timed: AssistantMessageNode = {
      ...assistant(1, 1),
      timing: { stepStartTime: 1_000, firstTokenTime: 1_200, completedTime: 3_500 },
    }
    const untimed: AssistantMessageNode = {
      ...assistant(2, 1),
      timing: { stepStartTime: null, firstTokenTime: null, completedTime: 9_000 },
    }
    const tool: ToolResultNode = {
      kind: 'tool-result', seq: 5, time: 7_000, callId: 'c', call: null, callTime: 4_000, content: [],
      isError: false, subCalls: [],
    }
    const stats = deriveStats([timed, untimed, tool])
    expect(stats.llmMs).toBe(2_500)
    expect(stats.toolMs).toBe(3_000)
  })

  it('sums ttft per recorded step and decode throughput inputs per usage-carrying step', () => {
    const sampled: AssistantMessageNode = {
      ...assistant(1, 1, { outputTokens: 40 }),
      timing: { stepStartTime: 1_000, firstTokenTime: 1_800, completedTime: 4_800 },
    }
    const ttftOnly: AssistantMessageNode = {
      ...assistant(2, 1),
      timing: { stepStartTime: 5_000, firstTokenTime: 5_400, completedTime: 7_400 },
    }
    const stats = deriveStats([sampled, ttftOnly, assistant(3, 2)])
    expect(stats.ttftMs).toBe(1_200)
    expect(stats.ttftSteps).toBe(2)
    // The usage-less step contributes no decode share, keeping the ratio honest.
    expect(stats.decodeMs).toBe(3_000)
    expect(stats.decodeTokens).toBe(40)
  })
})

describe('formatters', () => {
  it('formats token counts compactly', () => {
    expect(formatTokens(517, tEn)).toBe('517')
    expect(formatTokens(12_240, tEn)).toBe('12.2K')
    expect(formatTokens(517_000, tEn)).toBe('517K')
    expect(formatTokens(1_230_000, tEn)).toBe('1.2M')
  })

  it('formats durations under and over a minute', () => {
    expect(formatDuration(45_230, tEn)).toBe('45.2s')
    expect(formatDuration(162_000, tEn)).toBe('2m42s')
  })
})

describe('StatsLine', () => {
  const USAGE = { uncachedInputTokens: 10, outputTokens: 5, cacheReadTokens: 90, cacheWriteTokens: 0 }

  /** A whole-log sessionStats value: zeros plus overrides. */
  function sessionStats(overrides: Record<string, number>): Record<string, number> {
    return {
      turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0,
      ...overrides,
    }
  }

  /** Stub the projection seat: a key-addressed table of whole values. */
  function projections(values: Record<string, unknown>): StatsLineProps['useProjection'] {
    return (key: string) => values[key]
  }

  function props(
    source: { getSnapshot(): ChatSnapshot; subscribe(fn: () => void): () => void },
    values: Record<string, unknown> = { tokenUsage: USAGE },
  ): StatsLineProps {
    return { useChat: bindSnapshotSelector(source), useProjection: projections(values), t: tEn }
  }

  function tokenUsage(cacheReadTokens: number, uncachedInputTokens: number) {
    return { uncachedInputTokens, outputTokens: 1, cacheReadTokens, cacheWriteTokens: 0 }
  }

  it('mounts one size observer only while a non-empty line exists', () => {
    let observers = 0
    class CountingResizeObserver {
      constructor(_callback: ResizeObserverCallback) { observers++ }
      observe(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('ResizeObserver', CountingResizeObserver)
    const { set, source } = makeSource()
    render(<StatsLine {...props(source, {})} />)
    expect(observers).toBe(0)

    act(() => { set({ nodes: [assistant(1, 1)] }) })
    expect(observers).toBe(1)

    act(() => { set({ nodes: [assistant(1, 1), assistant(2, 1)] }) })
    expect(observers).toBe(1)
  })

  it('renders the grouped stats row and hides a brand-new empty session', () => {
    const { source } = makeSource({ nodes: [assistant(1, 1)] })
    const view = render(<StatsLine {...props(source)} />)
    // No timing on the fixture: the duration group drops out whole. Tokens come
    // from the projection, so paging the window cannot change them.
    expect(view.container.textContent).toBe('1 turns · 1 steps| Cache hit 90%| Input 100 tok · Output 5 tok')
    const empty = makeSource()
    const emptyView = render(<StatsLine {...props(empty.source, {
      tokenUsage: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      contextPressure: {},
    })} />)
    expect(emptyView.container.textContent).toBe('')
  })

  it.each([
    { actual: '98.6%', tokenUsageValue: tokenUsage(986, 14), expected: 'Cache hit 99%' },
    { actual: '99.1%', tokenUsageValue: tokenUsage(991, 9), expected: 'Cache hit 99%' },
    { actual: '99.49%', tokenUsageValue: tokenUsage(9_949, 51), expected: 'Cache hit 99%' },
    { actual: '99.5%', tokenUsageValue: tokenUsage(995, 5), expected: 'Cache hit 99.5%' },
    { actual: '99.94%', tokenUsageValue: tokenUsage(9_994, 6), expected: 'Cache hit 99.9%' },
    { actual: '99.95%', tokenUsageValue: tokenUsage(9_995, 5), expected: 'Cache hit 99.95%' },
    { actual: '99.955%', tokenUsageValue: tokenUsage(19_991, 9), expected: 'Cache hit 99.96%' },
    { actual: '99.985%', tokenUsageValue: tokenUsage(19_997, 3), expected: 'Cache hit 99.99%' },
    { actual: '99.995%', tokenUsageValue: tokenUsage(19_999, 1), expected: 'Cache hit 99.995%' },
    { actual: '99.9975%', tokenUsageValue: tokenUsage(39_999, 1), expected: 'Cache hit 99.998%' },
    {
      actual: 'the closest non-full ratio available from safe integer cumulative counts',
      tokenUsageValue: tokenUsage(Number.MAX_SAFE_INTEGER - 1, 1),
      expected: 'Cache hit 99.99999999999999%',
    },
    { actual: '100%', tokenUsageValue: tokenUsage(10_000, 0), expected: 'Cache hit 100%' },
  ])('formats an actual $actual cache-hit ratio as $expected', ({ tokenUsageValue, expected }) => {
    const { source } = makeSource({ nodes: [assistant(1, 1)] })
    const view = render(<StatsLine {...props(source, { tokenUsage: tokenUsageValue })} />)
    expect(view.container.textContent).toContain(expected)
  })

  it('reveals the full line in a delayed hover tooltip only while the row is clipped', () => {
    vi.useFakeTimers()
    // jsdom lays nothing out; fake a row narrower than its content.
    vi.spyOn(Element.prototype, 'scrollWidth', 'get').mockReturnValue(800)
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(400)
    const { source } = makeSource({ nodes: [assistant(1, 1)] })
    const view = render(<StatsLine {...props(source, { tokenUsage: tokenUsage(9_995, 5) })} />)
    expect(view.container.textContent).toContain('Cache hit 99.95%')
    fireEvent.mouseEnter(view.container.firstElementChild!)
    act(() => { vi.advanceTimersByTime(499) })
    expect(view.container.querySelector('[role="tooltip"]')).toBeNull()
    act(() => { vi.advanceTimersByTime(1) })
    expect(view.container.querySelector('[role="tooltip"]')?.textContent)
      .toBe('1 turns · 1 steps | Cache hit 99.95% | Input 10K tok · Output 1 tok')
  })

  it('suppresses the tooltip while the row fits without truncation', () => {
    vi.useFakeTimers()
    const { source } = makeSource({ nodes: [assistant(1, 1)] })
    const view = render(<StatsLine {...props(source)} />)
    fireEvent.mouseEnter(view.container.firstElementChild!)
    act(() => { vi.advanceTimersByTime(500) })
    expect(view.container.querySelector('[role="tooltip"]')).toBeNull()
  })

  it('renders window latency and throughput beside the wall-time group', () => {
    const timed: AssistantMessageNode = {
      ...assistant(1, 1, { outputTokens: 60 }),
      timing: { stepStartTime: 1_000, firstTokenTime: 1_800, completedTime: 4_800 },
    }
    const { source } = makeSource({ nodes: [timed] })
    const view = render(<StatsLine {...props(source)} />)
    expect(view.container.textContent).toContain('LLM 3.8s| TTFT avg 0.8s · 20 tok/s')
  })

  it('takes every stats label from the active locale', () => {
    const timed: AssistantMessageNode = {
      ...assistant(1, 1, { outputTokens: 60 }),
      timing: { stepStartTime: 1_000, firstTokenTime: 1_800, completedTime: 4_800 },
    }
    const { source } = makeSource({ nodes: [timed] })
    const view = render(<StatsLine {...props(source, { tokenUsage: tokenUsage(9_995, 5) })} t={t} />)
    expect(view.container.textContent)
      .toBe('1 轮 · 1 步| LLM 3.8秒| 首 token 平均 0.8秒 · 20 tok/s| 缓存命中 99.95%| 输入 10K tok · 输出 1 tok')
  })

  it('renders without ResizeObserver support', () => {
    vi.unstubAllGlobals()
    const { source } = makeSource({ nodes: [assistant(1, 1)] })
    expect(() => render(<StatsLine {...props(source)} />)).not.toThrow()
  })

  it('keeps durable token groups after the visible step window is empty', () => {
    const { source } = makeSource()
    const view = render(<StatsLine {...props(source, {
      tokenUsage: USAGE,
      contextPressure: { pressureTokens: 32_000, contextWindow: 128_000 },
    })} />)
    // Context occupancy lives on the composer's ContextMeter ring, not here.
    expect(view.container.textContent)
      .toBe('Cache hit 90%| Input 100 tok · Output 5 tok')
  })

  it('drops every token group when no projection is composed', () => {
    const { source } = makeSource({ nodes: [assistant(1, 1)] })
    const view = render(<StatsLine {...props(source, {})} />)
    expect(view.container.textContent).toBe('1 turns · 1 steps')
  })

  it('renders whole-session counts from the sessionStats projection over the paged window', () => {
    // The bug's acceptance at unit level: one loaded page must not scope the
    // counter — the durable projection's totals win over the window fold.
    const { source } = makeSource({ nodes: [assistant(1, 1)] })
    const view = render(<StatsLine {...props(source, {
      tokenUsage: USAGE,
      sessionStats: sessionStats({ turns: 10, steps: 89 }),
    })} />)
    expect(view.container.textContent)
      .toBe('10 turns · 89 steps| Cache hit 90%| Input 100 tok · Output 5 tok')
  })

  it('treats a defined zero-count projection as empty, not as fallback', () => {
    // A composed unit always serves the key; all-zero genuinely means no
    // closed step in the whole log, so nothing renders on a brand-new session.
    const empty = makeSource()
    const view = render(<StatsLine {...props(empty.source, {
      tokenUsage: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      sessionStats: sessionStats({}),
    })} />)
    expect(view.container.textContent).toBe('')
  })

  it('hides the zero-token group when steps closed without any billed activity', () => {
    // A session whose only turn failed before billing (e.g. an auth error):
    // the counts group renders alone, not an uninformative zero-token group.
    const { source } = makeSource()
    const view = render(<StatsLine {...props(source, {
      tokenUsage: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      sessionStats: sessionStats({ turns: 1, steps: 1 }),
    })} />)
    expect(view.container.textContent).toBe('1 turns · 1 steps')
  })

  it('keeps the counts group over an empty visible window when the projection carries totals', () => {
    // Extends the durable-groups guarantee: full-session counts survive a
    // window that compaction (or paging) left without assistant nodes.
    const { source } = makeSource()
    const view = render(<StatsLine {...props(source, {
      tokenUsage: USAGE,
      sessionStats: sessionStats({ turns: 7, steps: 44 }),
    })} />)
    expect(view.container.textContent)
      .toBe('7 turns · 44 steps| Cache hit 90%| Input 100 tok · Output 5 tok')
  })

  it('renders whole-log wall times and speeds from the projection, not the loaded window', () => {
    // The 加载更早 hazard beyond counts: LLM/tool durations and the TTFT and
    // throughput figures must not grow per loaded page either. An untimed
    // 1-node window renders the projection's whole-log figures verbatim.
    const { source } = makeSource({ nodes: [assistant(1, 1)] })
    const view = render(<StatsLine {...props(source, {
      tokenUsage: USAGE,
      sessionStats: sessionStats({
        turns: 200, steps: 200, llmMs: 100_000, toolMs: 62_000,
        ttftMs: 1_600, ttftSteps: 2, decodeMs: 3_000, decodeTokens: 60,
      }),
    })} />)
    expect(view.container.textContent).toBe(
      '200 turns · 200 steps| LLM 1m40s · Tool call 1m2s| TTFT avg 0.8s · 20 tok/s| Cache hit 90%| Input 100 tok · Output 5 tok',
    )
  })

  it('omits cache hit when nothing was billed on the input side', () => {
    const { source } = makeSource({ nodes: [assistant(1, 1)] })
    const view = render(<StatsLine {...props(source, {
      tokenUsage: { uncachedInputTokens: 0, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0 },
    })} />)
    expect(view.container.textContent).toBe('1 turns · 1 steps| Input 0 tok · Output 7 tok')
  })

  it('includes cache writes in billed input and the cache-hit denominator', () => {
    const { source } = makeSource({ nodes: [assistant(1, 1)] })
    const view = render(<StatsLine {...props(source, {
      tokenUsage: {
        uncachedInputTokens: 10,
        outputTokens: 7,
        cacheReadTokens: 90,
        cacheWriteTokens: 100,
      },
    })} />)
    expect(view.container.textContent)
      .toBe('1 turns · 1 steps| Cache hit 45%| Input 200 tok · Output 7 tok')
  })

  it('renders ZERO times during streaming chunk frames (RFC hard acceptance)', () => {
    const { set, source } = makeSource({ nodes: [assistant(1, 1)] })
    let renders = 0
    function Counting(p: StatsLineProps) {
      renders += 1
      return <StatsLine {...p} />
    }
    render(<Counting {...props(source)} />)
    const before = renders
    // Chunk frames swap partial only; nodes keeps its reference (object-layer contract).
    act(() => { set({ partial: { turn: 1, step: 2, blocks: [{ kind: 'text', text: 'a' }] } }) })
    act(() => { set({ partial: { turn: 1, step: 2, blocks: [{ kind: 'text', text: 'ab' }] } }) })
    expect(renders).toBe(before)
  })
})
