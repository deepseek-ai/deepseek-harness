import { describe, expect, it } from 'vitest'
import { AttachmentId, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { aggregateTotals, aggregateTurn, buildTurns, turnContext } from '../src/client/stats-aggregate.ts'
import type { StatsCall, StatsStepMetrics, StatsViewNode } from '../src/client/stats-contract.ts'
import { CALL_LIMIT } from '../src/client/stats-fold.ts'

/** One step row with every unmeasured column blank. */
function metricsOf(overrides: Partial<StatsStepMetrics> = {}): StatsStepMetrics {
  return {
    turn: 1,
    step: 1,
    startTime: null,
    endTime: null,
    context: null,
    ttft: null,
    model: null,
    decode: null,
    tps: null,
    output: null,
    tool: null,
    toolWall: null,
    tools: [],
    calls: [],
    toolOutput: 0,
    retries: 0,
    toolErrors: 0,
    answer: null,
    answerBody: null,
    answerTruncated: false,
    cacheRead: null,
    cacheWrite: null,
    cacheHit: null,
    wall: null,
    toolPending: 0,
    running: false,
    interrupted: false,
    aborted: false,
    ...overrides,
  }
}

function statsCall(callId: string, seqAt: number, overrides: Partial<StatsCall> = {}): StatsCall {
  return {
    callId,
    seq: seqAt,
    name: 'read',
    hint: null,
    chars: null,
    lines: null,
    error: false,
    added: null,
    removed: null,
    before: null,
    after: null,
    args: null,
    inner: false,
    text: null,
    truncated: false,
    ms: null,
    startedAt: null,
    endedAt: null,
    ...overrides,
  }
}

function stepNode(value: StatsStepMetrics): StatsViewNode {
  return {
    key: `${value.turn}:${value.step}`,
    kind: 'stats-step',
    id: `${value.turn}:${value.step}`,
    target: 'stats',
    anchorSeq: value.startTime ?? 0,
    location: { kind: 'unresolved' },
    data: { kind: 'step', metrics: value },
  }
}

function imageRef(id: string): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId(id),
    mediaType: 'image/png',
    bytes: 1,
    width: 1,
    height: 1,
  }
}

function promptNode(
  turn: number,
  prompt: string | null,
  images: readonly ImageAttachmentRef[] = [],
  source = 'user',
): StatsViewNode {
  return {
    key: `${turn}:prompt:${prompt ?? 'null'}`,
    kind: 'stats-prompt',
    id: `${turn}:prompt`,
    target: 'stats',
    anchorSeq: 1,
    location: { kind: 'unresolved' },
    data: { kind: 'prompt', turn, prompt, images, source, sender: null },
  }
}

function endNode(turn: number, endTime: number | null, closeKind: string | null): StatsViewNode {
  return {
    key: `${turn}:end`,
    kind: 'stats-turn-end',
    id: `${turn}:end`,
    target: 'stats',
    anchorSeq: 2,
    location: { kind: 'unresolved' },
    data: { kind: 'end', turn, closeKind, endTime },
  }
}

function innerNode(
  turn: number,
  step: number,
  calls: readonly StatsCall[],
): StatsViewNode {
  return {
    key: `${turn}:${step}:code:${calls.map(call => call.callId).join(',')}`,
    kind: 'stats-code-mode',
    id: `${turn}:${step}:code`,
    target: 'stats',
    anchorSeq: 3,
    location: { kind: 'unresolved' },
    data: { kind: 'inner', turn, step, calls },
  }
}

