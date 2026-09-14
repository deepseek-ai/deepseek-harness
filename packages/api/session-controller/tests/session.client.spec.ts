/**
 * Session object lifecycle, event-window transport, commands, and resync
 * behavior, driven through the assembled client: every Remote call a Session
 * makes crosses the roster's own Connection through the tier's `remote.<ns>`
 * proxies and is answered by endpoint name.
 */

import { describe, expect, vi } from 'vitest'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { RemoteStreamCarrierError } from '@deepseek-ai/dsh-api-gateway/client'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { ok, type RemoteMock } from '@deepseek-ai/dsh-remote-mock'
import { createClientTest, type TestClient, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import { JUMP_PAGE_MESSAGES, type Session } from '../src/client/sessions/session.ts'
import { SessionEventStream } from '../src/client/transport.ts'
import type { SessionFollowRequest, SessionPage, SessionPageRequest } from '../src/types.ts'
import { entries, ev, historyValue, plainTurn } from './event-script.client.ts'
import { sessionBench } from './remote/bench.client.ts'
import {
  FOLLOW, PAGE, err, followScript, followSnapshot, frame, history, pageRule, pushEvent,
} from './remote/session.client.ts'

/** A Session talks through the Gateway client; its dependency cone is the Typert registry and the Connection. */
const API_ROSTER = webApp.closure(['@deepseek-ai/dsh-api-gateway'])
const it = createClientTest({ roster: API_ROSTER })
const SID = 'fk-s1' as SessionId
const PARENT = 'fk-parent' as SessionId
const ADDRESS = { kind: 'session', sessionId: SID } as const
const TIME_ZONE = new Intl.DateTimeFormat().resolvedOptions().timeZone
/** The first client boot pays the cold module transform of the api cone. */
const COLD_BOOT_TIMEOUT_MS = 60_000

function windowEntries(session: Session) {
  return session.eventSource.getSnapshot().entries
}

function eventSeqs(session: Session): number[] {
  return windowEntries(session).map(entry => entry.event.seq)
}

describe('Session open', () => {
  it('keeps a bare Session blank until an authoritative lifecycle signal arrives', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    expect(session.getSnapshot()).toMatchObject({ blank: true, promptAttempted: false, running: false })

    session.handleRunning(true)
    expect(session.getSnapshot()).toMatchObject({ blank: false, running: true })
  }, COLD_BOOT_TIMEOUT_MS)

  it('installs the tail page: cold → loading → open with window and nodes in place', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    const page = plainTurn(SessionSeq(10), 3, '问', '答')
    mock.stream(FOLLOW, followScript(history(page, true)))
    expect(session.getSnapshot().openState).toBe('cold')
    const opening = session.open()
    expect(session.getSnapshot().openState).toBe('loading')
    await opening
    const snapshot = session.getSnapshot()
    expect(snapshot.openState).toBe('open')
    expect(snapshot.hasMore).toBe(true)
    expect(eventSeqs(session)).toEqual([10, 11, 12, 13, 14, 15])
    expect(session.eventSource.getSnapshot().change).toMatchObject({ kind: 'replace' })
  })

  it('is idempotent: concurrent opens share one follow, reopening when open is a no-op', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    await Promise.all([session.open(), session.open()])
    await session.open()
    expect(mock.log.requests(FOLLOW)).toHaveLength(1)
    expect(mock.log.requests(PAGE)).toEqual([])
  })

  it('lands an error result in openState=error with the Remote failure kept', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    mock.stream(FOLLOW, followScript(err(new RemoteError('session/not-found', 'gone', { sessionId: SID }))))
    await session.open()
    const snapshot = session.getSnapshot()
    expect(snapshot.openState).toBe('error')
    expect(snapshot.openError?.code).toBe('session/not-found')
  })

  it('lands exhausted carrier retries in openState=error as gateway/internal', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    // Two consecutive carrier losses before any opening is accepted exhaust the
    // Gateway's retry budget; the escaping failure crosses the stream boundary marked.
    mock.stream(FOLLOW, followScript(() => Promise.reject(new RemoteStreamCarrierError('history carrier down'))))
    await session.open()
    expect(session.getSnapshot().openState).toBe('error')
    expect(session.getSnapshot().openError).toMatchObject({
      code: 'gateway/internal', message: 'history carrier down',
    })
    expect(mock.log.requests(FOLLOW)).toHaveLength(2)
  })

  it('lands a Gateway-marked stream failure in openState=error', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    mock.stream(FOLLOW, followScript(() => Promise.reject(new Error('socket died'))))
    await session.open()
    expect(session.getSnapshot().openState).toBe('error')
    expect(session.getSnapshot().openError).toMatchObject({ code: 'gateway/internal', message: 'socket died' })
  })

  it('stitches live frames landing right behind the opening snapshot, dropping the page overlap', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    const gate = Promise.withResolvers<SessionPage>()
    const page = plainTurn(SessionSeq(10), 0, '早', '安')
    mock.stream(FOLLOW, async ([request], stream) => {
      stream.push(followSnapshot(await gate.promise, request as SessionFollowRequest))
      // Two live frames follow the snapshot before the opening settles; seq 15 overlaps its tail.
      stream.push(frame(ev.turnStart(SessionSeq(15), 1)))
      stream.push(frame(ev.user(SessionSeq(16), '插进来的')))
    })
    const opening = session.open()
    gate.resolve(historyValue(page))
    await opening
    await mock.streams.drained(FOLLOW)
    // Overlapping seq-15 frame (== page tail turn/end) was dropped; 16 appended once.
    expect(eventSeqs(session)).toEqual([10, 11, 12, 13, 14, 15, 16])
  })
})

