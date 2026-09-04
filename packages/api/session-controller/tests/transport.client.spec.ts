import { describe, expect, it, vi } from 'vitest'
import {
  RemoteStream,
  RemoteStreamCarrierError,
  type RemoteStreamOptions,
} from '@deepseek-ai/dsh-api-gateway/client'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { LlmAttemptId } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import {
  createSessionControlStream,
  SessionEventStream,
  type SessionJournalChange,
  type SessionRemote,
} from '../src/client/index.ts'
import type { SessionRemotes } from '../src/client/sessions/remotes.ts'
import type {
  SessionAddress,
  SessionAssistantStreamBaseline,
  SessionAssistantStreamFrame,
  SessionControlFrame,
  SessionEventEntry,
  SessionFollowFrame,
  SessionFollowRequest,
  SessionHistoryRecord,
  SessionPage,
  SessionPageRequest,
} from '../src/types.ts'

type SessionTransportRemote = Pick<SessionRemote, 'control' | 'follow' | 'page'>

const ADDRESS: SessionAddress = { kind: 'session', sessionId: 'session-1' as never }
const AVAILABLE_CONNECTION = {
  generation: {
    getSnapshot: () => ({ id: 1, host: { home: '/home/fixture' } }),
    subscribe: () => () => {},
  },
}

function entry(seq: number): SessionEventEntry {
  return { type: 'event', event: { type: 'turn/start', seq, time: seq, data: { turn: seq } } }
}

function page(records: readonly SessionHistoryRecord[], hasMore = false): SessionPage {
  return { records, hasMore }
}

function snapshot(
  cursor: number,
  records: readonly SessionHistoryRecord[],
  hasMore = false,
  assistantStream: SessionAssistantStreamBaseline = { revision: 0 },
): SessionFollowFrame {
  return {
    type: 'snapshot',
    header: {
      version: SESSION_FORMAT_VERSION,
      id: ADDRESS.kind === 'session' ? ADDRESS.sessionId : ADDRESS.childSessionId,
      createdAt: 0,
      isSeeded: false,
    },
    cursor,
    records,
    hasMore,
    projections: { asOfSeq: cursor, values: {} },
    assistantStream,
  }
}

function assistantFrame(frame: SessionAssistantStreamFrame): SessionFollowFrame {
  return { type: 'assistant-stream', frame }
}

function sessionClient(remote: SessionTransportRemote): SessionRemotes {
  return {
    session: remote as SessionRemote,
    $stream: <Item>(options: RemoteStreamOptions<Item>) => (
      new RemoteStream(AVAILABLE_CONNECTION, options)
    ),
    commands: { execute: () => Promise.reject(new Error('stream tests never run commands')) },
    subagents: {
      list: () => Promise.reject(new Error('stream tests never read the subagent catalog')),
      prompt: () => Promise.reject(new Error('stream tests never prompt a subagent')),
      interruptByParent: () => Promise.reject(new Error('stream tests never interrupt a subagent')),
    },
  }
}

interface FollowGeneration {
  readonly frames: readonly SessionFollowFrame[]
  readonly terminal?: Error
  readonly hold?: boolean
  readonly waitAfterFrames?: Promise<void>
}

class ScriptedSessionRemote implements SessionTransportRemote {
  readonly followRequests: SessionFollowRequest[] = []
  readonly pageRequests: SessionPageRequest[] = []
  readonly signals: AbortSignal[] = []

  constructor(
    private readonly generations: FollowGeneration[],
    private readonly pages: RemoteResult<SessionPage>[],
    private readonly controlFrames: readonly SessionControlFrame[] = [],
    private readonly holdControl = true,
  ) {}

  async *follow(request: SessionFollowRequest, signal = new AbortController().signal): AsyncIterable<SessionFollowFrame> {
    const generation = this.generations.shift()
    if (generation === undefined) throw new Error('no scripted Session generation')
    this.followRequests.push(request)
    this.signals.push(signal)
    for (const frame of generation.frames) yield frame
    await generation.waitAfterFrames
    if (generation.terminal !== undefined) throw generation.terminal
    if (generation.hold === true && !signal.aborted) {
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
    }
  }