describe('turn aggregation', () => {
  it('reports an empty turn without invented values', () => {
    const turn = aggregateTurn(9, [])
    expect(turn.turn).toBe(9)
    expect(turn.steps).toEqual([])
    expect(turn.startTime).toBeNull()
    expect(turn.context).toBeNull()
    expect(turn.ttft).toBeNull()
    expect(turn.ttftPending).toBe(0)
    expect(turn.model).toBeNull()
    expect(turn.modelPending).toBe(0)
    expect(turn.decode).toBeNull()
    expect(turn.tps).toBeNull()
    expect(turn.output).toBeNull()
    expect(turn.tool).toBeNull()
    expect(turn.toolWall).toBeNull()
    expect(turn.toolPending).toBe(0)
    expect(turn.tools).toEqual([])
    expect(turn.cacheHit).toBeNull()
    expect(turn.cacheRead).toBeNull()
    expect(turn.cacheWrite).toBeNull()
    expect(turn.retries).toBe(0)
    expect(turn.toolErrors).toBe(0)
    expect(turn.toolOutput).toBe(0)
    expect(turn.lastStepWall).toBeNull()
    expect(turn.running).toBe(false)
    expect(turn.interrupted).toBe(false)
    expect(turn.aborted).toBe(false)
    expect(turn.wall).toBeNull()
    expect(turn.prompt).toBeNull()
    expect(turn.promptImages).toEqual([])
  })

  it('sums measured spans and reports partial coverage as a lower bound', () => {
    const measured = metricsOf({ startTime: 1_000, ttft: 100, model: 400, decode: 300, output: 40, tool: 200 })
    const unknown = metricsOf({ startTime: 2_000, toolPending: 2 })
    const turn = aggregateTurn(3, [measured, unknown])
    expect(turn.ttft).toBe(100)
    expect(turn.ttftPending).toBe(1)
    expect(turn.model).toBe(400)
    expect(turn.modelPending).toBe(1)
    expect(turn.decode).toBe(300)
    expect(turn.output).toBe(40)
    expect(turn.tool).toBe(200)
    expect(turn.toolPending).toBe(2)
    expect(turn.startTime).toBe(1_000)
    expect(turn.running).toBe(false)
  })

  it('reduces an entirely unmeasured turn to blanks', () => {
    const turn = aggregateTurn(3, [metricsOf(), metricsOf({ step: 2 })])
    expect(turn.ttft).toBeNull()
    expect(turn.ttftPending).toBe(0)
    expect(turn.model).toBeNull()
    expect(turn.modelPending).toBe(2)
    expect(turn.decode).toBeNull()
    expect(turn.output).toBeNull()
    expect(turn.tool).toBeNull()
    expect(turn.toolPending).toBe(0)
    expect(turn.tps).toBeNull()
    expect(turn.wall).toBeNull()
  })

  it('derives turn speed only when decode and output are both positive', () => {
    const fast = aggregateTurn(1, [
      metricsOf({ step: 1, decode: 2_000, output: 50 }),
      metricsOf({ step: 2, decode: 2_000, output: 50 }),
    ])
    expect(fast.tps).toBeCloseTo(100 / 4)
    const noDecode = aggregateTurn(1, [metricsOf({ decode: 0, output: 50 })])
    expect(noDecode.decode).toBe(0)
    expect(noDecode.tps).toBeNull()
    const noOutput = aggregateTurn(1, [metricsOf({ decode: 2_000, output: 0 })])
    expect(noOutput.tps).toBeNull()
  })

  it('weights the turn cache level by measured prompt tokens and keeps the last context', () => {
    const turn = aggregateTurn(4, [
      metricsOf({ step: 1, context: 100, cacheHit: 0.2, cacheRead: 20, cacheWrite: 5, wall: 10 }),
      metricsOf({ step: 2, context: 200, cacheHit: 0.5, cacheRead: 100, cacheWrite: 6, wall: 20 }),
      metricsOf({ step: 3, context: 300, wall: 30 }),
    ])
    expect(turn.context).toBe(300)
    expect(turn.cacheHit).toBeCloseTo(120 / 300)
    expect(turn.cacheRead).toBe(120)
    expect(turn.cacheWrite).toBe(11)
    expect(turn.cacheContext).toBe(300)
    expect(turn.lastStepWall).toBe(30)
    const heldBack = aggregateTurn(4, [
      metricsOf({ step: 1, context: 100, cacheHit: 0.2, cacheRead: 20, cacheWrite: 5, wall: 10 }),
      metricsOf({ step: 2, cacheHit: null, cacheRead: 99, cacheWrite: 99, wall: null }),
    ])
    expect(heldBack.context).toBe(100)
    expect(heldBack.cacheHit).toBe(0.2)
    expect(heldBack.cacheRead).toBe(20)
    expect(heldBack.cacheWrite).toBe(5)
    expect(heldBack.cacheContext).toBe(100)
    expect(heldBack.lastStepWall).toBe(10)
    const bare = aggregateTurn(4, [metricsOf({ cacheHit: 0.4 })])
    expect(bare.cacheHit).toBeNull()
    expect(bare.cacheRead).toBeNull()
    expect(bare.cacheWrite).toBeNull()
    expect(bare.cacheContext).toBeNull()
    const empty = aggregateTurn(4, [metricsOf({ context: 0, cacheRead: 0 })])
    expect(empty.cacheHit).toBeNull()
  })

  it('keeps unmeasured totals blank and skips unmeasured steps', () => {
    const bare = aggregateTurn(3, [metricsOf({ step: 1 })])
    expect(turnContext(bare, 'cumulative')).toBeNull()
    expect(turnContext(bare, 'latest')).toBeNull()
    const totals = aggregateTotals([bare])
    expect(totals.context).toBeNull()
    expect(totals.output).toBeNull()
    expect(totals.cacheHit).toBeNull()
    expect(totals.ttft).toBeNull()
    expect(totals.model).toBeNull()
    expect(totals.tps).toBeNull()
    expect(totals.tool).toBeNull()
    expect(totals.toolWall).toBeNull()
    expect(totals.wall).toBeNull()

    const partial = aggregateTurn(4, [metricsOf({ step: 1, context: 100, cacheRead: 40 })])
    expect(turnContext(partial, 'cumulative')).toBe(100)
    const mixed = aggregateTotals([partial])
    expect(mixed.cacheWrite).toBe(0)
    expect(mixed.cacheHit).toBe(0.4)
    const forged = { ...bare, cacheRead: 10, cacheContext: 100, cacheWrite: null }
    expect(aggregateTotals([forged]).cacheWrite).toBe(0)
  })

  it('aggregates loaded turns into totals with cumulative context', () => {
    const first = aggregateTurn(1, [
      metricsOf({
        step: 1, startTime: 0, endTime: 300, context: 100, output: 10, decode: 1_000,
        cacheRead: 80, cacheWrite: 5, ttft: 100, model: 200, tool: 50, toolWall: 40, wall: 300,
      }),
      metricsOf({
        step: 2, startTime: 300, endTime: 700, context: 200, output: 20, decode: 500,
        cacheRead: 150, cacheWrite: 5, ttft: 50, model: 100, wall: 400,
      }),
    ])
    const second = aggregateTurn(2, [
      metricsOf({
        step: 1, startTime: 700, endTime: 1_200, context: 300, output: 30, decode: 500,
        cacheRead: 250, cacheWrite: 10, tool: 75, toolWall: 60, wall: 500,
      }),
    ])
    const latest = aggregateTotals([first, second])
    expect(latest.turnCount).toBe(2)
    expect(latest.stepCount).toBe(3)
    expect(latest.context).toBe(600)
    expect(turnContext(first, 'latest')).toBe(200)
    expect(turnContext(first, 'cumulative')).toBe(300)
    expect(latest.output).toBe(60)
    expect(latest.cacheRead).toBe(480)
    expect(latest.cacheWrite).toBe(20)
    expect(latest.cacheContext).toBe(600)
    expect(latest.cacheHit).toBe(0.8)
    expect(latest.ttft).toBe(150)
    expect(latest.ttftPending).toBe(0)
    expect(latest.model).toBe(300)
    expect(latest.modelPending).toBe(1)
    expect(latest.tps).toBeCloseTo(60 / 2)
    expect(latest.tool).toBe(125)
    expect(latest.toolPending).toBe(0)
    expect(latest.toolWall).toBe(100)
    expect(latest.wall).toBe(1_200)

    const empty = aggregateTotals([])
    expect(empty).toEqual({
      turnCount: 0,
      stepCount: 0,
      context: null,
      output: null,
      cacheHit: null,
      cacheRead: null,
      cacheWrite: null,
      cacheContext: null,
      ttft: null,
      ttftPending: 0,
      model: null,
      modelPending: 0,
      tps: null,
      tool: null,
      toolPending: 0,
      toolWall: null,
      wall: null,
    })
  })

  it('sums the sequential step tool spans', () => {
    const turn = aggregateTurn(5, [
      metricsOf({ step: 1, toolWall: 300, tool: 400 }),
      metricsOf({ step: 2, toolWall: 200, tool: 250 }),
      metricsOf({ step: 3 }),
    ])
    expect(turn.toolWall).toBe(500)
    expect(turn.tool).toBe(650)
    expect(aggregateTurn(5, [metricsOf(), metricsOf({ step: 2 })]).toolWall).toBeNull()
  })

  it('never confuses the summed tool time with the wall union', () => {
    const turn = aggregateTurn(6, [metricsOf({ step: 1, tool: 200, toolWall: 100 })])
    expect(turn.tool).toBe(200)
    expect(turn.toolWall).toBe(100)
  })

  it('sums retries, tool errors, and tool output', () => {
    const turn = aggregateTurn(5, [
      metricsOf({ step: 1, retries: 1, toolErrors: 2, toolOutput: 10 }),
      metricsOf({ step: 2, retries: 2, toolErrors: 3, toolOutput: 5 }),
    ])
    expect(turn.retries).toBe(3)
    expect(turn.toolErrors).toBe(5)
    expect(turn.toolOutput).toBe(15)
    const unrecorded = aggregateTurn(5, [
      metricsOf({ step: 1, toolOutput: null }),
      metricsOf({ step: 2, toolOutput: 4 }),
    ])
    expect(unrecorded.toolOutput).toBe(4)
  })

  it('merges tool tallies across steps', () => {
    const turn = aggregateTurn(6, [
      metricsOf({ step: 1, tools: [{ name: 'read', count: 1 }] }),
      metricsOf({ step: 2, tools: [{ name: 'read', count: 2 }, { name: 'grep', count: 1 }] }),
    ])
    expect(turn.tools).toEqual([{ name: 'read', count: 3 }, { name: 'grep', count: 1 }])
    const tied = aggregateTurn(6, [
      metricsOf({ step: 1, tools: [{ name: 'read', count: 1 }, { name: 'grep', count: 1 }] }),
    ])
    expect(tied.tools).toEqual([{ name: 'read', count: 1 }, { name: 'grep', count: 1 }])
  })

  it('measures turn wall time only from a settled last step with a start', () => {
    const first = metricsOf({ step: 1, startTime: 1_000 })
    const last = metricsOf({ step: 2, startTime: 2_000, endTime: 3_000 })
    expect(aggregateTurn(1, [first, last]).wall).toBe(2_000)
    expect(aggregateTurn(1, [first, { ...last, running: true }]).wall).toBeNull()
    expect(aggregateTurn(1, [{ ...first, startTime: null }, last]).wall).toBeNull()
    expect(aggregateTurn(1, [first, { ...last, endTime: null }]).wall).toBeNull()
    expect(aggregateTurn(1, [first, { ...last, endTime: 500 }]).wall).toBe(0)
  })

  it('reports last-step liveness and any interruption in the turn', () => {
    const running = aggregateTurn(1, [
      metricsOf({ step: 1, running: false }),
      metricsOf({ step: 2, running: true }),
    ])
    expect(running.running).toBe(true)
    const interrupted = aggregateTurn(2, [
      metricsOf({ step: 1, interrupted: true }),
      metricsOf({ step: 2, aborted: true }),
    ])
    expect(interrupted.interrupted).toBe(true)
    expect(interrupted.aborted).toBe(true)
  })

  it('describes the turn prompt as absent until the table attributes it', () => {
    const turn = aggregateTurn(2, [metricsOf()])
    expect(turn.prompt).toBeNull()
    expect(turn.promptImages).toEqual([])
    expect(turn.steps).toHaveLength(1)
  })
})

