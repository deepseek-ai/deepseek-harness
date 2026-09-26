/** Browser view ownership across slow RPCs, remounts and transport generations. */
import { setImmediate } from 'node:timers/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { RemoteStream, RemoteStreamCarrierError, type ClientRemote, type RemoteStreamOptions } from '@deepseek-ai/dsh-api-gateway/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { streamMethod } from '@deepseek-ai/dsh-remote-mock'
import type {} from '@deepseek-ai/dsh-api-terminal-controller/remote'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { TerminalView, type TerminalRemote } from '../src/client/model.ts'
import type { TerminalEnvironment, TerminalFrame, WebTerminalId, WebTerminalInfo } from '../src/types.ts'

const sessionId = 'session' as SessionId
const info: WebTerminalInfo = { id: 'terminal' as WebTerminalId, shell: { name: 'bash', path: '/bin/bash', args: ['-i'] }, title: 'bash', cwd: '/workspace', rows: 24, cols: 80, state: 'running', exitCode: null }
const environment: TerminalEnvironment = {
  cwd: info.cwd, maxInputBytes: 1000, maxCols: 200, maxRows: 100, scrollback: 100,
}
const success = <T>(value: T): RemoteResult<T> => ({ ok: true, value })
const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })

function untilAborted(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) resolve()
    else signal?.addEventListener('abort', () => { resolve() }, { once: true })
  })
}

function failure(message: string): RemoteResult<never> {
  return { ok: false, error: new RemoteError('gateway/bad-request', message, {}) }
}

function fixture(prepareStream?: <Item>(stream: RemoteStream<Item>) => void) {
  const remote: TerminalRemote = {
    retain: vi.fn<TerminalRemote['retain']>(streamMethod<TerminalRemote['retain']>(async function* (_session, _id, signal) {
      yield { type: 'retained' }
      await new Promise<void>((resolve) => {
        if (signal?.aborted) resolve()
        else signal?.addEventListener('abort', () => { resolve() }, { once: true })
      })
    })),
    shells: vi.fn<TerminalRemote['shells']>(async () => success([info.shell])),
    environment: vi.fn<TerminalRemote['environment']>(async () => success(environment)), list: vi.fn<TerminalRemote['list']>(async () => success([])),
    create: vi.fn<TerminalRemote['create']>(async (_sessionId, request) => success({ ...info, id: request.id })),
    close: vi.fn<TerminalRemote['close']>(async () => success(undefined)), rename: vi.fn<TerminalRemote['rename']>(async () => success(undefined)),
    write: vi.fn<TerminalRemote['write']>(async () => success(undefined)), resize: vi.fn<TerminalRemote['resize']>(async () => success(undefined)),
    follow: vi.fn<TerminalRemote['follow']>(streamMethod<TerminalRemote['follow']>(async function* (_sessionId, id, attachmentId, signal) {
      yield { type: 'snapshot', sequence: 0, screen: 'ready', info: { ...info, id, controllerId: attachmentId } }
      await untilAborted(signal)
    })),
  }
  const options: RemoteStreamOptions<unknown>[] = []
  const streams: { dispose(): Promise<void>; restart(): void }[] = []
  const generation = createSnapshotStore<ReturnType<ConstructorParameters<typeof RemoteStream>[0]['generation']['getSnapshot']>>(undefined)
  const gateway: Pick<ClientRemote, '$stream'> = {
    $stream: (option) => {
      options.push(option)
      const stream = new RemoteStream({ generation }, option)
      streams.push(stream)
      prepareStream?.(stream)
      return stream
    },
  }
  cleanups.push(async () => { await Promise.all(streams.map(stream => stream.dispose())) })
  const model = new TerminalView(sessionId, remote, gateway, info.id)
  cleanups.push(() => model.dispose())
  return { model, remote, gateway, options, streams, generation }
}

async function mount(model: TerminalView) {
  const detach = model.mount()
  await model.refresh()
  return detach
}

function acknowledge(model: TerminalView): void {
  const render = model.state.getSnapshot().render
  if (render !== undefined) model.acknowledge(render.revision)
}

async function connected(model: TerminalView): Promise<void> {
  await mount(model)
  await expect.poll(() => model.state.getSnapshot().writable).toBe(true)
  acknowledge(model)
}