  page(request: SessionPageRequest): Promise<RemoteResult<SessionPage>> {
    this.pageRequests.push(request)
    const result = this.pages.shift()
    if (result === undefined) throw new Error('no scripted Session page')
    return Promise.resolve(result)
  }

  async *control(signal = new AbortController().signal): AsyncIterable<SessionControlFrame> {
    for (const frame of this.controlFrames) yield frame
    if (this.holdControl && !signal.aborted) {
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
    }
  }
}

describe('Session Client stream adapters', () => {
  it('opts into assistant notifications and publishes the reconnect baseline plus live frame', async () => {
    const attemptId = LlmAttemptId('transport-attempt')
    const baseline: SessionAssistantStreamBaseline = {
      revision: 2,
      activeAttempt: {
        attemptId,
        startedAfterSeq: -1,
        turn: 1,
        step: 1,
        nextIndex: 1,
        stream: [{ type: 'text-chunks', time0: 0, index: 0, dt: [], texts: ['a'] }],
      },
    }
    const frame: SessionAssistantStreamFrame = {
      type: 'chunk', attemptId, revision: 3, index: 1,
      time: 1, chunk: { type: 'text-delta', index: 0, text: 'b' },
    }
    const remote = new ScriptedSessionRemote(
      [{ frames: [snapshot(0, [entry(0)], false, baseline), assistantFrame(frame)], hold: true }],
      [],
    )
    const changes: SessionJournalChange[] = []
    const stream = new SessionEventStream(sessionClient(remote), ADDRESS, {
      publish: (change) => { changes.push(change) },
      failed: vi.fn(),
    })

    await stream.open({})
    await vi.waitFor(() => { expect(changes).toHaveLength(2) })

    expect(remote.followRequests).toEqual([{ address: ADDRESS, assistantStream: true }])
    expect(changes).toMatchObject([
      { type: 'replace', page: { assistantStream: baseline } },
      { type: 'assistant-stream', frame },
    ])
    await stream.dispose()
  })

  it('rejects an opted-in opening that omits its Assistant baseline', async () => {
    const remote = new ScriptedSessionRemote([{
      frames: [{
        type: 'snapshot',
        header: {
          version: SESSION_FORMAT_VERSION,
          id: ADDRESS.sessionId,
          createdAt: 0,
          isSeeded: false,
        },
        cursor: -1,
        records: [],
        hasMore: false,
        projections: { asOfSeq: -1, values: {} },
      }],
    }], [])
    const stream = new SessionEventStream(sessionClient(remote), ADDRESS, {
      publish: vi.fn(),
      failed: vi.fn(),
    })

    try {
      await expect(stream.open({})).rejects.toMatchObject({
        code: 'gateway/internal',
        message: 'session assistant stream omitted its opted-in opening baseline',
      })
    } finally {
      await stream.dispose()
    }
  })

  it('rejects an Assistant frame that arrives before the opening baseline', async () => {
    const remote = new ScriptedSessionRemote([{
      frames: [assistantFrame({
        type: 'start', attemptId: LlmAttemptId('pre-opening-attempt'),
        revision: 1, startedAfterSeq: -1, turn: 1, step: 1,
      })],
    }], [])
    const stream = new SessionEventStream(sessionClient(remote), ADDRESS, {
      publish: vi.fn(),
      failed: vi.fn(),
    })

    try {
      await expect(stream.open({})).rejects.toMatchObject({
        code: 'gateway/internal',
        message: 'session event stream emitted an entry before its opening cursor',
      })
      expect(remote.followRequests).toEqual([{ address: ADDRESS, assistantStream: true }])
    } finally {
      await stream.dispose()
    }
  })

  it('rebaselines after a transient assistant revision gap without advancing the durable cursor', async () => {
    const attemptId = LlmAttemptId('gapped-attempt')
    const start: SessionAssistantStreamFrame = {
      type: 'start', attemptId, revision: 1, startedAfterSeq: -1,
      turn: 1, step: 1,
    }
    const gap: SessionAssistantStreamFrame = {
      type: 'chunk', attemptId, revision: 3, index: 0,
      time: 1, chunk: { type: 'text-delta', index: 0, text: 'lost predecessor' },
    }
    const replacement: SessionAssistantStreamBaseline = {
      revision: 3,
      activeAttempt: {
        attemptId,
        startedAfterSeq: -1,
        turn: 1,
        step: 1,
        nextIndex: 1,
        stream: [{ type: 'text-chunks', time0: 1, index: 0, dt: [], texts: ['lost predecessor'] }],
      },
    }
    const remote = new ScriptedSessionRemote([
      {
        frames: [snapshot(0, [entry(0)]), assistantFrame(start), assistantFrame(gap)],
      },
      { frames: [snapshot(0, [entry(0)], false, replacement)], hold: true },
    ], [])
    const changes: SessionJournalChange[] = []
    const carrierFailed = vi.fn()
    const stream = new SessionEventStream(sessionClient(remote), ADDRESS, {
      publish: (change) => { changes.push(change) },
      carrierFailed,
      failed: vi.fn(),
    })

    await stream.open({})
    await vi.waitFor(() => { expect(remote.followRequests).toHaveLength(2) })

    expect(changes.map(change => change.type)).toEqual([
      'replace', 'assistant-stream', 'replace',
    ])
    expect(changes.at(-1)).toMatchObject({
      type: 'replace', page: { assistantStream: replacement },
    })
    expect(remote.pageRequests).toEqual([])
    expect(carrierFailed).toHaveBeenCalledWith(expect.objectContaining({
      message: 'session assistant stream skipped revision 2',
    }))
    await stream.dispose()
  })

  it('rebaselines when a replacement Agent lifecycle restarts at revision one', async () => {
    const attemptId = LlmAttemptId('replacement-lifecycle-attempt')
    const previous: SessionAssistantStreamBaseline = {
      revision: 2,
      activeAttempt: {
        attemptId,
        startedAfterSeq: -1,
        turn: 1,
        step: 1,
        nextIndex: 1,
        stream: [{ type: 'text-chunks', time0: 1, index: 0, dt: [], texts: ['old'] }],
      },
    }
    const replacementStart: SessionAssistantStreamFrame = {
      type: 'start', attemptId, revision: 1, startedAfterSeq: -1,
      turn: 2, step: 1,
    }
    const replacement: SessionAssistantStreamBaseline = {
      revision: 1,
      activeAttempt: {
        attemptId,
        startedAfterSeq: -1,
        turn: 2,
        step: 1,
        nextIndex: 0,
        stream: [],
      },
    }
    const remote = new ScriptedSessionRemote([
      {
        frames: [snapshot(0, [entry(0)], false, previous), assistantFrame(replacementStart)],
      },
      { frames: [snapshot(0, [entry(0)], false, replacement)], hold: true },
    ], [])
    const changes: SessionJournalChange[] = []
    const carrierFailed = vi.fn()
    const stream = new SessionEventStream(sessionClient(remote), ADDRESS, {
      publish: (change) => { changes.push(change) },
      carrierFailed,
      failed: vi.fn(),
    })

    try {
      await stream.open({})
      await vi.waitFor(() => { expect(remote.followRequests).toHaveLength(2) })
      expect(changes).toMatchObject([
        { type: 'replace', page: { assistantStream: previous } },
        { type: 'replace', page: { assistantStream: replacement } },
      ])
      expect(carrierFailed).toHaveBeenCalledWith(expect.objectContaining({
        message: 'session assistant stream skipped revision 3',
      }))
    } finally {
      await stream.dispose()
    }
  })

  it('validates one scalar current-event range before publishing Client entries', async () => {
    const remote = new ScriptedSessionRemote(
      [{ frames: [snapshot(2, [entry(0), entry(1), entry(2)]), entry(3)], hold: true }],
      [],
    )
    const changes: SessionJournalChange[] = []
    const stream = new SessionEventStream(sessionClient(remote), ADDRESS, {
      publish: (change) => { changes.push(change) },
      failed: vi.fn(),
    })

    await stream.open({})
    await vi.waitFor(() => { expect(changes).toHaveLength(2) })

    expect(changes[0]).toMatchObject({
      type: 'replace',
      entries: [
        entry(0),
        entry(1),
        entry(2),
      ],
    })
    expect(changes[1]).toEqual({ type: 'append', entry: entry(3) })
    await stream.dispose()
  })

  it('binds an event journal to one address and publishes replace, append, and prepend changes', async () => {
    const remote = new ScriptedSessionRemote(
      [{
        frames: [
          snapshot(3, [entry(2), entry(3)], true),
          entry(3),
          entry(4),
        ],
        hold: true,
      }],
      [
        { ok: true, value: page([entry(0), entry(1)], false) },
      ],
    )
    const changes: SessionJournalChange[] = []
    const stream = new SessionEventStream(sessionClient(remote), ADDRESS, {
      publish: (change) => { changes.push(change) },
      failed: vi.fn(),
    })

    await stream.open({ maxMessages: 50 })
    await vi.waitFor(() => { expect(changes).toHaveLength(2) })
    await stream.prepend({ beforeSeq: 2, maxMessages: 50 })

    expect(remote.followRequests).toEqual([{
      address: ADDRESS, assistantStream: true, maxMessages: 50,
    }])
    expect(remote.pageRequests).toEqual([
      { address: ADDRESS, throughSeq: 4, beforeSeq: 2, maxMessages: 50 },
    ])
    expect(changes).toMatchObject([
      { type: 'replace', entries: [entry(2), entry(3)], hasMore: true },
      { type: 'append', entry: entry(4) },
      { type: 'prepend', entries: [entry(0), entry(1)], hasMore: false },
    ])
    await stream.dispose()
    expect(remote.signals[0]?.aborted).toBe(true)
  })

  it('replaces the retained window from each reconnect snapshot', async () => {
    const lost = new RemoteStreamCarrierError('lost')
    const remote = new ScriptedSessionRemote(
      [
        {
          frames: [snapshot(1, [entry(0), entry(1)]), entry(2)],
          terminal: lost,
        },
        { frames: [snapshot(4, [entry(0), entry(1), entry(2), entry(3), entry(4)])], hold: true },
      ],
      [],
    )
    const changes: SessionJournalChange[] = []
    const carrierFailed = vi.fn()
    const stream = new SessionEventStream(sessionClient(remote), ADDRESS, {
      publish: (change) => { changes.push(change) },
      carrierFailed,
      failed: vi.fn(),
    })

    await stream.open({ maxMessages: 50 })
    await vi.waitFor(() => { expect(remote.followRequests).toHaveLength(2) })

    expect(remote.followRequests).toEqual([
      { address: ADDRESS, assistantStream: true, maxMessages: 50 },
      { address: ADDRESS, assistantStream: true, maxMessages: 50 },
    ])
    expect(remote.pageRequests).toEqual([])
    expect(changes.map(change => change.type)).toEqual(['replace', 'append', 'replace'])
    expect(carrierFailed).toHaveBeenCalledWith(lost)
    await stream.dispose()
  })

  it('repairs a resumed event stream without an optional message limit', async () => {
    const finish = Promise.withResolvers<undefined>()
    const remote = new ScriptedSessionRemote(
      [
        {
          frames: [snapshot(0, [entry(0)])],
          waitAfterFrames: finish.promise,
          terminal: new RemoteStreamCarrierError('lost'),
        },
        { frames: [snapshot(1, [entry(0), entry(1)])], hold: true },
      ],
      [],
    )
    const stream = new SessionEventStream(sessionClient(remote), ADDRESS, {
      publish: vi.fn(),
      failed: vi.fn(),
    })

    await stream.open({})
    finish.resolve(undefined)
    await vi.waitFor(() => { expect(remote.followRequests).toHaveLength(2) })
    expect(remote.followRequests).toEqual([
      { address: ADDRESS, assistantStream: true },
      { address: ADDRESS, assistantStream: true },
    ])
    expect(remote.pageRequests).toEqual([])
    await stream.dispose()
  })

  it('repairs a live gap without adding an absent message limit', async () => {
    const remote = new ScriptedSessionRemote(
      [{ frames: [snapshot(0, [entry(0)]), entry(2)], hold: true }],
      [{ ok: true, value: page([entry(0), entry(1), entry(2)]) }],
    )
    const changes: SessionJournalChange[] = []
    const stream = new SessionEventStream(sessionClient(remote), ADDRESS, {
      publish: (change) => { changes.push(change) },
      failed: vi.fn(),
    })

    await stream.open({})
    await vi.waitFor(() => { expect(changes).toHaveLength(2) })
    expect(remote.pageRequests).toEqual([{ address: ADDRESS, throughSeq: 2 }])
    await stream.dispose()
  })

  it('turns a pagination failure into a typed stream failure', async () => {
    const failure = new RemoteError('session/not-found', 'missing', { sessionId: 'session-1' as never })
    const remote = new ScriptedSessionRemote(
      [{ frames: [snapshot(-1, [])], hold: true }],
      [{ ok: false, error: failure }],
    )
    const stream = new SessionEventStream(sessionClient(remote), ADDRESS, {
      publish: vi.fn(),
      failed: vi.fn(),
    })

    await stream.open({})
    await expect(stream.prepend({})).rejects.toMatchObject({ code: 'session/not-found' })
    await expect(stream.open({})).rejects.toThrow('already opened')
    expect(remote.signals[0]?.aborted).toBe(false)
    expect(remote.pageRequests).toEqual([{ address: ADDRESS, throughSeq: -1 }])
    await stream.dispose()
    expect(remote.signals[0]?.aborted).toBe(true)
  })

  it('maps the Host-wide control baseline and deltas into one snapshot stream', async () => {
    const baseline: SessionControlFrame = {
      type: 'baseline',
      value: { queues: {}, jobs: {}, projections: {} },
    }
    const update: SessionControlFrame = {
      type: 'queue', sessionId: 'session-1' as never, items: [],
    }
    const remote = new ScriptedSessionRemote([], [], [baseline, update])
    const accept = vi.fn<(frame: SessionControlFrame) => void>()
    const stream = createSessionControlStream(sessionClient(remote), {
      accept,
      failed: vi.fn(),
    })

    stream.start()
    stream.start()
    await vi.waitFor(() => { expect(accept).toHaveBeenCalledTimes(2) })
    expect(accept.mock.calls.map(([frame]) => frame)).toEqual([baseline, update])
    await stream.dispose()
    await stream.dispose()
  })

  it('classifies control streams that end before and after their opening baseline', async () => {
    const beforeFailed = vi.fn()
    const before = createSessionControlStream(
      sessionClient(new ScriptedSessionRemote([], [], [], false)),
      { accept: vi.fn(), failed: beforeFailed },
    )
    before.start()
    await vi.waitFor(() => { expect(beforeFailed).toHaveBeenCalledOnce() })
    expect(beforeFailed.mock.calls[0]?.[0]).toMatchObject({
      message: 'session control stream ended before its opening snapshot',
    })
    await before.dispose()

    const baseline: SessionControlFrame = {
      type: 'baseline',
      value: { queues: {}, jobs: {}, projections: {} },
    }
    const carrierFailed = vi.fn()
    const failed = vi.fn()
    const afterRemote = new ScriptedSessionRemote([], [], [baseline], false)
    const after = createSessionControlStream(sessionClient(afterRemote), {
      accept: vi.fn(),
      carrierFailed: (error) => {
        carrierFailed(error)
        void after.dispose()
      },
      failed,
    })
    after.start()
    await vi.waitFor(() => { expect(carrierFailed).toHaveBeenCalledOnce() })
    expect(carrierFailed.mock.calls[0]?.[0]).toMatchObject({
      message: 'session control stream ended without a terminal result',
    })
    expect(failed).not.toHaveBeenCalled()
    await after.dispose()
  })
})