describe('live event path', () => {
  async function opened(mock: RemoteMock, start: () => Promise<TestClient>, events: SessionEvent[] = plainTurn(SessionSeq(0), 0, 'a', 'b')) {
    const session = await sessionBench(mock, start, SID)
    mock.stream(FOLLOW, followScript(history(events)))
    await session.open()
    return session
  }

  it('drops replayed frames at or below the window tail', async ({ mock, start }) => {
    const session = await opened(mock, start)
    const before = session.eventSource.getSnapshot()
    await pushEvent(mock, ev.user(SessionSeq(3), '重放'))
    expect(session.eventSource.getSnapshot()).toBe(before)
  })

  it('keeps the authoritative host blank bit across unrelated log events', async ({ mock, start }) => {
    const session = await opened(mock, start, [])
    session.handleBlank(true)
    await pushEvent(mock, ev.commandRun(SessionSeq(0), 'cmd-perm', 'permission', ' danger-full-access'))
    await pushEvent(mock, ev.commandDone(SessionSeq(1), 'cmd-perm', 'success', 'preset danger-full-access'))
    const snapshot = session.getSnapshot()
    expect(eventSeqs(session)).toEqual([0, 1])
    expect(snapshot.blank).toBe(true)
  })

  it('repairs a seq gap by repulling the tail page instead of appending a hole', async ({ mock, start }) => {
    const session = await opened(mock, start, plainTurn(SessionSeq(0), 0, 'a', 'b')) // tail seq = 5
    const repaired = [...plainTurn(SessionSeq(0), 0, 'a', 'b'), ...plainTurn(SessionSeq(6), 1, 'c', 'd')]
    mock.remote.session.page.mockImplementation(pageRule(history(repaired)))
    // seq 9 with tail 5 → gap; the event detours to the buffer and one page refetch fires.
    await pushEvent(mock, ev.assistant(SessionSeq(9), 1, 'd'))
    await vi.waitFor(() => {
      expect(mock.log.requests(PAGE)).toHaveLength(1)
    })
    await vi.waitFor(() => {
      expect(eventSeqs(session)).toEqual(
        repaired.filter(event => event.seq <= 9).map(event => event.seq),
      )
    })
  })
})

