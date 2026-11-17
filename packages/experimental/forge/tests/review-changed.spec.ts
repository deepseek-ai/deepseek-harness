import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ChangeRequestRef, ForgeReviewChange, ForgeReviewWrite, ForgeReviewWriteResult, ForgeThreadId,
} from '../src/types.ts'
import { FakeProvider, forgeContext, provide, ref } from './fake-provider.ts'

let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
})

const head = 'a'.repeat(40)
const resolve: ForgeReviewWrite = { kind: 'resolve', headSha: head, thread: 'thread-1' as ForgeThreadId, resolved: true }

/** Record every announced change in order. */
function record(target: Context): [ChangeRequestRef, ForgeReviewChange][] {
  const changes: [ChangeRequestRef, ForgeReviewChange][] = []
  target.on('forge/review-changed', (changed, change) => { changes.push([changed, change]) })
  return changes
}

describe('forge/review-changed', () => {
  it('announces each review write, submission, and viewed mark the host accepted', async () => {
    ctx = await forgeContext()
    const provider = new FakeProvider()
    Object.assign(provider, {
      writeReview: async () => ({ ok: true }),
      submitReview: async () => ({ ok: true, url: 'https://fake.test/Octo/Demo/change/3#review' }),
      viewedFiles: async () => ({ headSha: head, files: {}, truncated: false }),
      setViewed: async () => undefined,
    })
    await provide(ctx, provider)
    const changes = record(ctx)
    const signal = new AbortController().signal

    await ctx.forge.writeReview(ref(3), resolve, signal)
    await ctx.forge.submitReview(ref(3), { kind: 'review', headSha: head, event: 'approve', body: '', comments: [] }, signal)
    await ctx.forge.setViewed(ref(3), { path: 'src/a.ts', viewed: false, headSha: head }, signal)

    await vi.waitFor(() => { expect(changes).toHaveLength(3) })
    expect(changes).toEqual([
      [ref(3), { kind: 'write', write: 'resolve', headSha: head }],
      [ref(3), { kind: 'submit', headSha: head }],
      [ref(3), { kind: 'viewed', path: 'src/a.ts', viewed: false, headSha: head }],
    ])
  })

  it.each(['unsupported', 'stale', 'failed', 'unknown'] as const)('announces nothing for a %s write', async (code) => {
    ctx = await forgeContext()
    const provider = new FakeProvider()
    const result: ForgeReviewWriteResult = { ok: false, code, message: code }
    if (code !== 'unsupported') Object.assign(provider, { writeReview: async () => result })
    await provide(ctx, provider)
    const changes = record(ctx)

    await ctx.forge.writeReview(ref(3), resolve, new AbortController().signal)
    await ctx.forge.submitReview(ref(3), { kind: 'comment', headSha: head, comment: { path: 'a', side: 'R', startLine: 1, endLine: 1, body: 'x' } },
      new AbortController().signal)
    await ctx.forge.setViewed(ref(3), { path: 'src/a.ts', viewed: true, headSha: head }, new AbortController().signal)
    await new Promise(settled => setTimeout(settled, 0))

    expect(changes).toEqual([])
  })

  it('contains a failed listener without changing the write result', async () => {
    ctx = await forgeContext()
    const warning = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const provider = new FakeProvider()
    Object.assign(provider, { writeReview: async () => ({ ok: true }) })
    await provide(ctx, provider)
    ctx.on('forge/review-changed', () => { throw new Error('listener failed') })
    const changes = record(ctx)

    await expect(ctx.forge.writeReview(ref(3), resolve, new AbortController().signal)).resolves.toEqual({ ok: true })
    await vi.waitFor(() => { expect(warning).toHaveBeenCalledWith(expect.stringContaining('review change listener failed')) })
    expect(changes).toHaveLength(1)
  })

  it('stops calling a listener once its plugin fiber is disposed', async () => {
    ctx = await forgeContext()
    const provider = new FakeProvider()
    Object.assign(provider, { writeReview: async () => ({ ok: true }) })
    await provide(ctx, provider)
    const listener = vi.fn()
    const fiber = ctx.plugin({ inject: ['forge'], apply(child: Context) { child.on('forge/review-changed', listener) } })
    await fiber
    await ctx.forge.writeReview(ref(3), resolve, new AbortController().signal)
    await vi.waitFor(() => { expect(listener).toHaveBeenCalledTimes(1) })

    await fiber.dispose()
    await ctx.forge.writeReview(ref(3), resolve, new AbortController().signal)
    await new Promise(settled => setTimeout(settled, 0))
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

describe('mergeBase', () => {
  it('reports a provider without merge bases as unsupported and forwards to one with them', async () => {
    ctx = await forgeContext()
    const provider = new FakeProvider()
    await provide(ctx, provider)
    const signal = new AbortController().signal

    await expect(ctx.forge.mergeBase(ref(3), 'b'.repeat(40), head, signal))
      .resolves.toEqual({ code: 'unsupported', message: 'This provider does not name merge bases' })
    const mergeBase = vi.fn(async () => 'c'.repeat(40))
    Object.assign(provider, { mergeBase })
    await expect(ctx.forge.mergeBase(ref(3), 'b'.repeat(40), head, signal)).resolves.toBe('c'.repeat(40))
    expect(mergeBase).toHaveBeenCalledWith(ref(3), 'b'.repeat(40), head, expect.any(AbortSignal))
  })
})