describe('turn grouping', () => {
  it('groups steps into turns ordered oldest first with their markers', () => {
    const one = metricsOf({ turn: 8, step: 2, startTime: 20_000 })
    const two = metricsOf({ turn: 8, step: 1, startTime: 19_000 })
    const later = metricsOf({ turn: 9, step: 1, startTime: 30_000 })
    const turns = buildTurns([
      stepNode(later),
      stepNode(one),
      stepNode(two),
      promptNode(8, '问题', [imageRef('sha256:a'), imageRef('sha256:b')]),
      endNode(9, 31_000, 'interrupted'),
    ])
    expect(turns.map(turn => turn.turn)).toEqual([8, 9])
    expect(turns[0]?.steps.map(step => step.step)).toEqual([1, 2])
    expect(turns[0]?.prompt).toBe('问题')
    expect(turns[0]?.promptImages).toEqual([imageRef('sha256:a'), imageRef('sha256:b')])
    expect(turns[1]?.interrupted).toBe(true)
  })

  it('returns no turn for markers without a step', () => {
    expect(buildTurns([])).toEqual([])
    expect(buildTurns([promptNode(5, 'orphan'), endNode(5, 1_000, 'interrupted')])).toEqual([])
  })

  it('ignores blank prompt markers and end markers without detail', () => {
    const step = metricsOf({ turn: 1, step: 1, startTime: 1_000, running: true })
    const turns = buildTurns([
      stepNode(step),
      promptNode(1, null),
      promptNode(1, ''),
      endNode(1, Number.NaN, null),
    ])
    expect(turns).toHaveLength(1)
    expect(turns[0]?.prompt).toBeNull()
    expect(turns[0]?.promptImages).toEqual([])
    expect(turns[0]?.running).toBe(true)
  })

  it('keeps the first non-blank prompt of a turn', () => {
    const step = metricsOf({ turn: 1, step: 1 })
    const turns = buildTurns([
      stepNode(step),
      promptNode(1, null),
      promptNode(1, 'first', [imageRef('sha256:a'), imageRef('sha256:b'), imageRef('sha256:c')]),
      promptNode(1, 'second', [imageRef('sha256:d')]),
    ])
    expect(turns[0]?.prompt).toBe('first')
    expect(turns[0]?.promptImages).toHaveLength(3)
  })

  it('classifies the turn trigger and prefers the human prompt', () => {
    const step = metricsOf({ turn: 1, step: 1, startTime: 100 })
    const human = buildTurns([
      stepNode(step),
      promptNode(1, 'team message', [], 'agent-message'),
      promptNode(1, 'human question', [imageRef('sha256:a'), imageRef('sha256:b')], 'user'),
    ])
    expect(human[0]?.prompt).toBe('human question')
    expect(human[0]?.promptSource).toBe('user')

    const team = buildTurns([
      stepNode(metricsOf({ turn: 2, step: 1, startTime: 200 })),
      promptNode(2, 'team message', [], 'agent-message'),
    ])
    expect(team[0]?.prompt).toBe('team message')
    expect(team[0]?.promptSource).toBe('agent-message')

    const teamMessage = buildTurns([
      stepNode(metricsOf({ turn: 8, step: 1, startTime: 800 })),
      promptNode(8, 'team body', [], 'team-message'),
      promptNode(8, 'agent body', [], 'agent-message'),
    ])
    expect(teamMessage[0]?.promptSource).toBe('team-message')

    const automation = ['schedule', 'webhook', 'tool-jobs', 'cordis-host-runner'].map((source, index) => {
      const turn = buildTurns([
        stepNode(metricsOf({ turn: 20 + index, step: 1, startTime: 2_000 + index })),
        promptNode(20 + index, source, [], source),
      ])
      return turn[0]?.promptSource
    })
    expect(automation).toEqual(['schedule', 'webhook', 'tool-jobs', 'cordis-host-runner'])

    const settled = buildTurns([
      stepNode(metricsOf({ turn: 3, step: 1, startTime: 300 })),
      promptNode(3, 'subagent done', [], 'subagent-settled'),
    ])
    expect(settled[0]?.promptSource).toBe('subagent-settled')

    const goal = buildTurns([
      stepNode(metricsOf({ turn: 4, step: 1, startTime: 400 })),
      promptNode(4, 'goal round', [], 'goal'),
      promptNode(4, '', [], 'goal'),
    ])
    expect(goal[0]?.promptSource).toBe('goal')
    expect(goal[0]?.prompt).toBe('goal round')

    const context = buildTurns([
      stepNode(metricsOf({ turn: 5, step: 1, startTime: 500 })),
      promptNode(5, 'clock', [], 'time-context'),
    ])
    expect(context[0]?.promptSource).toBe('time-context')
  })

  it('carries the last measured answer preview into the turn', () => {
    expect(aggregateTurn(1, []).answer).toBeNull()
    expect(aggregateTurn(1, [metricsOf({ answer: 'first' })]).answer).toBe('first')
    expect(aggregateTurn(1, [
      metricsOf({ step: 1, answer: 'first' }),
      metricsOf({ step: 2 }),
      metricsOf({ step: 3, answer: 'third' }),
    ]).answer).toBe('third')
  })

  it('skips a step whose turn number is not a number', () => {
    const turns = buildTurns([
      stepNode(metricsOf({ turn: Number.NaN, step: 1 })),
      stepNode(metricsOf({ turn: 2, step: 1 })),
      promptNode(2, 'q'),
    ])
    expect(turns.map(turn => turn.turn)).toEqual([2])
  })

  it('clears running before a later step without mutating the input', () => {
    const first = metricsOf({ turn: 1, step: 1, running: true })
    const second = metricsOf({ turn: 1, step: 2, running: true })
    const third = metricsOf({ turn: 1, step: 3, running: true })
    const turns = buildTurns([stepNode(first), stepNode(second), stepNode(third), promptNode(1, 'q')])
    expect(turns[0]?.steps.map(step => step.running)).toEqual([false, false, true])
    expect(first.running).toBe(true)
    expect(turns[0]?.running).toBe(true)
  })

  it('clears running when a later turn follows', () => {
    const turns = buildTurns([
      stepNode(metricsOf({ turn: 1, step: 1, running: true })),
      promptNode(1, 'q'),
      stepNode(metricsOf({ turn: 2, step: 1, running: true })),
      promptNode(2, 'q'),
    ])
    expect(turns[0]?.running).toBe(false)
    expect(turns[1]?.running).toBe(true)
  })

  it('drops the empty step an interruption appends', () => {
    const one = metricsOf({ turn: 11, step: 1, startTime: 50_000, context: 300 })
    for (const wall of [0, null]) {
      const empty = metricsOf({ turn: 11, step: 2, wall })
      const turns = buildTurns([
        stepNode(one),
        stepNode(empty),
        endNode(11, 51_000, 'interrupted'),
      ])
      expect(turns[0]?.steps, String(wall)).toHaveLength(1)
      expect(turns[0]?.steps[0]?.wall).toBe(1_000)
      expect(turns[0]?.steps[0]?.aborted).toBe(true)
    }
  })

  it('keeps a tail step that still measured something', () => {
    const variants: readonly StatsStepMetrics[] = [
      metricsOf({ turn: 12, step: 2, context: 5 }),
      metricsOf({ turn: 12, step: 2, ttft: 5 }),
      metricsOf({ turn: 12, step: 2, model: 5 }),
      metricsOf({ turn: 12, step: 2, tool: 0 }),
      metricsOf({ turn: 12, step: 2, toolPending: 1 }),
      metricsOf({ turn: 12, step: 2, tools: [{ name: 'read', count: 1 }] }),
      metricsOf({ turn: 12, step: 2, wall: 5 }),
    ]
    for (const tail of variants) {
      const turns = buildTurns([
        stepNode(metricsOf({ turn: 12, step: 1, startTime: 1_000, context: 10 })),
        stepNode(tail),
        endNode(12, 2_000, 'interrupted'),
      ])
      expect(turns[0]?.steps, JSON.stringify(tail)).toHaveLength(2)
    }
  })

  it('closes an interrupted tail at the turn end time', () => {
    const open = metricsOf({ turn: 13, step: 1, startTime: 1_000, running: true })
    const turns = buildTurns([stepNode(open), endNode(13, 4_000, 'interrupted')])
    const closed = turns[0]?.steps[0]
    expect(closed?.endTime).toBe(4_000)
    expect(closed?.wall).toBe(3_000)
    expect(closed?.running).toBe(false)
    expect(closed?.aborted).toBe(true)
    expect(turns[0]?.wall).toBe(3_000)
    expect(turns[0]?.running).toBe(false)
  })

  it('closes a tail with no start time without inventing a duration', () => {
    const open = metricsOf({ turn: 14, step: 1, running: true })
    const turns = buildTurns([stepNode(open), endNode(14, 4_000, null)])
    expect(turns[0]?.steps[0]?.endTime).toBe(4_000)
    expect(turns[0]?.steps[0]?.wall).toBeNull()
    expect(turns[0]?.interrupted).toBe(false)
  })

  it('leaves a tail that already ended untouched', () => {
    const settled = metricsOf({ turn: 15, step: 1, startTime: 1_000, endTime: 1_500 })
    const turns = buildTurns([stepNode(settled), endNode(15, 4_000, 'completed')])
    expect(turns[0]?.steps[0]?.endTime).toBe(1_500)
    expect(turns[0]?.steps[0]?.wall).toBeNull()
    expect(turns[0]?.wall).toBe(500)
  })

  it('prefers the interruption close kind over the step flags', () => {
    const done = metricsOf({ turn: 16, step: 1, interrupted: true })
    const interrupted = buildTurns([stepNode(done), endNode(16, 1_000, 'interrupted')])
    expect(interrupted[0]?.interrupted).toBe(true)
    const unrelated = buildTurns([stepNode(done), endNode(16, 1_000, 'completed')])
    expect(unrelated[0]?.interrupted).toBe(true)
    const quiet = buildTurns([stepNode(metricsOf({ turn: 17, step: 1 })), promptNode(17, 'q')])
    expect(quiet[0]?.interrupted).toBe(false)
  })
})