it('does not let a late input failure downgrade a newer connection', async () => {
  const { model, remote } = fixture()
  await mount(model)
  await expect.poll(() => model.state.getSnapshot().writable).toBe(true)
  acknowledge(model)
  const input = Promise.withResolvers<RemoteResult<void>>()
  vi.mocked(remote.write).mockReturnValueOnce(input.promise)
  model.write('x')
  await expect.poll(() => vi.mocked(remote.write).mock.calls.length).toBe(1)
  model.connect()
  await expect.poll(() => vi.mocked(remote.follow).mock.calls.length).toBe(2)
  await expect.poll(() => model.state.getSnapshot().writable).toBe(true)
  model.write('current input')
  input.reject(new Error('old attachment was replaced'))
  await expect.poll(() => vi.mocked(remote.write).mock.calls.some(call => call[3] === 'current input')).toBe(true)
  expect(model.state.getSnapshot()).toMatchObject({ phase: 'connected', writable: true, error: undefined })
})

it('waits for render acknowledgement before publishing subsequent output', async () => {
  const { model, remote } = fixture()
  vi.mocked(remote.follow).mockImplementation(streamMethod<TerminalRemote['follow']>(async function* (_sessionId, id, controllerId, signal) {
    const frames: TerminalFrame[] = [
      { type: 'snapshot', sequence: 0, screen: '', info: { ...info, id, controllerId } },
      { type: 'output', sequence: 1, data: 'first' },
      { type: 'output', sequence: 2, data: 'second' },
    ]
    for (const frame of frames) yield frame
    await untilAborted(signal)
  }))
  await mount(model)
  await expect.poll(() => model.state.getSnapshot().render?.frame.type).toBe('snapshot')
  acknowledge(model)
  await expect.poll(() => model.state.getSnapshot().render?.frame).toMatchObject({ type: 'output', sequence: 1 })
  acknowledge(model)
  await expect.poll(() => model.state.getSnapshot().render?.frame).toMatchObject({ type: 'output', sequence: 2 })
})

it('serializes input and resizes, clamps geometry, and suppresses unchanged sizes', async () => {
  const { model, remote } = fixture()
  await connected(model)
  const input = Promise.withResolvers<RemoteResult<void>>()
  vi.mocked(remote.write).mockReturnValueOnce(input.promise)
  model.resize(80, 24)
  model.write('first')
  model.write('second')
  model.resize(500, 300)
  await expect.poll(() => vi.mocked(remote.write).mock.calls.length).toBe(1)
  expect(remote.resize).not.toHaveBeenCalled()
  input.resolve(success(undefined))
  await expect.poll(() => vi.mocked(remote.resize).mock.calls.length).toBe(1)
  const attachmentId = vi.mocked(remote.follow).mock.calls[0]![2]
  const id = model.state.getSnapshot().info!.id
  expect(vi.mocked(remote.write).mock.calls.map(call => call[3])).toEqual(['first', 'second'])
  expect(remote.resize).toHaveBeenCalledWith(sessionId, id, attachmentId, 200, 100)
  model.resize(90, 24)
  await expect.poll(() => vi.mocked(remote.resize).mock.calls.length).toBe(2)
})

it('bounds queued input by UTF-8 bytes and releases the byte budget after settlement', async () => {
  const { model, remote } = fixture()
  vi.mocked(remote.environment).mockResolvedValue(success({ ...environment, maxInputBytes: 6 }))
  await connected(model)
  const input = Promise.withResolvers<RemoteResult<void>>()
  vi.mocked(remote.write).mockReturnValueOnce(input.promise)
  model.write('界界')
  await expect.poll(() => vi.mocked(remote.write).mock.calls.length).toBe(1)
  model.write('a')
  expect(model.state.getSnapshot()).toMatchObject({ phase: 'failed', issue: 'inputFull' })
  input.resolve(success(undefined))
  model.connect()
  await expect.poll(() => model.state.getSnapshot().writable).toBe(true)
  model.write('界界')
  await expect.poll(() => vi.mocked(remote.write).mock.calls.length).toBe(2)
  expect(vi.mocked(remote.write).mock.calls.map(call => call[3])).toEqual(['界界', '界界'])
})