describe('paging', () => {
  it('prepends an older page and keeps seq continuity', async ({ mock, start }) => {
    const older = plainTurn(SessionSeq(0), 0, '旧问', '旧答')
    const newer = plainTurn(SessionSeq(6), 1, '新问', '新答')
    const session = await sessionBench(mock, start, SID)
    mock.stream(FOLLOW, followScript(history(newer, true)))
    mock.remote.session.page.mockImplementation(pageRule(history(older)))
    await session.open()
    await session.loadOlder()
    const snapshot = session.getSnapshot()
    expect(mock.log.requests(FOLLOW)).toHaveLength(1)
    expect(mock.log.requests(PAGE)).toMatchObject([
      { address: ADDRESS, throughSeq: 11, beforeSeq: 6 },
    ])
    expect(snapshot.hasMore).toBe(false)
    expect(eventSeqs(session)).toEqual([...older, ...newer].map(event => event.seq))
  })

  it('installs a page without interpreting business replacement metadata', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    mock.stream(FOLLOW, followScript(history([
      ev.compactSummary(SessionSeq(80), '窗外范围的摘要', SessionSeq(3), SessionSeq(40)),
      ev.compactCheckpoint(SessionSeq(81), SessionSeq(80), SessionSeq(3), SessionSeq(40)),
      ev.user(SessionSeq(82), '压缩后的新问题'),
    ], true)))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await session.open()
      const snapshot = session.getSnapshot()
      expect(snapshot.openState).toBe('open')
      expect(eventSeqs(session)).toEqual([80, 81, 82])
      expect(errorSpy).not.toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('drops a discontinuous older page fail-soft (window unchanged, hasMore cleared)', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    mock.stream(FOLLOW, followScript(history(plainTurn(SessionSeq(10), 1, '新', '页'), true)))
    mock.remote.session.page.mockImplementation(pageRule(history(plainTurn(SessionSeq(0), 0, '断', '层'), true))) // tail seq 5, but baseSeq is 10 → hole
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await session.open()
      const windowBefore = session.eventSource.getSnapshot()
      await session.loadOlder()
      const snapshot = session.getSnapshot()
      expect(session.eventSource.getSnapshot().entries).toEqual(windowBefore.entries)
      expect(snapshot.hasMore).toBe(false)
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('loadThrough pages repeatedly until the window covers the target seq', async ({ mock, start }) => {
    const oldest = plainTurn(SessionSeq(0), 0, '最旧问', '最旧答')
    const middle = plainTurn(SessionSeq(6), 1, '中问', '中答')
    const newest = plainTurn(SessionSeq(12), 2, '新问', '新答')
    const session = await sessionBench(mock, start, SID)
    mock.stream(FOLLOW, followScript(history(newest, true)))
    await session.open()

    const gate = Promise.withResolvers<RemoteResult<SessionPage>>()
    mock.remote.session.page.mockImplementation(pageRule(request => (request.beforeSeq === 12 ? history(middle, true) : history(oldest))))
    mock.remote.session.page.mockReturnValueOnce(gate.promise)
    const jump = session.loadThrough(SessionSeq(0))
    expect(session.getSnapshot().loadingOlder).toBe(true)
    gate.resolve(history(middle, true))
    await jump
    const snapshot = session.getSnapshot()
    expect(snapshot.loadingOlder).toBe(false)
    expect(eventSeqs(session)).toEqual([...oldest, ...middle, ...newest].map(event => event.seq))
    expect(mock.log.requests(PAGE)).toMatchObject([
      { beforeSeq: 12, maxMessages: JUMP_PAGE_MESSAGES },
      { beforeSeq: 6, maxMessages: JUMP_PAGE_MESSAGES },
    ])
  })

  it('loadThrough is a no-op when the window already covers the target or the session is not open', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    await session.loadThrough(SessionSeq(0)) // cold: no-op
    expect(mock.log.requests()).toEqual([])
    mock.stream(FOLLOW, followScript(history(plainTurn(SessionSeq(6), 1, 'x', 'y'), true)))
    await session.open()
    const sent = mock.log.requests().length
    await session.loadThrough(SessionSeq(6)) // baseSeq is already 6
    await session.loadThrough(SessionSeq(9)) // inside the window
    expect(mock.log.requests()).toHaveLength(sent)
  })

  it('loadThrough retargets a running jump to the lowest requested seq and shares its completion', async ({ mock, start }) => {
    const oldest = plainTurn(SessionSeq(0), 0, 'a', 'b')
    const middle = plainTurn(SessionSeq(6), 1, 'c', 'd')
    const session = await sessionBench(mock, start, SID)
    mock.stream(FOLLOW, followScript(history(plainTurn(SessionSeq(12), 2, 'e', 'f'), true)))
    await session.open()

    const gate = Promise.withResolvers<RemoteResult<SessionPage>>()
    mock.remote.session.page.mockImplementation(pageRule(history(oldest)))
    mock.remote.session.page.mockReturnValueOnce(gate.promise)
    const first = session.loadThrough(SessionSeq(6))
    const second = session.loadThrough(SessionSeq(0))
    gate.resolve(history(middle, true))
    await Promise.all([first, second])
    expect(eventSeqs(session)).toEqual([
      ...[...oldest, ...middle].map(event => event.seq),
      12, 13, 14, 15, 16, 17,
    ])
    expect(mock.log.requests(PAGE)).toHaveLength(2)
  })

  it('loadThrough refused by a busy pager leaves no target behind for later jumps', async ({ mock, start }) => {
    const middle = plainTurn(SessionSeq(6), 1, 'c', 'd')
    const session = await sessionBench(mock, start, SID)
    mock.stream(FOLLOW, followScript(history(plainTurn(SessionSeq(12), 2, 'e', 'f'), true)))
    await session.open()

    // A plain single-page pull holds the busy flag while the jump is refused.
    const gate = Promise.withResolvers<RemoteResult<SessionPage>>()
    mock.remote.session.page.mockReturnValueOnce(gate.promise)
    const older = session.loadOlder()
    await session.loadThrough(SessionSeq(0)) // refused: must not park seq 0 anywhere
    gate.resolve(history(middle, true))
    await older

    // A later jump to a nearer seq pages exactly to it — a leaked 0 target
    // would keep pulling three-event pages all the way to the head.
    mock.remote.session.page.mockImplementation(pageRule((request) => {
      const start = (request.beforeSeq ?? 0) - 3
      return history(
        [ev.user(SessionSeq(start), `u${String(start)}`), ev.user(SessionSeq(start + 1), `u${String(start + 1)}`), ev.user(SessionSeq(start + 2), `u${String(start + 2)}`)],
        start > 0,
      )
    }))
    await session.loadThrough(SessionSeq(4))
    // Covered at seq 3 (≤ 4) after one page; a leaked 0 target would add a
    // third call at beforeSeq 3 and pull the head to 0.
    expect((mock.log.requests(PAGE) as SessionPageRequest[]).map(request => request.beforeSeq)).toEqual([12, 6])
    expect(eventSeqs(session)[0]).toBe(3)
  })

  it('loadThrough stops paging when the event stream generation moves mid-loop', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    mock.stream(FOLLOW, followScript(history(plainTurn(SessionSeq(12), 2, 'x', 'y'), true)))
    await session.open()

    const gate = Promise.withResolvers<RemoteResult<SessionPage>>()
    mock.remote.session.page.mockReturnValueOnce(gate.promise)
    const jump = session.loadThrough(SessionSeq(0))
    // The address is rebuilt while the first page is in flight; the same follow script serves the new generation.
    const rebuilt = session.resync()
    gate.resolve(history(plainTurn(SessionSeq(6), 1, 'c', 'd'), true))
    await jump
    await rebuilt
    // The stale loop must not page the new generation toward its old target:
    // the gated page is the only page call, and the resync opened a second follow.
    expect(mock.log.requests(PAGE)).toHaveLength(1)
    expect(mock.log.requests(FOLLOW)).toHaveLength(2)
    expect(session.getSnapshot().loadingOlder).toBe(false)
  })

  it('loadThrough stops on a page that makes no progress instead of looping', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    mock.stream(FOLLOW, followScript(history(plainTurn(SessionSeq(12), 2, 'x', 'y'), true)))
    mock.remote.session.page.mockImplementation(pageRule(history([], true))) // empty page still claiming more history
    await session.open()
    await session.loadThrough(SessionSeq(0))
    expect(session.getSnapshot().loadingOlder).toBe(false)
    expect(mock.log.requests(PAGE)).toHaveLength(1)
  })

  it('loadThrough fails soft on a page failure and clears its busy state: a folded carrier throw quietly, a local throw with console.error', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    mock.stream(FOLLOW, followScript(history(plainTurn(SessionSeq(12), 2, 'x', 'y'), true)))
    await session.open()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const prepend = vi.spyOn(SessionEventStream.prototype, 'prepend')
    try {
      mock.remote.session.page.mockImplementation(() => Promise.reject(new Error('page wire down')))
      await session.loadThrough(SessionSeq(0))
      expect(errorSpy).not.toHaveBeenCalled() // the proxy folds the throw into a Remote failure, as the generated client would
      expect(session.getSnapshot().loadingOlder).toBe(false)
      prepend.mockRejectedValueOnce(new Error('local fault'))
      await session.loadThrough(SessionSeq(0))
      expect(errorSpy).toHaveBeenCalledWith('[session-controller] loadThrough failed:', expect.any(Error))
      expect(session.getSnapshot().loadingOlder).toBe(false)
    } finally {
      prepend.mockRestore()
      errorSpy.mockRestore()
    }
  })

  it('ignores loadOlder while one is in flight (single request)', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    mock.stream(FOLLOW, followScript(history(plainTurn(SessionSeq(6), 1, 'x', 'y'), true)))
    await session.open()
    const gate = Promise.withResolvers<RemoteResult<SessionPage>>()
    mock.remote.session.page.mockImplementation(pageRule(gate.promise))
    const first = session.loadOlder()
    const second = session.loadOlder()
    gate.resolve(history(plainTurn(SessionSeq(0), 0, 'a', 'b')))
    await Promise.all([first, second])
    expect(mock.log.requests(FOLLOW)).toHaveLength(1)
    expect(mock.log.requests(PAGE)).toHaveLength(1)
  })
})

