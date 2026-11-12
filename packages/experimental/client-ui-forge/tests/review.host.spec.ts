import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ChangeRequestRef, ForgeCommentId, ForgeFailure, ForgeReviewData, ForgeReviewId, ForgeReviewWrite, ForgeReviewWriteResult, ForgeThreadId,
} from '@deepseek-ai/dsh-experimental-forge'
import type { SessionId } from '@deepseek-ai/dsh-session'
import ForgePanelController from '../src/index.ts'
import type { ForgePanelState } from '../src/index.ts'
import { bench, follow, git, pullUrl, repository, scratch, shellTurn } from './harness.ts'
import type { Bench, Follower } from './harness.ts'
import { brandString } from '@deepseek-ai/dsh-brand'

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const signal = new AbortController().signal
const HEAD = 'a'.repeat(40)

async function opened(config: Parameters<typeof bench>[1] = {}): Promise<{ opened: Bench; follower: Follower; repo: string }> {
  const { path, remove } = await scratch('dsh-forge-review-')
  cleanups.push(remove)
  const repo = await repository(path)
  await git(repo, 'remote', 'add', 'origin', 'https://fake.test/octo/demo.git')
  const result = await bench(repo, config)
  cleanups.push(() => result.ctx.fiber.dispose())
  const follower = follow(result.ctx, result.session)
  cleanups.push(follower.stop)
  return { opened: result, follower, repo }
}

function review(headSha: string, path = 'src/a.ts'): ForgeReviewData {
  return {
    headSha, viewer: 'octo', truncated: false, pendingReview: null, viewerCanReview: true,
    threads: [{
      id: 'thread-1' as ForgeThreadId, path, side: 'R', subject: 'line', resolved: false, diffHunk: '@@ -1 +1 @@\n-old\n+new',
      current: { commit: headSha, startLine: 1, endLine: 1 }, original: { commit: headSha, startLine: 1, endLine: 1 }, comments: [],
      viewerCanReply: true, viewerCanResolve: true,
    }],
  }
}

/** Whether the change request at `url` holds a snapshot with the given head and update time. */
function polledAt(state: ForgePanelState, url: string, headSha = HEAD, updatedAt?: string): boolean {
  const snapshot = state.changeRequests.find(entry => entry.url === url)?.snapshot ?? null
  return snapshot !== null && snapshot.headSha === headSha && (updatedAt === undefined || snapshot.updatedAt === updatedAt)
}

