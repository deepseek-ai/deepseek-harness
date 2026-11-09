/** One Host roster stream per watched Session, shared by watchers and stopped with the last release. */
import { afterEach, expect, it, vi } from 'vitest'
import { RemoteStream, type ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { streamMethod } from '@deepseek-ai/dsh-remote-mock'
import type {} from '@deepseek-ai/dsh-api-terminal-controller/remote'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TerminalRemote } from '../src/client/model.ts'
import { TerminalRosters } from '../src/client/roster.ts'
import type { WebTerminalId, WebTerminalInfo } from '../src/types.ts'

const sessionId = 'session' as SessionId
const info: WebTerminalInfo = { id: 'agent-terminal' as WebTerminalId, shell: { name: 'zsh', path: '/bin/zsh', args: ['-i'] }, title: 'dev server', cwd: '/workspace', rows: 24, cols: 80, state: 'running', exitCode: null, origin: 'agent', control: 'agent', sandboxMode: 'workspace-write' }
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

function fixture() {
  const sources: ReadableStreamDefaultController<WebTerminalInfo[]>[] = []
  const cancelled: number[] = []
  const remote: Pick<TerminalRemote, 'watch'> = {
    watch: vi.fn<TerminalRemote['watch']>(streamMethod<TerminalRemote['watch']>(async function* (_session, signal) {
      const index = sources.length
      const reader = new ReadableStream<WebTerminalInfo[]>({ start(controller) { sources.push(controller) } }).getReader()
      // Cancelling the reader wakes the pending read so stream disposal can finish this generator.
      signal?.addEventListener('abort', () => { reader.cancel().catch(() => { /* An ended stream already released or errored this reader. */ }) }, { once: true })
      try {
        while (true) {
          const next = await reader.read()
          if (next.done) return
          yield next.value
        }
      } finally {
        cancelled.push(index)
        reader.releaseLock()
      }
    })),
  }
  const gateway: Pick<ClientRemote, '$stream'> = { $stream: options => new RemoteStream({ generation: createSnapshotStore(undefined) }, options) }
  const received = vi.fn<(session: SessionId, terminals: readonly WebTerminalInfo[]) => void>()
  const failed = vi.fn<(error: unknown) => void>()
  const rosters = new TerminalRosters(gateway, remote, received, failed)
  cleanups.push(() => rosters.dispose())
  return { rosters, remote, sources, cancelled, received, failed }
}

it('shares one stream per Session, replays the latest roster to a late watcher and stops with the last release', async () => {
  const h = fixture()
  const first = vi.fn()
  const releaseFirst = h.rosters.watch(sessionId, first)
  await expect.poll(() => h.sources.length).toBe(1)
  h.sources[0]?.enqueue([info])
  await expect.poll(() => first.mock.calls.length).toBe(1)
  expect(h.received).toHaveBeenCalledWith(sessionId, [info])
  const second = vi.fn()
  const releaseSecond = h.rosters.watch(sessionId, second)
  expect(second).toHaveBeenCalledExactlyOnceWith([info])
  expect(h.remote.watch).toHaveBeenCalledOnce()
  releaseFirst()
  releaseFirst()
  expect(h.cancelled).toEqual([])
  releaseSecond()
  await expect.poll(() => h.cancelled).toEqual([0])
  h.rosters.watch(sessionId, vi.fn())
  await expect.poll(() => h.sources.length).toBe(2)
})

it('contains a failing listener while other watchers keep receiving rosters', async () => {
  const h = fixture()
  const failure = new Error('listener failed')
  h.rosters.watch(sessionId, () => { throw failure })
  const healthy = vi.fn()
  h.rosters.watch(sessionId, healthy)
  await expect.poll(() => h.sources.length).toBe(1)
  h.sources[0]?.enqueue([info])
  await expect.poll(() => healthy.mock.calls.length).toBe(1)
  expect(h.failed).toHaveBeenCalledWith(failure)
})

it('reports a stream failure and starts a new stream for the next watcher', async () => {
  const h = fixture()
  h.rosters.watch(sessionId, vi.fn())
  await expect.poll(() => h.sources.length).toBe(1)
  h.sources[0]?.enqueue([info])
  h.sources[0]?.error(new Error('Host method unavailable'))
  await expect.poll(() => h.failed.mock.calls.length).toBe(1)
  h.rosters.watch(sessionId, vi.fn())
  await expect.poll(() => h.sources.length).toBe(2)
})

it('reports a roster that closes before its first frame', async () => {
  const h = fixture()
  h.rosters.watch(sessionId, vi.fn())
  await expect.poll(() => h.sources.length).toBe(1)
  h.sources[0]?.close()
  await expect.poll(() => h.failed.mock.calls.length).toBe(1)
  expect(String(h.failed.mock.calls[0]?.[0])).toContain('ended before its first frame')
})

it('treats an end after the first frame as a carrier interruption rather than a failure', async () => {
  const h = fixture()
  h.rosters.watch(sessionId, vi.fn())
  await expect.poll(() => h.sources.length).toBe(1)
  h.sources[0]?.enqueue([info])
  await expect.poll(() => h.received.mock.calls.length).toBe(1)
  h.sources[0]?.close()
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(h.failed).not.toHaveBeenCalled()
})

it('keeps a replacement stream when an earlier watcher releases after its stream failed', async () => {
  const h = fixture()
  const releaseFailed = h.rosters.watch(sessionId, vi.fn())
  await expect.poll(() => h.sources.length).toBe(1)
  h.sources[0]?.error(new Error('broken'))
  await expect.poll(() => h.failed.mock.calls.length).toBe(1)
  const current = vi.fn()
  h.rosters.watch(sessionId, current)
  await expect.poll(() => h.sources.length).toBe(2)
  releaseFailed()
  h.sources[1]?.enqueue([info])
  await expect.poll(() => current.mock.calls.length).toBe(1)
})

it('reopens a failed stream for its remaining watchers on resume and leaves live streams alone', async () => {
  const h = fixture()
  const watcher = vi.fn()
  h.rosters.watch(sessionId, watcher)
  await expect.poll(() => h.sources.length).toBe(1)
  h.rosters.resume()
  expect(h.remote.watch).toHaveBeenCalledOnce()
  h.sources[0]?.error(new Error('Host method unavailable'))
  await expect.poll(() => h.failed.mock.calls.length).toBe(1)
  h.rosters.resume()
  await expect.poll(() => h.sources.length).toBe(2)
  h.sources[1]?.enqueue([info])
  await expect.poll(() => watcher.mock.calls.length).toBe(1)
  expect(watcher).toHaveBeenCalledWith([info])
})

it('accepts a release that arrives after disposal', async () => {
  const h = fixture()
  const release = h.rosters.watch(sessionId, vi.fn())
  await expect.poll(() => h.sources.length).toBe(1)
  await h.rosters.dispose()
  expect(h.cancelled).toEqual([0])
  release()
  expect(h.remote.watch).toHaveBeenCalledOnce()
})