describe('prompt and cancel errors', () => {
  const CHILD = { parentSessionId: PARENT, childSessionId: SID, mode: 'continuable' } as const

  it('routes an addressed child through non-activating history, continuation prompt, and interrupt only', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID, { address: CHILD, parentAvailable: true })
    await session.open()
    const prompted = await session.prompt([{ type: 'text', text: '继续' }], 'queue')
    const steered = await session.prompt([{ type: 'text', text: '现在处理' }], 'steer')
    const cancelled = await session.cancel()

    expect(prompted).toEqual({ ok: true, value: { accepted: true } })
    expect(steered).toEqual({ ok: true, value: { accepted: true } })
    expect(cancelled).toEqual({ ok: true, value: { accepted: true } })
    expect(mock.log.requests(FOLLOW)).toEqual([
      { address: { kind: 'subagent', ...CHILD }, assistantStream: true, maxMessages: 50 },
    ])
    expect(mock.log.requests(PAGE)).toEqual([])
    // The prompt mode crosses the wire as the request's delivery.
    expect(mock.log.requests('subagents/prompt')).toEqual([
      {
        requestId: expect.any(String) as unknown as string,
        ...CHILD,
        delivery: 'queue',
        content: [{ type: 'text', text: '继续' }],
        clientTimeZone: TIME_ZONE,
      },
      {
        requestId: expect.any(String) as unknown as string,
        ...CHILD,
        delivery: 'steer',
        content: [{ type: 'text', text: '现在处理' }],
        clientTimeZone: TIME_ZONE,
      },
    ])
    // Positional parameters cross the wire as positional args.
    expect(mock.log.calls('subagents/interruptByParent').map(call => call.args)).toEqual([[SID, PARENT, 'continuable']])
    expect(mock.log.requests('session/prompt')).toEqual([])
    expect(mock.log.requests('session/cancel')).toEqual([])
    // A successful interrupt leaves no stop error behind.
    expect(session.getSnapshot().promptError).toBeNull()
    expect(session.getSnapshot().subagent).toEqual({ address: CHILD, parentAvailable: true })
  })

  it('forwards continuation image parts to the subagent prompt Remote unstripped', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID, { address: CHILD, parentAvailable: true })
    await session.open()
    const content = [
      { type: 'text' as const, text: '看这张图' },
      { type: 'image' as const, mediaType: 'image/png' as const, data: 'aGk=', name: 'shot.png' },
    ]
    const prompted = await session.prompt(content, 'queue')

    expect(prompted).toEqual({ ok: true, value: { accepted: true } })
    expect(mock.log.requests('subagents/prompt')).toEqual([
      {
        requestId: expect.any(String) as unknown as string,
        ...CHILD,
        delivery: 'queue',
        content,
        clientTimeZone: TIME_ZONE,
      },
    ])
    expect(session.getSnapshot().promptError).toBeNull()
  })

  it('lands an interrupt business failure in promptError with op=stop', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID, { address: CHILD, parentAvailable: true })
    mock.remote.subagents.interruptByParent.mockResolvedValue(err(new RemoteError('subagent/unauthorized', 'nope', { childSessionId: SID })))
    await session.open()
    const cancelled = await session.cancel()
    expect(cancelled).toMatchObject({ ok: false, error: { code: 'subagent/unauthorized' } })
    expect(session.getSnapshot().promptError).toMatchObject({
      op: 'stop', error: { code: 'subagent/unauthorized' },
    })
  })

  it('rejects staged files instead of dropping them from subagent continuations', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID, { address: CHILD, parentAvailable: true })
    await session.open()

    const prompted = await session.prompt([
      { type: 'file', receiptId: 'receipt' as never },
      { type: 'text', text: '继续' },
    ], 'queue')

    expect(prompted).toMatchObject({
      ok: false,
      error: {
        code: 'subagent/attachment-invalid',
        details: { reason: 'SUBAGENT_FILE_UNSUPPORTED' },
      },
    })
    expect(mock.log.requests('subagents/prompt')).toEqual([])
  })

  it('sends a one-shot address to the Host under the continuable marker', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID, { address: { ...CHILD, mode: 'one-shot' } })
    mock.remote.subagents.prompt.mockResolvedValue(err(new RemoteError(
      'subagent/not-resumable', 'subagent cannot be resumed', { childSessionId: SID },
    )))
    await session.open()
    const prompted = await session.prompt([{ type: 'text', text: '继续' }], 'queue')
    const cancelled = await session.cancel()

    // The Host reads the durable descriptor; the wire marker stays 'continuable'.
    expect(prompted).toMatchObject({ ok: false, error: { code: 'subagent/not-resumable' } })
    expect(cancelled).toEqual({ ok: true, value: { accepted: true } })
    expect(mock.log.requests('subagents/prompt')).toMatchObject([CHILD])
    expect(mock.log.calls('subagents/interruptByParent').map(call => call.args)).toEqual([[SID, PARENT, 'continuable']])
    expect(mock.log.requests(FOLLOW)).toEqual([
      { address: { kind: 'subagent', ...CHILD, mode: 'one-shot' }, assistantStream: true, maxMessages: 50 },
    ])
    expect(mock.log.requests(PAGE)).toEqual([])
    expect(mock.log.requests('session/cancel')).toEqual([])
  })

  it('delivers an image continuation to the Host without narrowing its upload parts', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID, { address: CHILD })
    await session.open()
    const prompted = await session.prompt(
      [{ type: 'text', text: '看图' }, { type: 'image', mediaType: 'image/png', data: 'AA==' }],
      'queue',
    )

    expect(prompted).toEqual({ ok: true, value: { accepted: true } })
    expect(mock.log.requests('subagents/prompt')).toMatchObject([
      { content: [{ type: 'text' }, { type: 'image', mediaType: 'image/png', data: 'AA==' }] },
    ])
  })

  it('publishes the first-prompt lifecycle synchronously before the Remote settles', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    session.handleBlank(true)
    expect(session.getSnapshot()).toMatchObject({
      blank: true, promptAttempted: false, awaitingFirstTurn: false,
    })
    const inFlight = session.prompt([{ type: 'text', text: '要发的' }], 'queue')
    expect(session.getSnapshot()).toMatchObject({
      blank: true, promptAttempted: true, awaitingFirstTurn: true,
    })
    const result = await inFlight
    expect(result.ok).toBe(true)
    expect(session.getSnapshot()).toMatchObject({
      blank: false, promptAttempted: true, awaitingFirstTurn: true,
    })
    expect(mock.log.requests('session/prompt')).toMatchObject([{
      sessionId: SID,
      mode: 'queue',
      content: [{ type: 'text', text: '要发的' }],
      clientTimeZone: TIME_ZONE,
    }])
    session.handleRunning(true)
    expect(session.getSnapshot()).toMatchObject({ running: true, awaitingFirstTurn: false })
  })

  it('keeps the attempted-first-prompt state when the Host rejects the prompt', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    session.handleBlank(true)
    mock.remote.session.prompt.mockResolvedValue(err(new RemoteError('session/agent-busy', 'busy', { reason: 'x' })))
    const result = await session.prompt([{ type: 'text', text: '失败的' }], 'queue')
    expect(result.ok).toBe(false)
    expect(session.getSnapshot().promptError).toMatchObject({ op: 'send', error: { code: 'session/agent-busy' } })
    expect(session.getSnapshot()).toMatchObject({
      blank: true, promptAttempted: true, awaitingFirstTurn: true,
    })
  })

  it('receives a carrier throw while cancelling as the client\'s gateway/internal fold, landing op=stop', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    mock.remote.session.cancel.mockImplementation(() => Promise.reject(new Error('cancel transport down')))
    const cancelled = await session.cancel()
    expect(cancelled).toMatchObject({
      ok: false, error: { code: 'gateway/internal', message: 'client api: session/cancel failed: cancel transport down' },
    })
    expect(session.getSnapshot().promptError).toMatchObject({ op: 'stop', error: { code: 'gateway/internal' } })
  })

  it('reads session-authorized attachment bytes and keeps the opaque id on the wire', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    const result = await session.readAttachment('attachment-1' as never)
    expect(result).toEqual({
      ok: true,
      value: {
        attachment: { attachmentId: 'a', mediaType: 'image/png', bytes: 1, width: 1, height: 1 },
        data: Uint8Array.of(0),
      },
    })
    expect(mock.log.requests('session/attachment')).toEqual([{
      sessionId: SID, attachmentId: 'attachment-1',
    }])
  })
})