describe('forgePanel change request reviews', () => {
  it('reports each accepted review change of any plugin on the bound entry and reads the threads again after it', async () => {
    const { opened: panel, follower } = await opened()
    const readReview = vi.fn(async (_ref: ChangeRequestRef, headSha: string): Promise<ForgeReviewData | ForgeFailure> => review(headSha))
    Object.assign(panel.provider, { readReview, writeReview: async () => ({ ok: true }) })
    shellTurn(panel.session, 1, [{ callId: 'create', command: 'gh pr create --fill', output: `${pullUrl(7)}\n` }])
    const polled = await follower.until(state => polledAt(state, pullUrl(7)))
    expect(polled.changeRequests[0]?.reviewRevision).toBe(0)
    await panel.ctx.forgePanel.changeRequestReview(panel.session, pullUrl(7), HEAD, false, signal)
    const ref = polled.changeRequests[0]?.ref
    if (ref === null || ref === undefined) throw new Error('unbound')

    // Another plugin writes through `ctx.forge`, not through this panel.
    await panel.ctx.forge.writeReview(ref, { kind: 'resolve', headSha: HEAD, thread: 'thread-1' as ForgeThreadId, resolved: true }, signal)
    await follower.until(state => state.changeRequests[0]?.reviewRevision === 1)
    await panel.ctx.forgePanel.changeRequestReview(panel.session, pullUrl(7), HEAD, false, signal)
    expect(readReview).toHaveBeenCalledTimes(2)
  })


  it('reads threads at the displayed head and reuses them for every Session until the update time changes', async () => {
    const { opened: panel, follower, repo } = await opened()
    const readReview = vi.fn(async (_ref: ChangeRequestRef, headSha: string): Promise<ForgeReviewData | ForgeFailure> => review(headSha))
    Object.assign(panel.provider, { readReview })
    shellTurn(panel.session, 1, [{ callId: 'create', command: 'gh pr create --fill', output: `${pullUrl(7)}\n` }])
    await follower.until(state => polledAt(state, pullUrl(7)))

    await expect(panel.ctx.forgePanel.changeRequestReview(panel.session, pullUrl(7), HEAD, false, signal)).resolves.toEqual(review(HEAD))
    const other = panel.ctx.sessions.create(brandString<SessionId>('forge-review-other'), { meta: { cwd: repo } })
    panel.ctx.forgeSession.track(other, pullUrl(7))
    await expect(panel.ctx.forgePanel.changeRequestReview(other, pullUrl(7), HEAD, false, signal)).resolves.toEqual(review(HEAD))
    expect(readReview).toHaveBeenCalledTimes(1)

    panel.provider.overrides.set(7, { updatedAt: '2026-11-07T05:00:00Z' })
    await panel.ctx.forgePanel.refresh(panel.session, signal)
    await follower.until(state => polledAt(state, pullUrl(7), HEAD, '2026-11-07T05:00:00Z'))
    readReview.mockResolvedValueOnce(review(HEAD, 'src/b.ts'))
    await expect(panel.ctx.forgePanel.changeRequestReview(panel.session, pullUrl(7), HEAD, false, signal))
      .resolves.toMatchObject({ threads: [{ path: 'src/b.ts' }] })
    expect(readReview).toHaveBeenCalledTimes(2)
  })

  it('reads from the host for a fresh read and keeps its result for later reads', async () => {
    const { opened: panel, follower } = await opened()
    const readReview = vi.fn(async (_ref: ChangeRequestRef, headSha: string): Promise<ForgeReviewData | ForgeFailure> => review(headSha))
    Object.assign(panel.provider, { readReview })
    shellTurn(panel.session, 1, [{ callId: 'create', command: 'gh pr create --fill', output: `${pullUrl(7)}\n` }])
    await follower.until(state => polledAt(state, pullUrl(7)))

    await panel.ctx.forgePanel.changeRequestReview(panel.session, pullUrl(7), HEAD, false, signal)
    readReview.mockResolvedValueOnce(review(HEAD, 'src/b.ts'))
    await expect(panel.ctx.forgePanel.changeRequestReview(panel.session, pullUrl(7), HEAD, true, signal))
      .resolves.toMatchObject({ threads: [{ path: 'src/b.ts' }] })
    await expect(panel.ctx.forgePanel.changeRequestReview(panel.session, pullUrl(7), HEAD, false, signal))
      .resolves.toMatchObject({ threads: [{ path: 'src/b.ts' }] })
    expect(readReview).toHaveBeenCalledTimes(2)
  })

  it('reads again once the kept threads reach reviewRefreshMs', async () => {
    const { opened: panel, follower } = await opened({ reviewRefreshMs: 1 })
    const readReview = vi.fn(async (_ref: ChangeRequestRef, headSha: string): Promise<ForgeReviewData | ForgeFailure> => review(headSha))
    Object.assign(panel.provider, { readReview })
    shellTurn(panel.session, 1, [{ callId: 'create', command: 'gh pr create --fill', output: `${pullUrl(7)}\n` }])
    await follower.until(state => polledAt(state, pullUrl(7)))

    await panel.ctx.forgePanel.changeRequestReview(panel.session, pullUrl(7), HEAD, false, signal)
    await new Promise(resolve => setTimeout(resolve, 5))
    await panel.ctx.forgePanel.changeRequestReview(panel.session, pullUrl(7), HEAD, false, signal)
    expect(readReview).toHaveBeenCalledTimes(2)
  })

  it('refuses a head other than the latest status without reading, and polls again when the host names another head', async () => {
    const { opened: panel, follower } = await opened()
    const pushed = 'b'.repeat(40)
    const readReview = vi.fn(async (): Promise<ForgeReviewData | ForgeFailure> => ({ code: 'stale', message: `head moved to ${pushed}` }))
    Object.assign(panel.provider, { readReview })
    shellTurn(panel.session, 1, [{ callId: 'create', command: 'gh pr create --fill', output: `${pullUrl(7)}\n` }])
    await follower.until(state => polledAt(state, pullUrl(7)))

    await expect(panel.ctx.forgePanel.changeRequestReview(panel.session, pullUrl(7), pushed, false, signal))
      .rejects.toMatchObject({ code: 'forgePanel/stale-head', message: `The change request head moved from ${pushed} to ${HEAD}` })
    expect(readReview).not.toHaveBeenCalled()

    panel.provider.overrides.set(7, { headSha: pushed })
    const fetches = panel.provider.fetches.length
    await expect(panel.ctx.forgePanel.changeRequestReview(panel.session, pullUrl(7), HEAD, false, signal))
      .rejects.toMatchObject({ code: 'forgePanel/stale-head', message: `head moved to ${pushed}` })
    await follower.until(state => polledAt(state, pullUrl(7), pushed))
    expect(panel.provider.fetches.length).toBe(fetches + 1)
  })

  it('reports an unbound change request, one not read yet, a provider without review reads, and a failed read, keeping no failure', async () => {
    const { opened: panel, follower } = await opened()
    panel.provider.failures.set(8, { code: 'unavailable', message: 'down' })
    shellTurn(panel.session, 1, [
      { callId: 'seven', command: 'gh pr create --fill', output: `${pullUrl(7)}\n` },
      { callId: 'eight', command: 'gh pr create --fill', output: `${pullUrl(8)}\n` },
    ])
    await follower.until(state => polledAt(state, pullUrl(7))
      && state.changeRequests.some(entry => entry.url === pullUrl(8) && entry.update !== null && 'failure' in entry.update))
    const read = (url: string): Promise<ForgeReviewData> =>
      panel.ctx.forgePanel.changeRequestReview(panel.session, url, HEAD, false, signal)

    await expect(read(pullUrl(9))).rejects.toMatchObject({ code: 'forgePanel/not-bound' })
    await expect(read(pullUrl(8))).rejects.toMatchObject({ code: 'forgePanel/review-failed', message: 'The change request status has not been read yet' })
    await expect(read(pullUrl(7)))
      .rejects.toMatchObject({ code: 'forgePanel/review-unsupported', message: 'This provider does not support review reads' })
    const codes = ['too-large', 'not-found', 'unauthenticated', 'unavailable'] as const
    const readReview = vi.fn(async (): Promise<ForgeReviewData | ForgeFailure> => ({ code: 'unavailable', message: 'down' }))
    Object.assign(panel.provider, { readReview })
    for (const code of codes) {
      readReview.mockResolvedValueOnce({ code, message: `threads ${code}` })
      await expect(read(pullUrl(7))).rejects.toMatchObject({ code: 'forgePanel/review-failed', message: `threads ${code}` })
    }
    expect(readReview).toHaveBeenCalledTimes(codes.length)
  })

  it('writes through the provider, then drops the kept threads so the next read goes to the host', async () => {
    const { opened: panel, follower } = await opened()
    const readReview = vi.fn(async (_ref: ChangeRequestRef, headSha: string): Promise<ForgeReviewData | ForgeFailure> => review(headSha))
    const writeReview = vi.fn(async (): Promise<ForgeReviewWriteResult> => ({ ok: true }))
    Object.assign(panel.provider, { readReview, writeReview })
    shellTurn(panel.session, 1, [{ callId: 'create', command: 'gh pr create --fill', output: `${pullUrl(7)}\n` }])
    await follower.until(state => polledAt(state, pullUrl(7)))
    const write: ForgeReviewWrite = { kind: 'resolve', headSha: HEAD, thread: 'thread-1' as ForgeThreadId, resolved: true }

    await panel.ctx.forgePanel.changeRequestReview(panel.session, pullUrl(7), HEAD, false, signal)
    await expect(panel.ctx.forgePanel.changeRequestReviewWrite(panel.session, pullUrl(7), write, signal)).resolves.toEqual({ ok: true })
    expect(writeReview).toHaveBeenCalledWith(expect.objectContaining({ number: 7 }), write, expect.any(AbortSignal))
    await panel.ctx.forgePanel.changeRequestReview(panel.session, pullUrl(7), HEAD, false, signal)
    expect(readReview).toHaveBeenCalledTimes(2)

    writeReview.mockRejectedValueOnce(new Error('gh crashed'))
    await expect(panel.ctx.forgePanel.changeRequestReviewWrite(panel.session, pullUrl(7), write, signal)).rejects.toThrow('gh crashed')
    await panel.ctx.forgePanel.changeRequestReview(panel.session, pullUrl(7), HEAD, false, signal)
    expect(readReview).toHaveBeenCalledTimes(3)
  })

  it('keeps no threads read before a write that settled during the read', async () => {
    const { opened: panel, follower } = await opened()
    const reading = Promise.withResolvers<ForgeReviewData>()
    const readReview = vi.fn(async (_ref: ChangeRequestRef, headSha: string): Promise<ForgeReviewData | ForgeFailure> => review(headSha))
    readReview.mockReturnValueOnce(reading.promise)
    Object.assign(panel.provider, { readReview, writeReview: async (): Promise<ForgeReviewWriteResult> => ({ ok: true }) })
    shellTurn(panel.session, 1, [{ callId: 'create', command: 'gh pr create --fill', output: `${pullUrl(7)}\n` }])
    await follower.until(state => polledAt(state, pullUrl(7)))

    const first = panel.ctx.forgePanel.changeRequestReview(panel.session, pullUrl(7), HEAD, false, signal)
    await vi.waitFor(() => { expect(readReview).toHaveBeenCalledTimes(1) })
    await panel.ctx.forgePanel.changeRequestReviewWrite(panel.session, pullUrl(7),
      { kind: 'delete-comment', headSha: HEAD, comment: 'comment-1' as ForgeCommentId }, signal)
    reading.resolve(review(HEAD, 'src/before.ts'))
    await expect(first).resolves.toMatchObject({ threads: [{ path: 'src/before.ts' }] })
    await expect(panel.ctx.forgePanel.changeRequestReview(panel.session, pullUrl(7), HEAD, false, signal))
      .resolves.toMatchObject({ threads: [{ path: 'src/a.ts' }] })
    expect(readReview).toHaveBeenCalledTimes(2)
  })

  it('reports a provider without review writes as unsupported and refuses an unbound change request and invalid writes', async () => {
    const { opened: panel, follower } = await opened()
    shellTurn(panel.session, 1, [{ callId: 'create', command: 'gh pr create --fill', output: `${pullUrl(7)}\n` }])
    await follower.until(state => polledAt(state, pullUrl(7)))
    const write = (url: string, value: ForgeReviewWrite): Promise<ForgeReviewWriteResult> =>
      panel.ctx.forgePanel.changeRequestReviewWrite(panel.session, url, value, signal)
    const thread = 'thread-1' as ForgeThreadId
    const comment = 'comment-1' as ForgeCommentId
    const reviewId = 'review-1' as ForgeReviewId
    const line = { path: 'src/a.ts', side: 'R' as const, startLine: 2, endLine: 3, body: 'Check' }

    await expect(write(pullUrl(7), { kind: 'resolve', headSha: HEAD, thread, resolved: false }))
      .resolves.toEqual({ ok: false, code: 'unsupported', message: 'This provider does not support review writes' })
    await expect(write(pullUrl(9), { kind: 'resolve', headSha: HEAD, thread, resolved: false })).rejects.toMatchObject({ code: 'forgePanel/not-bound' })
    await expect(write(pullUrl(7), { kind: 'resolve', headSha: 'main', thread, resolved: false })).rejects.toThrow('Invalid review commit')
    const invalid: ForgeReviewWrite[] = [
      { kind: 'reply', headSha: HEAD, thread, body: ' ', pending: false },
      { kind: 'reply', headSha: HEAD, thread: '' as ForgeThreadId, body: 'Done', pending: false },
      { kind: 'resolve', headSha: HEAD, thread: '' as ForgeThreadId, resolved: true },
      { kind: 'edit-comment', headSha: HEAD, comment, body: '' },
      { kind: 'edit-comment', headSha: HEAD, comment: '' as ForgeCommentId, body: 'Text' },
      { kind: 'delete-comment', headSha: HEAD, comment: '' as ForgeCommentId },
      { kind: 'add-pending', headSha: HEAD, comment: { ...line, path: '' } },
      { kind: 'add-pending', headSha: HEAD, comment: { ...line, body: '\n' } },
      { kind: 'add-pending', headSha: HEAD, comment: { ...line, startLine: 0 } },
      { kind: 'add-pending', headSha: HEAD, comment: { ...line, startLine: 1.5 } },
      { kind: 'add-pending', headSha: HEAD, comment: { ...line, endLine: 1 } },
      { kind: 'add-pending', headSha: HEAD, comment: { ...line, endLine: Number.POSITIVE_INFINITY } },
      { kind: 'submit-pending', headSha: HEAD, review: '' as ForgeReviewId, event: 'comment', body: '' },
      { kind: 'submit-pending', headSha: HEAD, review: reviewId, event: 'request-changes', body: ' ' },
      { kind: 'discard-pending', headSha: HEAD, review: '' as ForgeReviewId },
    ]
    for (const value of invalid) await expect(write(pullUrl(7), value)).rejects.toThrow('Invalid review write')
    const valid: ForgeReviewWrite[] = [
      { kind: 'reply', headSha: HEAD, thread, body: 'Done', pending: true },
      { kind: 'edit-comment', headSha: HEAD, comment, body: 'Text' },
      { kind: 'delete-comment', headSha: HEAD, comment },
      { kind: 'add-pending', headSha: HEAD, comment: line },
      { kind: 'submit-pending', headSha: HEAD, review: reviewId, event: 'approve', body: '' },
      { kind: 'submit-pending', headSha: HEAD, review: reviewId, event: 'request-changes', body: 'Fix it' },
      { kind: 'discard-pending', headSha: HEAD, review: reviewId },
    ]
    for (const value of valid) await expect(write(pullUrl(7), value)).resolves.toMatchObject({ ok: false, code: 'unsupported' })
  })

  it('drops the kept threads after publishing a comment so the next read shows it', async () => {
    const { opened: panel, follower } = await opened()
    const readReview = vi.fn(async (_ref: ChangeRequestRef, headSha: string): Promise<ForgeReviewData | ForgeFailure> => review(headSha))
    Object.assign(panel.provider, { readReview, submitReview: async () => ({ ok: true as const, url: `${pullUrl(7)}#discussion_r1` }) })
    shellTurn(panel.session, 1, [{ callId: 'create', command: 'gh pr create --fill', output: `${pullUrl(7)}\n` }])
    await follower.until(state => polledAt(state, pullUrl(7)))

    await panel.ctx.forgePanel.changeRequestReview(panel.session, pullUrl(7), HEAD, false, signal)
    await panel.ctx.forgePanel.submitReview(panel.session, pullUrl(7),
      { kind: 'comment', headSha: HEAD, comment: { path: 'src/a.ts', side: 'R', startLine: 1, endLine: 1, body: 'Nit' } }, signal)
    await panel.ctx.forgePanel.changeRequestReview(panel.session, pullUrl(7), HEAD, false, signal)
    expect(readReview).toHaveBeenCalledTimes(2)
  })

  it.each([
    [{ reviewRefreshMs: 0 }, 'forge-panel: reviewRefreshMs must be a positive integer no greater than 2147483647'],
    [{ reviewRefreshMs: 2_147_483_648 }, 'forge-panel: reviewRefreshMs must be a positive integer no greater than 2147483647'],
    [{ maxCachedReviewBytes: 1.5 }, 'forge-panel: maxCachedReviewBytes must be a positive integer'],
  ])('rejects %j at load', async (config, message) => {
    const { opened: panel } = await opened()
    await panel.panel.dispose()

    await expect(panel.ctx.plugin(ForgePanelController, config)).rejects.toThrow(message)
  })
})