describe('Code-Mode contribution merging', () => {
  it('replaces the runner with the real tools and recomputes the totals', () => {
    const runner = statsCall('root', 1, { name: 'run_code', chars: 500 })
    const step = metricsOf({
      turn: 2,
      step: 1,
      calls: [runner],
      tools: [{ name: 'run_code', count: 1 }],
      toolOutput: 500,
      toolWall: 400,
      toolErrors: 1,
      tool: 200,
    })
    const inner = innerNode(2, 1, [
      statsCall('sub-1', 2, {
        name: 'grep', chars: 20, inner: true, startedAt: 1_100, endedAt: 1_150,
      }),
      statsCall('sub-2', 3, {
        name: 'read', chars: 5, inner: true, error: true, startedAt: 1_200, endedAt: 1_300,
      }),
      statsCall('sub-3', 4, { name: null, inner: true, chars: null }),
    ])
    const turns = buildTurns([stepNode(step), promptNode(2, 'q'), inner])
    const merged = turns[0]?.steps[0]
    expect(merged?.calls.map(call => call.callId)).toEqual(['sub-1', 'sub-2', 'sub-3'])
    expect(merged?.tools).toEqual([{ name: 'grep', count: 1 }, { name: 'read', count: 1 }])
    expect(merged?.toolOutput).toBe(25)
    expect(merged?.toolWall).toBe(150)
    expect(merged?.toolErrors).toBe(2)
    expect(merged?.tool).toBe(200)
    expect(turns[0]?.tools).toEqual([{ name: 'grep', count: 1 }, { name: 'read', count: 1 }])
    expect(turns[0]?.toolErrors).toBe(2)
    expect(turns[0]?.toolWall).toBe(150)
  })

  it('merges every root contribution of one step in sequence order', () => {
    const step = metricsOf({ turn: 3, step: 1 })
    const turns = buildTurns([
      stepNode(step),
      promptNode(3, 'q'),
      innerNode(3, 1, [statsCall('late', 5, { name: 'write', inner: true, chars: 2 })]),
      innerNode(3, 1, [statsCall('early', 2, { name: 'grep', inner: true, chars: 3 })]),
    ])
    expect(turns[0]?.steps[0]?.calls.map(call => call.callId)).toEqual(['early', 'late'])
    expect(turns[0]?.steps[0]?.toolOutput).toBe(5)
  })

  it('caps the merged call list at the table limit', () => {
    const step = metricsOf({ turn: 4, step: 1 })
    const calls = Array.from({ length: CALL_LIMIT + 3 }, (_, index) => statsCall(
      `inner-${index}`,
      index + 1,
      { inner: true, name: 'read', chars: index + 1 },
    ))
    const turns = buildTurns([stepNode(step), promptNode(4, 'q'), innerNode(4, 1, calls)])
    expect(turns[0]?.steps[0]?.calls).toHaveLength(CALL_LIMIT)
    expect(turns[0]?.steps[0]?.calls[0]?.callId).toBe('inner-0')
    expect(turns[0]?.steps[0]?.calls.at(-1)?.callId).toBe(`inner-${CALL_LIMIT - 1}`)
    expect(turns[0]?.steps[0]?.toolOutput).toBe(
      Array.from({ length: CALL_LIMIT }, (_, index) => index + 1).reduce((sum, value) => sum + value, 0),
    )
  })

  it('keeps the runner when no inner contribution arrived', () => {
    const runner = statsCall('root', 1, { name: 'run_code', chars: 500 })
    const turns = buildTurns([stepNode(metricsOf({
      turn: 5,
      step: 1,
      calls: [runner],
      tools: [{ name: 'run_code', count: 1 }],
      toolOutput: 500,
    })), promptNode(5, 'q')])
    expect(turns[0]?.steps[0]?.calls.map(call => call.callId)).toEqual(['root'])
    expect(turns[0]?.tools).toEqual([{ name: 'run_code', count: 1 }])
  })

  it('ignores inner contributions for steps the window no longer holds', () => {
    const step = metricsOf({ turn: 6, step: 1, toolOutput: 7 })
    const turns = buildTurns([stepNode(step), promptNode(6, 'q'), innerNode(6, 2, [statsCall('sub', 2, {
      name: 'grep', chars: 9, inner: true,
    })])])
    expect(turns[0]?.steps).toHaveLength(1)
    expect(turns[0]?.steps[0]?.calls).toEqual([])
    expect(turns[0]?.toolOutput).toBe(7)
  })
})