describe('rename', () => {
  it('settles the title projection cell from the unary response (higher-seq-wins vs the push frame)', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    mock.remote.session.rename.mockResolvedValue(ok({ title: '正名', seq: 7 }))
    const result = await session.rename('  正名  ')
    expect(result).toMatchObject({ ok: true, value: { title: '正名', seq: 7 } })
    expect(mock.log.requests('session/rename')).toMatchObject([{ sessionId: SID, title: '  正名  ' }])
    expect(session.projections.faceOf('title').getSnapshot()).toBe('正名')
    // A stale lower-seq apply (the push-frame path routes into this same
    // store) must not roll the settled value back.
    session.projections.apply('title', '旧名', SessionSeq(3))
    expect(session.projections.faceOf('title').getSnapshot()).toBe('正名')
  })

  it('returns the business error untouched and a carrier throw as the client\'s gateway/internal fold', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    mock.remote.session.rename.mockResolvedValue(err(new RemoteError('session/title-invalid', 'empty', { sessionId: SID })))
    const rejected = await session.rename('   ')
    expect(rejected).toMatchObject({ ok: false, error: { code: 'session/title-invalid' } })
    expect(session.projections.faceOf('title').getSnapshot()).toBeUndefined()
    mock.remote.session.rename.mockImplementation(() => Promise.reject(new Error('rename transport down')))
    const folded = await session.rename('x')
    expect(folded).toMatchObject({ ok: false, error: { code: 'gateway/internal', message: 'client api: session/rename failed: rename transport down' } })
    expect(session.projections.faceOf('title').getSnapshot()).toBeUndefined()
  })
})

