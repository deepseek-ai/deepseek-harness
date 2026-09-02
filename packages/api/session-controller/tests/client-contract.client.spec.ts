import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import type { PromptContentPart as AttachmentPromptContentPart } from '@deepseek-ai/dsh-attachment/types'
import { SessionSeq, type SessionSeqCursor } from '@deepseek-ai/dsh-session/types'
import {
  MutableSessionEventSource, type SessionLiveEventEntry,
} from '../src/client/contract/events.ts'
import type { ISession } from '../src/client/contract/session.ts'
import type { ProjectionsBaseline } from '../src/client/sessions/projection-store.ts'
import { ProjectionValueStore } from '../src/client/sessions/projection-store.ts'
import type { PromptContentPart as SessionPromptContentPart, SessionPageRequest } from '../src/types.ts'
import { ev, plainTurn } from './event-script.client.ts'

type RenameSuccess = Extract<Awaited<ReturnType<ISession['rename']>>, { readonly ok: true }>

function entry(seq: SessionSeq): SessionLiveEventEntry {
  return {
    type: 'event',
    event: {
      type: 'turn/start',
      seq,
      time: seq,
      data: { turn: seq },
    },
  }
}

describe('Client Session contracts', () => {
  it('requires branded Session positions at internal event fixture boundaries', () => {
    expectTypeOf(entry).parameter(0).toEqualTypeOf<SessionSeq>()
    expectTypeOf(ev.user).parameter(0).toEqualTypeOf<SessionSeq>()
    expectTypeOf(ev.commandDone).parameter(4).toEqualTypeOf<SessionSeq | undefined>()
    expectTypeOf(ev.compactSummary).parameter(2).toEqualTypeOf<SessionSeq>()
    expectTypeOf(ev.compactCheckpoint).parameter(1).toEqualTypeOf<SessionSeq>()
    expectTypeOf(plainTurn).parameter(0).toEqualTypeOf<SessionSeq>()
  })

  it('brands same-process Session event positions while keeping the API wire numeric', () => {
    expectTypeOf<ISession['loadThrough']>().parameter(0).toEqualTypeOf<SessionSeq>()
    expectTypeOf<RenameSuccess['value']['seq']>().toEqualTypeOf<SessionSeq>()
    expectTypeOf<ProjectionValueStore['apply']>().parameter(2).toEqualTypeOf<SessionSeqCursor>()
    expectTypeOf<ProjectionsBaseline['asOfSeq']>().toEqualTypeOf<SessionSeqCursor>()
    expectTypeOf<SessionPageRequest['throughSeq']>().toEqualTypeOf<number>()
  })

  it('keeps its catalog-visible prompt parts identical to attachment intake', () => {
    expectTypeOf<SessionPromptContentPart>().toEqualTypeOf<AttachmentPromptContentPart>()
  })

  it('publishes exact replace, prepend, and append event-window changes', () => {
    const feed = new MutableSessionEventSource()
    const listener = vi.fn()
    const dispose = feed.subscribe(listener)
    const first = entry(SessionSeq(1))
    const older = entry(SessionSeq(0))
    const live = entry(SessionSeq(2))

    feed.replace([first], true)
    expect(feed.getSnapshot()).toEqual({
      entries: [first],
      hasMore: true,
      revision: 1,
      change: { kind: 'replace', entries: [first] },
    })

    feed.prepend([older], false)
    expect(feed.getSnapshot()).toEqual({
      entries: [older, first],
      hasMore: false,
      revision: 2,
      change: { kind: 'prepend', entries: [older] },
    })

    feed.append(live)
    expect(feed.getSnapshot()).toEqual({
      entries: [older, first, live],
      hasMore: false,
      revision: 3,
      change: { kind: 'append', entries: [live] },
    })
    expect(listener).toHaveBeenCalledTimes(3)

    dispose()
    feed.append(entry(SessionSeq(3)))
    expect(listener).toHaveBeenCalledTimes(3)
  })

  it('does not traverse the complete event window while appending', () => {
    const feed = new MutableSessionEventSource()
    const first = entry(SessionSeq(1))
    const base = [first]
    const iterate = vi.fn(Array.prototype[Symbol.iterator].bind(base))
    Object.defineProperty(base, Symbol.iterator, { value: iterate })
    feed.replace(base, false)
    iterate.mockClear()

    const before = feed.getSnapshot()
    const live = entry(SessionSeq(2))
    feed.append(live)
    const after = feed.getSnapshot()

    expect(iterate).not.toHaveBeenCalled()
    expect(before.entries).toEqual([first])
    expect(after.entries).toEqual([first, live])
    expect(after.entries).toBe(after.entries)
    expect(iterate).toHaveBeenCalledOnce()
  })

})