it('drops queued commands from a detached attachment and ignores its late resize failure', async () => {
  const { model, remote } = fixture()
  await connected(model)
  const input = Promise.withResolvers<RemoteResult<void>>()
  vi.mocked(remote.resize).mockReturnValueOnce(input.promise)
  model.resize(100, 30)
  await expect.poll(() => vi.mocked(remote.resize).mock.calls.length).toBe(1)
  model.write('stale')
  model.resize(110, 35)
  model.connect()
  await expect.poll(() => model.state.getSnapshot().writable).toBe(true)
  model.write('current')
  input.resolve(failure('old attachment'))
  await expect.poll(() => vi.mocked(remote.write).mock.calls.length).toBe(1)
  expect(vi.mocked(remote.write).mock.calls[0]?.[3]).toBe('current')
  expect(remote.resize).toHaveBeenCalledOnce()
  expect(model.state.getSnapshot().phase).toBe('connected')
})

it('publishes current input and resize failures and can reconnect for another attempt', async () => {
  const { model, remote } = fixture()
  await connected(model)
  vi.mocked(remote.write).mockResolvedValueOnce(failure('input refused'))
  model.write('x')
  await expect.poll(() => model.state.getSnapshot().error).toBe('input refused')
  model.connect()
  await expect.poll(() => model.state.getSnapshot().writable).toBe(true)
  vi.mocked(remote.resize).mockResolvedValueOnce(failure('resize refused'))
  model.resize(100, 30)
  await expect.poll(() => model.state.getSnapshot().error).toBe('resize refused')
})

it('treats carrier loss as disconnected only for the active attachment', async () => {
  const { model, options } = fixture()
  await connected(model)
  const first = options[0]!
  first.carrierFailed?.(new RemoteStreamCarrierError('offline'))
  expect(model.state.getSnapshot()).toMatchObject({ phase: 'disconnected', writable: false })
  model.connect()
  await expect.poll(() => model.state.getSnapshot().writable).toBe(true)
  first.carrierFailed?.(new RemoteStreamCarrierError('late old failure'))
  expect(model.state.getSnapshot().phase).toBe('connected')
})

it.each([
  ['output before snapshot', [{ type: 'output', sequence: 1, data: 'orphan' }], 'missing its screen snapshot'],
  ['sequence gap', [{ type: 'snapshot', sequence: 4, screen: '', info }, { type: 'output', sequence: 6, data: 'gap' }], 'sequence has a gap'],
  ['repeated snapshot', [{ type: 'snapshot', sequence: 4, screen: '', info }, { type: 'snapshot', sequence: 4, screen: '', info }], 'Unexpected terminal screen snapshot'],
] satisfies readonly (readonly [string, readonly TerminalFrame[], string])[])('refuses a malformed output stream: %s', async (_name, frames, message) => {
  const { model, remote } = fixture()
  vi.mocked(remote.follow).mockImplementation(streamMethod<TerminalRemote['follow']>(async function* () { yield* frames }))
  await mount(model)
  if (frames[0]?.type === 'snapshot') {
    await expect.poll(() => model.state.getSnapshot().render).toBeDefined()
    acknowledge(model)
  }
  await expect.poll(() => model.state.getSnapshot().error).toContain(message)
  expect(model.state.getSnapshot().writable).toBe(false)
})

it('retains an exited screen and closes controls when its stream ends', async () => {
  const { model, remote } = fixture()
  vi.mocked(remote.follow).mockImplementation(streamMethod<TerminalRemote['follow']>(async function* (_sessionId, id, controllerId) {
    yield { type: 'snapshot', sequence: 0, screen: 'last screen', info: { ...info, id, controllerId } }
    yield { type: 'state', info: { ...info, id, controllerId, state: 'exited', exitCode: 3 } }
  }))
  await connected(model)
  await expect.poll(() => model.state.getSnapshot().phase).toBe('closed')
  expect(model.state.getSnapshot()).toMatchObject({ writable: false, info: { state: 'exited', exitCode: 3 }, render: { frame: { screen: 'last screen' } } })
})