describe('remaining branches', () => {
  it('receives a carrier throw while prompting as the client\'s gateway/internal fold, landing op=send', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    mock.remote.session.prompt.mockImplementation(() => Promise.reject(new Error('prompt wire down')))
    const prompted = await session.prompt([{ type: 'text', text: 'x' }], 'queue')
    expect(prompted).toMatchObject({
      ok: false, error: { code: 'gateway/internal', message: 'client api: session/prompt failed: prompt wire down' },
    })
    expect(session.getSnapshot().promptError).toMatchObject({ op: 'send', error: { code: 'gateway/internal' } })
  })

  it('cancel business error also lands op=stop promptError', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    mock.remote.session.cancel.mockResolvedValue(err(new RemoteError('session/agent-busy', 'nope', { reason: 'r' })))
    await session.cancel()
    expect(session.getSnapshot().promptError).toMatchObject({ op: 'stop', error: { code: 'session/agent-busy' } })
  })

  it('loadOlder guards: not-open/no-hasMore no-op, err result kept window, empty page updates hasMore, throw fail-soft', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    await session.loadOlder() // cold: no-op, zero traffic
    expect(mock.log.requests()).toEqual([])
    mock.stream(FOLLOW, followScript(history(plainTurn(SessionSeq(6), 1, 'x', 'y'), true)))
    await session.open()
    // err result: window unchanged
    mock.remote.session.page.mockResolvedValue(err(new RemoteError('gateway/internal', 'x', {})))
    await session.loadOlder()
    expect(eventSeqs(session)).toHaveLength(6)
    expect(session.getSnapshot().hasMore).toBe(true)
    // empty page: hasMore adopts the response
    mock.remote.session.page.mockImplementation(pageRule(history([])))
    await session.loadOlder()
    expect(session.getSnapshot().hasMore).toBe(false)
    // hasMore false now: further loadOlder is a guard no-op
    const sent = mock.log.requests().length
    await session.loadOlder()
    expect(mock.log.requests()).toHaveLength(sent)
    // failure paths, after a resync reopens hasMore from the follow snapshot: a carrier throw arrives folded as a
    // Remote failure and stays quiet; a local throw fails soft with console.error
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const prepend = vi.spyOn(SessionEventStream.prototype, 'prepend')
    try {
      await session.resync()
      mock.remote.session.page.mockImplementation(() => Promise.reject(new Error('page wire down')))
      await session.loadOlder()
      expect(errorSpy).not.toHaveBeenCalled()
      expect(session.getSnapshot().loadingOlder).toBe(false)
      prepend.mockRejectedValueOnce(new Error('local fault'))
      await session.loadOlder()
      expect(errorSpy).toHaveBeenCalledWith('[session-controller] loadOlder failed:', expect.any(Error))
      expect(session.getSnapshot().loadingOlder).toBe(false)
    } finally {
      prepend.mockRestore()
      errorSpy.mockRestore()
    }
  })

  it('subscribe delivers snapshot-change notifications and unsubscribes', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    mock.stream(FOLLOW, followScript(history(plainTurn(SessionSeq(0), 0, 'a', 'b'))))
    let notified = 0
    const unsubscribe = session.subscribe(() => { notified++ })
    await session.open()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(notified).toBeGreaterThan(0)
    const seen = notified
    unsubscribe()
    session.handleRunning(true) // any snapshot mutation; the listener must stay silent
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(notified).toBe(seen)
  })

  it('rejects an opening page that does not end at the opening cursor', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    mock.stream(FOLLOW, followScript(history(plainTurn(SessionSeq(0), 0, 'a', 'b')), { cursor: 11 }))
    await session.open()
    expect(mock.log.requests(FOLLOW)).toHaveLength(1)
    const snapshot = session.getSnapshot()
    expect(snapshot.openState).toBe('error')
    expect(snapshot.openError).toMatchObject({
      code: 'gateway/internal', message: 'session event stream page did not end at its requested cursor',
    })
    expect(eventSeqs(session)).toEqual([])
  })

  it('deduplicates repeated running flips and records removal', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    const before = session.getSnapshot()
    session.handleRunning(false) // already false: dedup branch
    expect(session.getSnapshot()).toBe(before)
    session.handleRemoved()
    expect(session.getSnapshot().removed).toBe(true)
  })

  it('drops live events while cold/error (no window upkeep)', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    await pushEvent(mock, ev.user(SessionSeq(0), '冷态帧')) // no follow is open: nothing receives it
    expect(eventSeqs(session)).toEqual([])
    mock.stream(FOLLOW, followScript(err(new RemoteError('gateway/internal', 'x', {}))))
    await session.open()
    await pushEvent(mock, ev.user(SessionSeq(0), '错态帧'))
    expect(eventSeqs(session)).toEqual([])
  })

  it('preserves a Host-reported failure that terminates the live source', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    mock.stream(FOLLOW, followScript(history(plainTurn(SessionSeq(0), 0, 'a', 'b'))))
    await session.open()
    const failure = new RemoteError('session/not-found', 'session disappeared', { sessionId: SID })

    mock.streams.fail(FOLLOW, failure)
    await vi.waitFor(() => { expect(session.getSnapshot().openState).toBe('error') })

    expect(session.getSnapshot().openError).toMatchObject({
      code: failure.code, message: failure.message, details: failure.details,
    })
  })

  it('coalesces queued gap frames behind one repair and exposes a failed repair', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    mock.stream(FOLLOW, followScript(history(plainTurn(SessionSeq(0), 0, 'a', 'b'))))
    await session.open()
    const gate = Promise.withResolvers<RemoteResult<SessionPage>>()
    mock.remote.session.page.mockImplementation(pageRule(gate.promise))
    await pushEvent(mock, ev.user(SessionSeq(9), '洞一'))
    await pushEvent(mock, ev.user(SessionSeq(10), '洞二'))
    await vi.waitFor(() => { expect(mock.log.requests(PAGE)).toHaveLength(1) })
    gate.resolve(err(new RemoteError('gateway/internal', 'repair wire down', {})))
    await vi.waitFor(() => { expect(session.getSnapshot().openState).toBe('error') })
    expect(session.getSnapshot().openError).toMatchObject({ code: 'gateway/internal', message: 'repair wire down' })
    expect(eventSeqs(session)).toHaveLength(6)
  })

  it('doOpen transport throw of a stale generation is swallowed (generation guard in catch)', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    const stale = Promise.withResolvers<RemoteResult<SessionPage>>()
    mock.stream(FOLLOW, followScript(() => stale.promise))
    const opening = session.open()
    mock.stream(FOLLOW, followScript(history(plainTurn(SessionSeq(0), 0, 'a', 'b'))))
    const resynced = session.resync()
    stale.reject(new Error('stale wire'))
    await Promise.all([opening, resynced])
    expect(session.getSnapshot().openState).toBe('open') // stale catch did not write error
  })

  it('drops a stale doOpen whose history resolved successfully after resync superseded it', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    const stale = Promise.withResolvers<RemoteResult<SessionPage>>()
    mock.stream(FOLLOW, followScript(() => stale.promise))
    const opening = session.open()
    mock.stream(FOLLOW, followScript(history(plainTurn(SessionSeq(6), 1, '新', '代'))))
    const resynced = session.resync()
    stale.resolve(history(plainTurn(SessionSeq(0), 0, '旧', '代'))) // success, but its generation is gone
    await Promise.all([opening, resynced])
    expect(eventSeqs(session)).toEqual(plainTurn(SessionSeq(6), 1, '新', '代').map(event => event.seq))
  })

  it('drops a gap repair superseded by a full resync while its pull was in flight', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    mock.stream(FOLLOW, followScript(history(plainTurn(SessionSeq(0), 0, 'a', 'b'))))
    await session.open()
    const repairPull = Promise.withResolvers<RemoteResult<SessionPage>>()
    mock.remote.session.page.mockImplementation(pageRule(repairPull.promise))
    await pushEvent(mock, ev.user(SessionSeq(9), '洞'))
    await vi.waitFor(() => { expect(mock.log.requests(PAGE)).toHaveLength(1) })
    mock.stream(FOLLOW, followScript(history(plainTurn(SessionSeq(6), 1, 'c', 'd'))))
    const resynced = session.resync() // bumps the generation
    repairPull.resolve(history(plainTurn(SessionSeq(0), 0, '旧', '页'))) // repair result: stale, dropped
    await resynced
    expect(eventSeqs(session)).toEqual(plainTurn(SessionSeq(6), 1, 'c', 'd').map(event => event.seq))
  })

  it('successful cancel leaves no promptError', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    mock.stream(FOLLOW, followScript(history(plainTurn(SessionSeq(0), 0, 'a', 'b'))))
    await session.open()
    const result = await session.cancel()
    expect(result.ok).toBe(true)
    expect(session.getSnapshot().promptError).toBeNull()
  })

  it('dispose is a reserved no-op on resident instances', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    await expect(session.dispose()).resolves.toBeUndefined()
  })

  it('carries raw history and follow events through the event feed', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    const historyCall = ev.toolCall(SessionSeq(6), 1, 'h1', 'bash', '{"cmd":"pwd"}')
    const historyResult = ev.toolResult(SessionSeq(7), 1, 'h1', 'done')
    mock.stream(FOLLOW, followScript(history([...plainTurn(SessionSeq(0), 0, 'a', 'b'), historyCall, historyResult])))
    await session.open()
    expect(windowEntries(session).slice(-2)).toEqual(entries([historyCall, historyResult]))
    const liveCall = ev.toolCall(SessionSeq(8), 2, 'l1', 'write', '{"file_path":"a.ts"}')
    await pushEvent(mock, liveCall)
    expect(windowEntries(session).at(-1)).toEqual(frame(liveCall))
    const liveResult = ev.toolResult(SessionSeq(9), 2, 'l1', 'ok')
    await pushEvent(mock, liveResult)
    expect(windowEntries(session).at(-1)).toEqual(frame(liveResult))
  })
})

