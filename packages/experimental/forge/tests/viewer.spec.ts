import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChangeRequestActivity, ChangeRequestDescription, ForgeViewerList, ForgeViewerQuery } from '../src/types.ts'
import { FakeProvider, forgeContext, provide, ref } from './fake-provider.ts'

let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
})

const signal = new AbortController().signal

const query: ForgeViewerQuery = { host: 'fake.test', filter: 'review-requested', repository: null, limit: 20 }

const list: ForgeViewerList = { viewer: 'octo', items: [], total: 0 }

/** Give the fake provider viewer lists on `fake.test`: review requests and authored change requests. */
function withViewer(provider: FakeProvider): { listForViewer: ReturnType<typeof vi.fn>; countForViewer: ReturnType<typeof vi.fn> } {
  const listForViewer = vi.fn(async () => list)
  const countForViewer = vi.fn(async () => new Map([['review-requested', 3], ['authored', 1]]))
  Object.assign(provider, {
    viewer: { hosts: ['fake.test'], filters: new Set(['review-requested', 'authored']), maxItems: 40 },
    listForViewer,
    countForViewer,
  })
  return { listForViewer, countForViewer }
}

describe('forge viewer lists', () => {
  it('lists the viewer sources of providers that declare and read viewer lists, in registration order', async () => {
    ctx = await forgeContext()
    const plain = new FakeProvider('plain')
    const declaredOnly = new FakeProvider('declared')
    Object.assign(declaredOnly, { viewer: { hosts: ['declared.test'], filters: new Set(['authored']), maxItems: 5 } })
    const lister = new FakeProvider()
    withViewer(lister)
    await provide(ctx, plain)
    await provide(ctx, declaredOnly)
    await provide(ctx, lister)

    expect(ctx.forge.viewerSources()).toEqual([
      { forge: 'fake', hosts: ['fake.test'], filters: new Set(['review-requested', 'authored']), maxItems: 40 },
    ])
  })

  it('delegates a viewer list read and a count to the provider of the forge', async () => {
    ctx = await forgeContext()
    const provider = new FakeProvider()
    const { listForViewer, countForViewer } = withViewer(provider)
    await provide(ctx, provider)

    await expect(ctx.forge.listForViewer('fake', query, signal)).resolves.toBe(list)
    expect(listForViewer).toHaveBeenCalledWith(query, expect.any(AbortSignal))
    await expect(ctx.forge.countForViewer('fake', 'fake.test', signal)).resolves.toEqual(new Map([['review-requested', 3], ['authored', 1]]))
    expect(countForViewer).toHaveBeenCalledWith('fake.test', expect.any(AbortSignal))
  })

  it('reports a provider without viewer lists, another host, and another list as unsupported without asking the provider', async () => {
    ctx = await forgeContext()
    const bare = new FakeProvider('bare')
    const provider = new FakeProvider()
    const { listForViewer, countForViewer } = withViewer(provider)
    await provide(ctx, bare)
    await provide(ctx, provider)

    await expect(ctx.forge.listForViewer('bare', query, signal))
      .resolves.toEqual({ code: 'unsupported', message: 'This provider does not read viewer lists' })
    await expect(ctx.forge.countForViewer('bare', 'fake.test', signal))
      .resolves.toEqual({ code: 'unsupported', message: 'This provider does not read viewer lists' })
    await expect(ctx.forge.listForViewer('fake', { ...query, host: 'other.test' }, signal))
      .resolves.toEqual({ code: 'unsupported', message: 'This provider does not list change requests on other.test' })
    await expect(ctx.forge.countForViewer('fake', 'other.test', signal))
      .resolves.toEqual({ code: 'unsupported', message: 'This provider does not list change requests on other.test' })
    await expect(ctx.forge.listForViewer('fake', { ...query, filter: 'involved' }, signal))
      .resolves.toEqual({ code: 'unsupported', message: 'This provider does not read the involved list' })
    expect(listForViewer).not.toHaveBeenCalled()
    expect(countForViewer).not.toHaveBeenCalled()
  })

  it('rejects a viewer read for a forge without a provider', async () => {
    ctx = await forgeContext()
    await expect(ctx.forge.listForViewer('missing', query, signal)).rejects.toThrow('no provider is registered for "missing"')
  })
})

describe('forge descriptions', () => {
  it('delegates a description read and reports a provider without it as unsupported', async () => {
    ctx = await forgeContext()
    const provider = new FakeProvider()
    await provide(ctx, provider)

    await expect(ctx.forge.readDescription(ref(4), signal))
      .resolves.toEqual({ code: 'unsupported', message: 'This provider does not read descriptions' })
    const description: ChangeRequestDescription = {
      body: 'Body', labels: [], labelsTruncated: false, images: {}, imagesExpireAt: null, createdAt: '2026-11-10T00:00:00Z',
    }
    const readDescription = vi.fn(async () => description)
    Object.assign(provider, { readDescription })
    await expect(ctx.forge.readDescription(ref(4), signal)).resolves.toBe(description)
    expect(readDescription).toHaveBeenCalledWith(ref(4), expect.any(AbortSignal))
  })
})

describe('forge activity', () => {
  it('delegates an activity read and reports a provider without it as unsupported', async () => {
    ctx = await forgeContext()
    const provider = new FakeProvider()
    await provide(ctx, provider)

    await expect(ctx.forge.readActivity(ref(4), signal))
      .resolves.toEqual({ code: 'unsupported', message: 'This provider does not read activity' })
    const activity: ChangeRequestActivity = {
      items: [{ kind: 'comment', at: '2026-11-10T00:00:00Z', actor: null, body: 'Looks good', url: null }], truncated: false, viewerCanComment: true,
    }
    const readActivity = vi.fn(async () => activity)
    Object.assign(provider, { readActivity })
    await expect(ctx.forge.readActivity(ref(4), signal)).resolves.toBe(activity)
    expect(readActivity).toHaveBeenCalledWith(ref(4), expect.any(AbortSignal))
  })

  it('fails a comment for a provider that adds none and forwards it to one that does', async () => {
    ctx = await forgeContext()
    const provider = new FakeProvider()
    await provide(ctx, provider)

    await expect(ctx.forge.addComment(ref(4), 'Thanks', signal)).resolves.toEqual({ code: 'failed', message: 'This provider adds no comments' })
    const addComment = vi.fn(async () => undefined)
    Object.assign(provider, { addComment })
    await expect(ctx.forge.addComment(ref(4), 'Thanks', signal)).resolves.toBeUndefined()
    expect(addComment).toHaveBeenCalledWith(ref(4), 'Thanks', expect.any(AbortSignal))
    addComment.mockResolvedValueOnce({ code: 'unknown', message: 'no answer' } as never)
    await expect(ctx.forge.addComment(ref(4), 'Thanks', signal)).resolves.toEqual({ code: 'unknown', message: 'no answer' })
  })
})