it('reports an attachment ending while the shell is still running and permits manual reconnect', async () => {
  const { model, remote } = fixture()
  vi.mocked(remote.follow).mockImplementationOnce(streamMethod<TerminalRemote['follow']>(async function* (_sessionId, id, controllerId) {
    yield { type: 'snapshot', sequence: 0, screen: '', info: { ...info, id, controllerId } }
  }))
  await connected(model)
  await expect.poll(() => model.state.getSnapshot().issue).toBe('attachmentEnded')
  model.connect()
  await expect.poll(() => model.state.getSnapshot().writable).toBe(true)
})

it('publishes remote control transfer without replacing the retained screen', async () => {
  const { model, remote } = fixture()
  vi.mocked(remote.follow).mockImplementation(streamMethod<TerminalRemote['follow']>(async function* (_sessionId, id, controllerId, signal) {
    yield { type: 'snapshot', sequence: 0, screen: 'retained', info: { ...info, id, controllerId } }
    yield { type: 'state', info: { ...info, id } }
    await untilAborted(signal)
  }))
  await connected(model)
  await expect.poll(() => model.state.getSnapshot().writable).toBe(false)
  expect(model.state.getSnapshot().render?.frame).toMatchObject({ type: 'snapshot', screen: 'retained' })
})

/** Pause delivery after the real Gateway iterator settles, before the model observes it. */
function deliveryBarrier() {
  const ready = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  let held = false
  function prepare<Item>(stream: RemoteStream<Item>): void {
    if (held) return
    held = true
    const iterator = stream[Symbol.asyncIterator]()
    let first = true
    vi.spyOn(stream, Symbol.asyncIterator).mockReturnValue({
      async next() {
        if (!first) return iterator.next()
        first = false
        try {
          return await iterator.next()
        } finally {
          ready.resolve(undefined)
          await release.promise
        }
      },
      async return() { return iterator.return!() },
    })
  }
  cleanups.push(() => { release.resolve(undefined) })
  return { ready: ready.promise, release: () => { release.resolve(undefined) }, prepare }
}

it('ignores an already delivered screen when its attachment is replaced before the model receives it', async () => {
  const barrier = deliveryBarrier()
  const { model, remote } = fixture(barrier.prepare)
  await mount(model)
  await barrier.ready
  model.connect()
  await expect.poll(() => model.state.getSnapshot().writable).toBe(true)
  const current = model.state.getSnapshot()
  barrier.release()
  await model.rename('settled')
  expect(model.state.getSnapshot().render).toBe(current.render)
  expect(remote.follow).toHaveBeenCalledTimes(2)
})

it('ignores an already settled stream error after a newer attachment has become writable', async () => {
  const barrier = deliveryBarrier()
  const { model, remote } = fixture(barrier.prepare)
  vi.mocked(remote.follow).mockImplementationOnce(streamMethod<TerminalRemote['follow']>(async function* () {
    yield* []
    throw new Error('retired attachment failed')
  }))
  await mount(model)
  await barrier.ready
  model.connect()
  await expect.poll(() => model.state.getSnapshot().writable).toBe(true)
  barrier.release()
  await model.rename('settled')
  expect(model.state.getSnapshot()).toMatchObject({ phase: 'connected', writable: true, error: undefined })
})

it('releases a pending screen render on carrier generation cancellation and accepts the replacement screen', async () => {
  const { model, remote, streams } = fixture()
  await mount(model)
  await expect.poll(() => model.state.getSnapshot().render).toBeDefined()
  const revision = model.state.getSnapshot().render!.revision
  streams[0]!.restart()
  await expect.poll(() => model.state.getSnapshot().render?.revision).toBe(revision + 1)
  expect(remote.follow).toHaveBeenCalledTimes(2)
  expect(model.state.getSnapshot().writable).toBe(true)
})

it('does not wait for the DOM callback of a screen whose generation was already cancelled at delivery', async () => {
  const barrier = deliveryBarrier()
  const { model, remote, streams } = fixture(barrier.prepare)
  await mount(model)
  await barrier.ready
  streams[0]!.restart()
  barrier.release()
  await expect.poll(() => model.state.getSnapshot().render?.revision).toBe(2)
  expect(remote.follow).toHaveBeenCalledTimes(2)
  expect(model.state.getSnapshot().writable).toBe(true)
})