describe('resync', () => {
  it('keeps the old feed until the reconnect snapshot, then repairs queued live gaps', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    mock.stream(FOLLOW, followScript(history(plainTurn(SessionSeq(0), 0, '旧', '窗'))))
    await session.open()
    const oldWindow = session.eventSource.getSnapshot()
    const replacement = Promise.withResolvers<SessionPage>()
    // The reconnect generation: its snapshot is gated, then two live frames land out of order right behind it.
    mock.stream(FOLLOW, async ([request], stream) => {
      stream.push(followSnapshot(await replacement.promise, request as SessionFollowRequest))
      stream.push(frame(ev.user(SessionSeq(17), '后到高位')))
      stream.push(frame(ev.user(SessionSeq(16), '后到低位')))
    })
    mock.remote.session.page.mockImplementation(pageRule(history([
      ...plainTurn(SessionSeq(10), 2, '终', '页'),
      ev.user(SessionSeq(16), '后到低位'),
      ev.user(SessionSeq(17), '后到高位'),
    ])))
    const publications: ReturnType<Session['eventSource']['getSnapshot']>[] = []
    const off = session.eventSource.subscribe(() => {
      publications.push(session.eventSource.getSnapshot())
    })

    const syncing = session.resync()
    await vi.waitFor(() => { expect(mock.log.requests(FOLLOW)).toHaveLength(2) })
    expect(session.eventSource.getSnapshot()).toBe(oldWindow)
    expect(publications).toEqual([])

    replacement.resolve(historyValue(plainTurn(SessionSeq(10), 2, '终', '页')))
    await syncing
    await vi.waitFor(() => {
      expect(eventSeqs(session)).toEqual([10, 11, 12, 13, 14, 15, 16, 17])
    })

    expect(publications).toHaveLength(2)
    expect(publications.map(snapshot => snapshot.change.kind)).toEqual(['replace', 'replace'])
    expect(publications[0]?.entries.map(entry => entry.event.seq)).toEqual([10, 11, 12, 13, 14, 15])
    expect(publications[1]?.entries.map(entry => entry.event.seq)).toEqual([10, 11, 12, 13, 14, 15, 16, 17])
    off()
  })

  it('rebuilds the window without clearing control state', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    mock.stream(FOLLOW, followScript(history(plainTurn(SessionSeq(0), 0, 'a', 'b'))))
    await session.open()
    session.handleRunning(true)
    session.handleAgentError('still visible')
    mock.stream(FOLLOW, followScript(history([...plainTurn(SessionSeq(0), 0, 'a', 'b'), ...plainTurn(SessionSeq(6), 1, 'c', 'd')])))
    await session.resync()
    const snapshot = session.getSnapshot()
    expect(snapshot.openState).toBe('open')
    expect(snapshot.running).toBe(true)
    expect(snapshot.lastAgentError).toBe('still visible')
    expect(eventSeqs(session)).toHaveLength(12)

  })

  it('does not resync a cold Session', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    await session.resync()
    expect(mock.log.requests()).toEqual([])
  })

  it('drops a stale in-flight open superseded by resync (generation guard)', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    const stale = Promise.withResolvers<RemoteResult<SessionPage>>()
    mock.stream(FOLLOW, followScript(() => stale.promise))
    const firstOpen = session.open()
    mock.stream(FOLLOW, followScript(history(plainTurn(SessionSeq(6), 1, '新', '代'))))
    const resynced = session.resync()
    stale.reject(new Error('dead connection')) // the doomed pre-disconnect request fails late
    await firstOpen
    await resynced
    const snapshot = session.getSnapshot()
    expect(snapshot.openState).toBe('open') // stale failure did not settle the fresh generation into error
    expect(eventSeqs(session)).toEqual(plainTurn(SessionSeq(6), 1, '新', '代').map(event => event.seq))
  })
})

describe('snapshot ownership', () => {
  it('publishes event-window appends without changing an unrelated Session snapshot', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    mock.stream(FOLLOW, followScript(history(plainTurn(SessionSeq(0), 0, '稳', '定'))))
    await session.open()
    const sessionBefore = session.getSnapshot()
    const windowBefore = session.eventSource.getSnapshot()
    const firstEntry = windowBefore.entries[0]
    await pushEvent(mock, ev.user(SessionSeq(6), '追加'))
    const windowAfter = session.eventSource.getSnapshot()
    expect(session.getSnapshot()).toBe(sessionBefore)
    expect(windowAfter).not.toBe(windowBefore)
    expect(windowAfter.entries[0]).toBe(firstEntry)
    expect(windowAfter.change).toMatchObject({ kind: 'append' })
  })
})
