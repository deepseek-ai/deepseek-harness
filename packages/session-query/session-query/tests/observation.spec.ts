import { Context } from '@deepseek-ai/cordis'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import type { BorrowedSessionSource } from '@deepseek-ai/dsh-session-persistence'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { describe, expect, it, vi } from 'vitest'
import { SessionObservationReader } from '../src/observation.ts'

function header(id: string): SessionHeader {
  return { version: 0, id: SessionId(id), createdAt: 1, cwd: '/workspace' }
}

function preparedSource(
  meta: SessionHeader,
  dispose = vi.fn(),
): BorrowedSessionSource {
  const preparedSession = Session.create(meta.id, [], meta)
  return {
    source: 'prepared',
    inspection: { meta: preparedSession.header, events: preparedSession.snapshotEvents() },
    revision: SessionPersistenceRevision(`fixture:${meta.id}`),
    preparedSession,
    [Symbol.dispose]: dispose,
  }
}

describe('SessionObservationReader', () => {
  it('prefers a live Session that attaches while a prepared source is borrowed', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const meta = header('attached-during-borrow')
    const dispose = vi.fn()
    const prepared = preparedSource(meta, dispose)
    ctx.provide('sessionPersistence', {
      borrowSession: () => {
        ctx.sessions.create(meta.id, { meta })
        return Promise.resolve(prepared)
      },
    } as never)

    using observed = await new SessionObservationReader(ctx).read(meta.id, { projectionMode: 'none' })

    expect(observed.source).toBe('live')
    expect(dispose).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('releases a borrowed source once when the winning live projection fails', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const meta = header('attached-projection-failure')
    const dispose = vi.fn()
    const prepared = preparedSource(meta, dispose)
    ctx.provide('sessionPersistence', {
      borrowSession: () => {
        ctx.sessions.create(meta.id, { meta })
        return Promise.resolve(prepared)
      },
    } as never)
    vi.spyOn(ctx.sessionProjections, 'snapshot').mockImplementation(() => {
      throw new Error('projection failed')
    })

    await expect(new SessionObservationReader(ctx).read(meta.id)).rejects.toThrow('projection failed')
    expect(dispose).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('retries when persistence reports a live source that has already detached', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const meta = header('detached-live-source')
    const disposeLive = vi.fn()
    const prepared = preparedSource(meta)
    const borrowSession = vi.fn()
      .mockResolvedValueOnce({
        source: 'live', inspection: { meta, events: [] }, [Symbol.dispose]: disposeLive,
      } satisfies BorrowedSessionSource)
      .mockResolvedValueOnce(prepared)
    ctx.provide('sessionPersistence', { borrowSession } as never)

    using observed = await new SessionObservationReader(ctx).read(meta.id, { projectionMode: 'none' })

    expect(observed.source).toBe('prepared')
    expect(borrowSession).toHaveBeenCalledTimes(2)
    expect(disposeLive).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('returns a prepared observation without projections when no registry is mounted', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const meta = header('prepared-without-projections')
    ctx.provide('sessionPersistence', {
      borrowSession: () => Promise.resolve(preparedSource(meta)),
    } as never)

    using observed = await new SessionObservationReader(ctx).read(meta.id)

    expect(observed.source).toBe('prepared')
    expect(observed.projections).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('reference-counts prepared leases and rejects retention after disposal', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const meta = header('prepared-leases')
    const dispose = vi.fn()
    ctx.provide('sessionPersistence', {
      borrowSession: () => Promise.resolve(preparedSource(meta, dispose)),
    } as never)
    const observed = await new SessionObservationReader(ctx).read(meta.id, { projectionMode: 'none' })
    const retained = observed.retain()

    observed[Symbol.dispose]()
    observed[Symbol.dispose]()
    expect(dispose).not.toHaveBeenCalled()
    expect(() => observed.retain()).toThrow('is disposed')
    retained[Symbol.dispose]()
    expect(dispose).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('creates independent live leases and rejects retention after disposal', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('live-leases'), { meta: { cwd: '/workspace' } })
    const reader = new SessionObservationReader(ctx)
    const observed = await reader.read(session.id, { projectionMode: 'none' })
    const retained = observed.retain()

    observed[Symbol.dispose]()
    expect(() => observed.retain()).toThrow('is disposed')
    expect(retained.source).toBe('live')
    retained[Symbol.dispose]()
    await ctx.fiber.dispose()
  })

  it('contains a non-Error persistence rejection', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    ctx.provide('sessionPersistence', {
      // Exercise containment of a backend that violates the Error rejection convention.
      borrowSession: () => Promise.reject('offline'), // oxlint-disable-line typescript/prefer-promise-reject-errors
    } as never)

    await expect(new SessionObservationReader(ctx).read(SessionId('failed'))).rejects.toMatchObject({
      code: 'SESSION_QUERY_PERSISTENCE_FAILED',
      message: expect.stringContaining('unknown error') as string,
    })
    await ctx.fiber.dispose()
  })
})
