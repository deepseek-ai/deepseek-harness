import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { runFixtureTurn } from '../src/agent-turn.ts'

type Listener = (session: unknown, event: SessionEvent) => void

const event = (value: object): SessionEvent => value as unknown as SessionEvent

function turnHarness(): {
  readonly ctx: Context
  readonly session: { readonly id: string }
  readonly foreignSession: object
  readonly emit: (session: unknown, value: object) => void
  readonly setFollowup: (callback: (message: { readonly id: unknown }) => void) => void
  readonly whenIdle: ReturnType<typeof vi.fn>
  readonly disposeListener: ReturnType<typeof vi.fn>
  readonly flush: ReturnType<typeof vi.fn>
} {
  const session = { id: 'fixture-session' }
  const foreignSession = {}
  let listener: Listener | undefined
  let followup = (_message: { readonly id: unknown }): void => {}
  const whenIdle = vi.fn(async () => {})
  const disposeListener = vi.fn()
  const flush = vi.fn(async () => {})
  const agent = {
    session,
    whenIdle,
    followup: vi.fn((message: { readonly id: unknown }) => { followup(message) }),
  }
  const ctx = {
    get: (name: string) => name === 'agents' ? { roots: () => [agent] } : undefined,
    on: (_name: string, callback: Listener) => {
      listener = callback
      return disposeListener
    },
    sessions: { flush },
  } as unknown as Context
  return {
    ctx,
    session,
    foreignSession,
    emit: (target, value) => { listener?.(target, event(value)) },
    setFollowup: (callback) => { followup = callback },
    whenIdle,
    disposeListener,
    flush,
  }
}

describe('runFixtureTurn', () => {
  it.each([
    ['no agent registry', undefined, 0],
    ['multiple roots', { roots: () => [{}, {}] }, 2],
  ])('rejects %s', async (_label, registry, count) => {
    const ctx = { get: () => registry, on: () => () => {} } as unknown as Context
    await expect(runFixtureTurn(ctx, { task: 'ignored' }))
      .rejects.toThrow(`fixture turn requires exactly one top-level agent, found ${count}`)
  })

  it('waits for the configured agent to publish before requiring it', async () => {
    // Configured agents publish asynchronously, so an initially empty registry
    // waits for agent/created instead of rejecting.
    const roots: object[] = []
    let created: (() => void) | undefined
    const dispose = vi.fn()
    const ctx = {
      get: (name: string) => name === 'agents' ? { roots: () => [...roots] } : undefined,
      on: (name: string, callback: () => void) => {
        if (name === 'agent/created') created = callback
        return dispose
      },
    } as unknown as Context
    const pending = runFixtureTurn(ctx, { task: 'ignored' })
    // Publication with a second root still fails the exactly-one requirement,
    // proving the count is re-checked after the wait.
    roots.push({}, {})
    created?.()
    await expect(pending).rejects.toThrow('fixture turn requires exactly one top-level agent, found 2')
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('observes only the owned interval and returns its final text and deduplicated usage', async () => {
    const harness = turnHarness()
    const observed: SessionEvent[] = []
    harness.setFollowup((message) => {
      harness.emit(harness.foreignSession, {
        type: 'assistant/message', seq: 0, time: 0, data: { stream: [], message: { content: [] } },
      })
      harness.emit(harness.session, {
        type: 'step/start', seq: 0, time: 0, data: { turn: 1, step: 1 },
      })
      harness.emit(harness.session, {
        type: 'agent/inbox/spliced', seq: 1, time: 1, data: { inserted: [{ id: 'other' }] },
      })
      harness.emit(harness.session, {
        type: 'agent/inbox/spliced', seq: 2, time: 2, data: { inserted: [message] },
      })
      harness.emit(harness.session, {
        type: 'assistant/attempt', seq: 3, time: 3,
        data: {
          turn: 1,
          step: 1,
          stream: [
            { type: 'text-chunks', time0: 3, index: 0, dt: [], texts: ['partial'] },
            {
              type: 'chunk', time: 4,
              chunk: {
                type: 'usage', usage: { inputTokens: 2, outputTokens: 3, reasoningTokens: 1 },
              },
            },
          ],
        },
      })
      harness.emit(harness.session, {
        type: 'feedback/record', seq: 4, time: 4, data: { text: 'interleaved' },
      })
      harness.emit(harness.session, {
        type: 'assistant/message', seq: 5, time: 5,
        data: {
          turn: 1,
          step: 1,
          stream: [],
          message: { content: [{ type: 'text', text: 'final answer' }] },
          usage: { inputTokens: 4, outputTokens: 5, cacheReadTokens: 6 },
        },
      })
      harness.emit(harness.session, {
        type: 'assistant/attempt', seq: 6, time: 6,
        data: {
          turn: 1,
          step: 2,
          stream: [{
            type: 'chunk', time: 6,
            chunk: {
              type: 'usage',
              usage: { inputTokens: 1, outputTokens: 2, cacheWriteTokens: 7, reasoningTokens: 2 },
            },
          }],
        },
      })
      harness.emit(harness.session, {
        type: 'assistant/message', seq: 7, time: 7,
        data: { turn: 1, step: 2, stream: [], message: { content: [{ type: 'tool-call' }] } },
      })
      harness.emit(harness.session, {
        type: 'assistant/attempt', seq: 8, time: 8,
        data: {
          turn: 1,
          step: 3,
          stream: [{ type: 'text-chunks', time0: 8, index: 0, dt: [], texts: ['no usage'] }],
        },
      })
      harness.emit(harness.foreignSession, {
        type: 'assistant/message', seq: 9, time: 9, data: { stream: [], message: { content: [] } },
      })
    })

    await expect(runFixtureTurn(harness.ctx, {
      task: 'prove the fixture',
      onEvent: (_sessionId, current) => { observed.push(current) },
    })).resolves.toEqual({
      type: 'result',
      sessionId: 'fixture-session',
      output: 'final answer',
      usage: {
        inputTokens: 5,
        outputTokens: 7,
        cacheReadTokens: 6,
        cacheWriteTokens: 7,
        reasoningTokens: 2,
      },
    })
    expect(observed.map(current => current.seq)).toEqual([2, 3, 4, 5, 6, 7, 8])
    expect(harness.whenIdle).toHaveBeenCalledTimes(2)
    expect(harness.flush).toHaveBeenCalledWith(harness.session)
    expect(harness.disposeListener).toHaveBeenCalledOnce()
  })

  it('omits usage when the interval records none', async () => {
    const harness = turnHarness()
    harness.setFollowup((message) => {
      harness.emit(harness.session, {
        type: 'agent/inbox/spliced', seq: 0, time: 0, data: { inserted: [message] },
      })
    })

    await expect(runFixtureTurn(harness.ctx, { task: 'no model step' })).resolves.toEqual({
      type: 'result',
      sessionId: 'fixture-session',
      output: '',
    })
  })

  it('always removes its listener when the turn fails', async () => {
    const harness = turnHarness()
    harness.whenIdle.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('turn failed'))

    await expect(runFixtureTurn(harness.ctx, { task: 'fail' })).rejects.toThrow('turn failed')
    expect(harness.disposeListener).toHaveBeenCalledOnce()
    expect(harness.flush).not.toHaveBeenCalled()
  })
})