it.each(['write', 'resize'] as const)('keeps a fresh attachment writable when a pending %s fails after automatic transport recovery', async (operation) => {
  const { model, remote, generation } = fixture()
  generation.set({ id: 1, host: { home: '/home/fixture' } })
  const disconnected = Promise.withResolvers<undefined>()
  vi.mocked(remote.follow).mockImplementationOnce(streamMethod<TerminalRemote['follow']>(async function* (_sessionId, id, controllerId, signal) {
    yield { type: 'snapshot', sequence: 0, screen: 'before disconnect', info: { ...info, id, controllerId } }
    await Promise.race([disconnected.promise, untilAborted(signal)])
    if (signal?.aborted) return
    throw new RemoteStreamCarrierError('connection lost')
  }))
  await connected(model)
  const pending = Promise.withResolvers<RemoteResult<void>>()
  if (operation === 'write') {
    vi.mocked(remote.write).mockReturnValueOnce(pending.promise)
    model.write('old input')
  } else {
    vi.mocked(remote.resize).mockReturnValueOnce(pending.promise)
    model.resize(100, 30)
  }
  await expect.poll(() => vi.mocked(remote[operation]).mock.calls.length).toBe(1)
  const oldAttachmentId = vi.mocked(remote.follow).mock.calls[0]![2]
  generation.set(undefined)
  disconnected.resolve(undefined)
  await expect.poll(() => model.state.getSnapshot().phase).toBe('disconnected')
  expect(model.state.getSnapshot().writable).toBe(false)
  expect(remote.follow).toHaveBeenCalledOnce()

  generation.set({ id: 2, host: { home: '/home/fixture' } })
  await expect.poll(() => model.state.getSnapshot().writable).toBe(true)
  expect(remote.follow).toHaveBeenCalledTimes(2)
  const attachmentId = vi.mocked(remote.follow).mock.calls[1]![2]
  expect(attachmentId).not.toBe(oldAttachmentId)
  expect(model.state.getSnapshot().info?.controllerId).toBe(attachmentId)
  expect(model.state.getSnapshot().render?.frame).toMatchObject({ type: 'snapshot', screen: 'ready' })

  model.write('fresh input')
  pending.reject(new Error('old attachment was replaced'))
  await expect.poll(() => vi.mocked(remote.write).mock.calls.some(call => call[3] === 'fresh input')).toBe(true)
  expect(model.state.getSnapshot()).toMatchObject({ phase: 'connected', writable: true, error: undefined })
  expect(vi.mocked(remote.write).mock.calls.at(-1)?.[2]).toBe(attachmentId)
  expect(remote.create).toHaveBeenCalledOnce()
  expect(remote.close).not.toHaveBeenCalled()
})

it('ignores controls before discovery and reconnects an existing process after remount', async () => {
  const { model, remote } = fixture()
  model.connect()
  model.write('early')
  model.resize(100, 30)
  model.acknowledge(100)
  expect(remote.follow).not.toHaveBeenCalled()
  expect(remote.write).not.toHaveBeenCalled()
  expect(remote.resize).not.toHaveBeenCalled()
  const unmount = await mount(model)
  await expect.poll(() => model.state.getSnapshot().writable).toBe(true)
  unmount()
  model.connect()
  model.write('detached')
  model.resize(100, 30)
  expect(remote.follow).toHaveBeenCalledOnce()
  expect(remote.write).not.toHaveBeenCalled()
  expect(remote.resize).not.toHaveBeenCalled()
  model.mount()
  await expect.poll(() => remote.follow).toHaveBeenCalledTimes(2)
  await expect.poll(() => model.state.getSnapshot().writable).toBe(true)
  expect(remote.create).toHaveBeenCalledOnce()
})

