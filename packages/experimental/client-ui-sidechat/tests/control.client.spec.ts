/** `/side` forks at the latest completed Turn, opens the child beside the on-screen Session, and reports outcomes once. */
import { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { SidechatControl } from '../src/client/control.ts'
import { sidechatAddress } from '../src/client/resource.ts'

const SOURCE = 'session-source' as SessionId
const MAIN = 'session-main' as SessionId
const CHILD = 'session-child' as SessionId

interface ForkCall {
  sessionId: SessionId
  atSeq?: number | undefined
  origin?: 'side' | undefined
  increaseTitle?: boolean | undefined
  onCreated?: (id: SessionId) => void
}

/** The Host refusal as the Client sees it: name and code survive bundle boundaries, class identity does not. */
function unavailable(): Error {
  return Object.assign(new Error('no completed turn'), { name: 'SessionForkError', rpcError: { code: 'session/fork-unavailable' } })
}

function harness(mounted: SessionId | null = MAIN, origin?: 'subagent') {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const forks: ForkCall[] = []
  const opened: { main: SessionId; address: string }[] = []
  const fork = vi.fn((opts: ForkCall) => {
    forks.push({ sessionId: opts.sessionId, atSeq: opts.atSeq, origin: opts.origin, increaseTitle: opts.increaseTitle })
    opts.onCreated?.(CHILD)
    return Promise.resolve(CHILD)
  })
  ctx.provide('sessions', {
    list: createSnapshotStore({ ids: [SOURCE], byId: { [SOURCE]: { id: SOURCE, ...(origin === undefined ? {} : { origin }) } } }),
    fork,
  })
  ctx.provide('sidebarRight', {
    mounted: createSnapshotStore<SessionId | undefined>(mounted ?? undefined),
    openResourceIn: (main: SessionId, address: string) => { opened.push({ main, address }) },
  })
  const error = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
  const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
  return { control: new SidechatControl(ctx), fork, forks, opened, error, warn }
}

describe('SidechatControl.fork', () => {
  it('leaves the cut to the Host, asks for a numbered title, and opens the child in the mounted Session', async () => {
    const { control, forks, opened } = harness()
    control.fork(SOURCE)
    await vi.waitFor(() => { expect(opened).toHaveLength(1) })
    expect(forks).toEqual([{ sessionId: SOURCE, atSeq: undefined, origin: 'side', increaseTitle: true }])
    expect(opened).toEqual([{ main: MAIN, address: sidechatAddress(CHILD) }])
  })

  it('forks on every call and never without a mounted Session', async () => {
    const h = harness()
    h.control.fork(SOURCE)
    h.control.fork(SOURCE)
    await vi.waitFor(() => { expect(h.opened).toHaveLength(2) })
    expect(h.fork).toHaveBeenCalledTimes(2)
    const none = harness(null)
    none.control.fork(SOURCE)
    expect(none.fork).not.toHaveBeenCalled()
    expect(none.warn).toHaveBeenCalledWith('Side conversation not created: no conversation is on screen')
  })

  it('declines a subagent source with a notice', () => {
    const { control, forks } = harness(MAIN, 'subagent')
    control.fork(SOURCE)
    expect(forks).toEqual([])
    expect(control.notice.getSnapshot()).toEqual({ serial: 1, key: 'subagentSource' })
  })

  it('reports a source without a completed Turn as having no completed turn, without logging', async () => {
    const h = harness()
    h.fork.mockRejectedValueOnce(unavailable())
    h.control.fork(SOURCE)
    await vi.waitFor(() => { expect(h.control.notice.getSnapshot()).toEqual({ serial: 1, key: 'noTurn' }) })
    expect(h.error).not.toHaveBeenCalled()
    expect(h.opened).toEqual([])
  })

  it('reports a same-named fork error without an RPC error as a failed creation', async () => {
    const h = harness()
    h.fork.mockRejectedValueOnce(Object.assign(new Error('local'), { name: 'SessionForkError' }))
    h.control.fork(SOURCE)
    await vi.waitFor(() => { expect(h.control.notice.getSnapshot()).toEqual({ serial: 1, key: 'createFailed' }) })
    expect(h.error).toHaveBeenCalledWith('Side conversation creation failed', expect.any(Error))
  })

  it('reports a failed creation as a dismissable notice and logs it', async () => {
    const h = harness()
    h.fork.mockRejectedValueOnce(new Error('Connection lost'))
    h.control.fork(SOURCE)
    await vi.waitFor(() => { expect(h.control.notice.getSnapshot()).toEqual({ serial: 1, key: 'createFailed' }) })
    expect(h.error).toHaveBeenCalledWith('Side conversation creation failed', expect.any(Error))
    expect(h.opened).toEqual([])
    h.control.dismiss()
    expect(h.control.notice.getSnapshot()).toBeNull()
    h.fork.mockRejectedValueOnce(new Error('Connection lost'))
    h.control.fork(SOURCE)
    await vi.waitFor(() => { expect(h.control.notice.getSnapshot()).toEqual({ serial: 2, key: 'createFailed' }) })
  })

  it('opens a created child whose title rename failed, without a notice', async () => {
    const h = harness()
    h.fork.mockImplementation(async (opts) => { opts.onCreated?.(CHILD); throw new Error('rename failed') })
    h.control.fork(SOURCE)
    await vi.waitFor(() => { expect(h.opened).toEqual([{ main: MAIN, address: sidechatAddress(CHILD) }]) })
    expect(h.control.notice.getSnapshot()).toBeNull()
    expect(h.error).toHaveBeenCalledWith('Side conversation setup failed after creation', expect.any(Error))
  })

  it('neither opens nor reports after disposal', async () => {
    const h = harness()
    const slow = Promise.withResolvers<SessionId>()
    h.fork.mockImplementation(async (opts) => { opts.onCreated?.(CHILD); return slow.promise })
    h.control.fork(SOURCE)
    h.control.dispose()
    slow.resolve(CHILD)
    await vi.waitFor(() => { expect(h.fork.mock.results[0]?.type).toBe('return') })
    await Promise.resolve()
    expect(h.opened).toEqual([])
    const failing = harness()
    failing.fork.mockImplementation(async () => { failing.control.dispose(); throw new Error('late') })
    failing.control.fork(SOURCE)
    await vi.waitFor(() => { expect(failing.error).toHaveBeenCalled() })
    expect(failing.control.notice.getSnapshot()).toBeNull()
  })
})
