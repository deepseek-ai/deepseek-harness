// @vitest-environment jsdom
/** The comparison store: served and missing comparisons stay, failures retry, resets and disposal forget. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { changesDiffUrl, type ChangesDiff } from '../src/changes.ts'
import { ChangesDiffStore } from '../src/client/changes-diff.ts'

afterEach(() => { vi.unstubAllGlobals() })

const SESSION = SessionId('viewed')
const URL_ = changesDiffUrl(SESSION, 5, 1)
const text: ChangesDiff = {
  kind: 'text', path: 'a.ts', display: 'a.ts', before: true, after: true, coarse: false,
  hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }],
}

describe('ChangesDiffStore', () => {
  it('keeps served and missing comparisons, retries failures, and forgets on reset and disposal', async () => {
    const fetcher = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>()
    vi.stubGlobal('fetch', fetcher)
    const store = new ChangesDiffStore()
    fetcher.mockResolvedValueOnce(Response.json(text))
    await store.load(SESSION, 5, 1)
    expect(store.state.getSnapshot()[URL_]).toEqual(text)
    await store.load(SESSION, 5, 1)
    expect(fetcher).toHaveBeenCalledTimes(1)
    fetcher.mockResolvedValueOnce(new Response('gone', { status: 404 }))
    await store.load(SESSION, 5, 2)
    expect(store.state.getSnapshot()[changesDiffUrl(SESSION, 5, 2)]).toBe('missing')
    await store.load(SESSION, 5, 2)
    expect(fetcher).toHaveBeenCalledTimes(2)
    fetcher.mockResolvedValueOnce(new Response('boom', { status: 500 }))
    await store.load(SESSION, 5, 3)
    expect(store.state.getSnapshot()[changesDiffUrl(SESSION, 5, 3)]).toBe('error')
    fetcher.mockResolvedValueOnce(Response.json({ kind: 'text' }))
    await store.load(SESSION, 5, 3)
    expect(store.state.getSnapshot()[changesDiffUrl(SESSION, 5, 3)]).toBe('error')
    fetcher.mockRejectedValueOnce(new Error('offline'))
    await store.load(SESSION, 5, 3)
    expect(store.state.getSnapshot()[changesDiffUrl(SESSION, 5, 3)]).toBe('error')
    fetcher.mockResolvedValueOnce(Response.json({ kind: 'oversized', path: 'p', display: 'p' }))
    await store.load(SESSION, 5, 3)
    expect(store.state.getSnapshot()[changesDiffUrl(SESSION, 5, 3)]).toEqual({ kind: 'oversized', path: 'p', display: 'p' })
    store.reset()
    expect(store.state.getSnapshot()).toEqual({})
    let settle!: (response: Response) => void
    fetcher.mockReturnValueOnce(new Promise<Response>((resolve) => { settle = resolve }))
    const stale = store.load(SESSION, 5, 1)
    expect(store.state.getSnapshot()[URL_]).toBe('loading')
    store.reset()
    settle(Response.json(text))
    await stale
    expect(store.state.getSnapshot()[URL_]).toBeUndefined()
    fetcher.mockReturnValueOnce(new Promise<Response>((resolve) => { settle = resolve }))
    const late = store.load(SESSION, 5, 1)
    const disposal = store.dispose()
    settle(Response.json(text))
    await Promise.all([late, disposal])
    expect(store.state.getSnapshot()[URL_]).toBe('loading')
    await store.load(SESSION, 6, 0)
    expect(store.state.getSnapshot()[changesDiffUrl(SESSION, 6, 0)]).toBeUndefined()
  })
})