it('keeps controls inert when process metadata or the attachment is unavailable', async () => {
  const { model, remote } = fixture()
  await connected(model)
  const state = model.state.getSnapshot()
  model.state.set({ ...state, info: undefined })
  model.write('missing metadata')
  model.resize(100, 30)
  expect(remote.write).not.toHaveBeenCalled()
  expect(remote.resize).not.toHaveBeenCalled()
  model.state.set({ ...state, environment: undefined })
  model.resize(100, 30)
  await expect.poll(() => remote.resize).toHaveBeenCalledOnce()
  expect(vi.mocked(remote.resize).mock.calls[0]?.slice(-2)).toEqual([100, 30])
  model.write('unknown budget')
  expect(model.state.getSnapshot().issue).toBe('inputFull')
  expect(remote.write).not.toHaveBeenCalled()
})

it('renames an existing terminal, skips unchanged names, and exposes rename failures', async () => {
  const { model, remote } = fixture()
  await connected(model)
  await model.rename(`  ${info.title}  `)
  expect(remote.rename).not.toHaveBeenCalled()
  await model.rename('  Build  ')
  expect(model.state.getSnapshot()).toMatchObject({ title: 'Build', info: { title: 'Build' } })
  vi.mocked(remote.rename).mockRejectedValueOnce('rename connection lost')
  await model.rename('Other')
  expect(model.state.getSnapshot()).toMatchObject({ phase: 'failed', error: 'rename connection lost', title: 'Build' })
  await model.dispose()
  await model.rename('Ignored')
  expect(remote.rename).toHaveBeenCalledTimes(2)
})

it('classifies a discovery carrier failure as disconnected and supports explicit retry', async () => {
  const { model, remote } = fixture()
  vi.mocked(remote.environment).mockRejectedValueOnce(new RemoteStreamCarrierError('offline'))
  await model.refresh()
  expect(model.state.getSnapshot()).toMatchObject({ phase: 'disconnected', error: 'offline' })
  expect(remote.create).not.toHaveBeenCalled()
  await model.refresh()
  expect(model.state.getSnapshot().info?.id).toBe(info.id)
  expect(remote.create).toHaveBeenCalledOnce()
})

it('retains state when disposal overtakes successful allocation or a failed discovery', async () => {
  for (const operation of ['creation', 'discovery'] as const) {
    const { model, remote } = fixture()
    const creation = Promise.withResolvers<RemoteResult<WebTerminalInfo>>()
    const discovery = Promise.withResolvers<RemoteResult<TerminalEnvironment>>()
    if (operation === 'creation') vi.mocked(remote.create).mockReturnValueOnce(creation.promise)
    else vi.mocked(remote.environment).mockReturnValueOnce(discovery.promise)
    const loading = model.refresh()
    if (operation === 'creation') await expect.poll(() => remote.create).toHaveBeenCalledOnce()
    await model.dispose()
    const before = model.state.getSnapshot()
    if (operation === 'creation') creation.resolve(success(info))
    else discovery.reject(new Error('late discovery failure'))
    await loading
    expect(model.state.getSnapshot()).toBe(before)
    expect(remote.follow).not.toHaveBeenCalled()
  }
})

it('ignores a successful rename after the view is disposed', async () => {
  const { model, remote } = fixture()
  await connected(model)
  const rename = Promise.withResolvers<RemoteResult<void>>()
  vi.mocked(remote.rename).mockReturnValueOnce(rename.promise)
  const pending = model.rename('Late')
  await model.dispose()
  const before = model.state.getSnapshot()
  rename.resolve(success(undefined))
  await pending
  expect(model.state.getSnapshot()).toBe(before)
})

it('allows retry after failed process cleanup and never reconnects while close is pending', async () => {
  const { model, remote } = fixture()
  await connected(model)
  const closing = Promise.withResolvers<RemoteResult<void>>()
  vi.mocked(remote.close).mockReturnValueOnce(closing.promise)
  const first = model.close()
  expect(model.close()).toBe(first)
  model.connect()
  expect(remote.follow).toHaveBeenCalledOnce()
  closing.resolve(failure('close refused'))
  await expect(first).rejects.toThrow('close refused')
  expect(model.state.getSnapshot()).toMatchObject({ phase: 'failed', error: 'close refused' })
  await model.close()
  expect(model.state.getSnapshot()).toMatchObject({ phase: 'closed', writable: false })
  expect(remote.close).toHaveBeenCalledTimes(2)
})

it('does not publish a close result or reconnect after disposal', async () => {
  const { model, remote } = fixture()
  await connected(model)
  const closing = Promise.withResolvers<RemoteResult<void>>()
  vi.mocked(remote.close).mockReturnValueOnce(closing.promise)
  const pending = model.close()
  await model.dispose()
  const before = model.state.getSnapshot()
  closing.resolve(success(undefined))
  await pending
  model.mount()
  model.connect()
  expect(model.state.getSnapshot()).toBe(before)
  expect(remote.follow).toHaveBeenCalledOnce()
})

it.each(['write', 'resize'] as const)('keeps the output connection when %s loses control before its state frame arrives', async (operation) => {
  const { model, remote } = fixture()
  const transfer = Promise.withResolvers<undefined>()
  const response = Promise.withResolvers<RemoteResult<void>>()
  cleanups.push(() => { transfer.resolve(undefined); response.resolve(success(undefined)) })
  vi.mocked(remote.follow).mockImplementation(streamMethod<TerminalRemote['follow']>(async function* (_session, id, controllerId, signal) {
    yield { type: 'snapshot', sequence: 0, screen: 'retained screen', info: { ...info, id, controllerId } }
    await transfer.promise
    yield { type: 'state', info: { ...info, id } }
    await untilAborted(signal)
  }))
  await connected(model)
  vi.mocked(remote[operation]).mockReturnValueOnce(response.promise)
  if (operation === 'write') model.write('before transfer')
  else model.resize(100, 30)
  model.write('queued before transfer')
  await expect.poll(() => vi.mocked(remote[operation]).mock.calls.length).toBe(1)
  response.resolve({ ok: false, error: new RemoteError('terminal/control-unavailable', 'Another window owns input', { reason: 'read-only' }) })
  await expect.poll(() => model.state.getSnapshot().writable).toBe(false)
  expect(model.state.getSnapshot()).toMatchObject({ phase: 'connected', error: undefined, issue: undefined, render: { frame: { screen: 'retained screen' } } })
  transfer.resolve(undefined)
  await expect.poll(() => model.state.getSnapshot().info?.controllerId).toBeUndefined()
  expect(remote.follow).toHaveBeenCalledOnce()
  expect(vi.mocked(remote.write).mock.calls.some(call => call[3] === 'queued before transfer')).toBe(false)
})

it('keeps an exited screen when a pending input is refused after the exit state arrives', async () => {
  const { model, remote } = fixture()
  const exit = Promise.withResolvers<undefined>()
  const response = Promise.withResolvers<RemoteResult<void>>()
  cleanups.push(() => { exit.resolve(undefined); response.resolve(success(undefined)) })
  vi.mocked(remote.follow).mockImplementation(streamMethod<TerminalRemote['follow']>(async function* (_session, id, controllerId, signal) {
    yield { type: 'snapshot', sequence: 0, screen: 'final screen', info: { ...info, id, controllerId } }
    await exit.promise
    yield { type: 'state', info: { ...info, id, state: 'exited', exitCode: 0 } }
    await untilAborted(signal)
  }))
  await connected(model)
  vi.mocked(remote.write).mockReturnValueOnce(response.promise)
  model.write('exit race')
  await expect.poll(() => vi.mocked(remote.write).mock.calls.length).toBe(1)
  exit.resolve(undefined)
  await expect.poll(() => model.state.getSnapshot().info?.state).toBe('exited')
  response.resolve({ ok: false, error: new RemoteError('terminal/control-unavailable', 'Terminal is not running', { reason: 'not-running' }) })
  await setImmediate()
  expect(model.state.getSnapshot()).toMatchObject({ phase: 'connected', writable: false, error: undefined, issue: undefined, render: { frame: { screen: 'final screen' } } })
})

it('exposes a localized quota error and clears it after a successful retry', async () => {
  const { model, remote } = fixture()
  vi.mocked(remote.create).mockResolvedValueOnce({ ok: false, error: new RemoteError('terminal/limit-reached', 'Session terminal limit reached', { limit: 8 }) })
  await model.refresh()
  expect(model.state.getSnapshot()).toMatchObject({ phase: 'failed', issue: 'terminalLimit' })
  await connected(model)
  expect(model.state.getSnapshot()).toMatchObject({ phase: 'connected', issue: undefined, error: undefined })
})
