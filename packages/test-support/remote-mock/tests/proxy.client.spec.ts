/** Native namespace mocks shared by local callers and the Connection carrier. */
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { RemoteMock, frames, ok, openStream, type StreamHandle } from '../src/index.ts'

const describeValue = (hasDocument: boolean) => ok({ writable: true, hasDocument, namespaces: [] })
const baseline = { type: 'baseline' as const, value: { queues: {}, jobs: {}, projections: {} } }

async function drain(source: AsyncIterable<unknown>): Promise<unknown[]> {
  const values: unknown[] = []
  for await (const value of source) values.push(value)
  return values
}

describe('RemoteMock.remote unary proxies', () => {
  it('caches native namespace/method identities and leaves thenable/symbol probes inert', async () => {
    const mock = RemoteMock.create()
    const settings = mock.remote.settings
    const describe = settings.describe
    expect(mock.remote.settings).toBe(settings)
    expect(settings.describe).toBe(describe)
    expect(vi.isMockFunction(describe)).toBe(true)
    expect(RemoteMock.create().remote.settings.describe).not.toBe(describe)
    for (const value of [mock.remote, settings]) {
      expect(Reflect.get(value, 'then')).toBeUndefined()
      expect(Reflect.get(value, Symbol.iterator)).toBeUndefined()
      expect(Reflect.get(value, Symbol.toStringTag)).toBeUndefined()
      expect(await Promise.resolve(value)).toBe(value)
    }
    expect(describe).not.toHaveBeenCalled()
    expect(mock.endpoints()).toEqual(['$events', 'settings/describe'])
    expect(mock.log.calls()).toEqual([])
    expect(mock.log.streams()).toEqual([])
    expect(mock.log.unmatched()).toEqual([])
  })

  it('consumes native one-shot answers in FIFO order across direct and carrier calls, then uses the default handler', async () => {
    const fallback = describeValue(false)
    const local = describeValue(true)
    const dispatched = { ...describeValue(false), value: { writable: false, hasDocument: false, namespaces: [] } }
    const carrier = describeValue(true)
    const handler = vi.fn(() => fallback)
    const mock = RemoteMock.create().unary('settings/describe', handler)
    const describe = mock.remote.settings.describe
    describe.mockReturnValueOnce(Promise.resolve(local)).mockResolvedValueOnce(dispatched).mockResolvedValueOnce(carrier)

    await expect(describe()).resolves.toBe(local)
    await expect(mock.dispatch('settings/describe', [])).resolves.toBe(dispatched)
    await expect(mock.rpc.call('/api', 'settings/describe', { args: [] })).resolves.toBe(carrier)
    await expect(describe()).resolves.toBe(fallback)

    expect(handler).toHaveBeenCalledOnce()
    expect(describe.mock.calls).toEqual([[], [], [], []])
    expect(mock.log.calls('settings/describe').map(call => [call.args, call.state, call.result]))
      .toEqual([[[], 'answered', dispatched], [[], 'answered', carrier]])
    mock.assertNoUnmatched()
  })

  it('records every business argument while the carrier keeps its signal out of positional args', async () => {
    const mock = RemoteMock.create()
    const mutate = mock.remote.settings.mutate
    const result = ok({ ns: 'locale', schema: {}, value: { preference: 'en' }, applies: 'live' as const, secrets: [], revision: 8 })
    const ops = [{ op: 'set' as const, path: ['preference'], value: 'en' }]
    mutate.mockResolvedValue(result)

    await expect(mutate('locale', ops, 7)).resolves.toBe(result)
    await expect(mock.rpc.call('/api', 'settings/mutate', { args: ['locale', ops, 7] }, new AbortController().signal))
      .resolves.toBe(result)
    expect(mutate.mock.calls).toEqual([['locale', ops, 7], ['locale', ops, 7]])
    expect(mutate.mock.calls[1]?.[1]).toBe(ops)
    expect(mock.log.calls('settings/mutate').map(call => call.args)).toEqual([['locale', ops, 7]])
  })

  it('keeps native one-shot answers local to each mock when they load the same default table', async () => {
    const fallback = describeValue(false)
    const table = { unary: { 'settings/describe': fallback } }
    const a = RemoteMock.create().load(table)
    const b = RemoteMock.create().load(table)
    const first = describeValue(true)
    const second = { ...describeValue(true), value: { writable: false, hasDocument: true, namespaces: [] } }
    a.remote.settings.describe.mockResolvedValueOnce(first)
    b.remote.settings.describe.mockResolvedValueOnce(second)

    await expect(a.dispatch('settings/describe', [])).resolves.toBe(first)
    await expect(a.dispatch('settings/describe', [])).resolves.toBe(fallback)
    expect(b.remote.settings.describe).not.toHaveBeenCalled()
    await expect(b.rpc.call('/api', 'settings/describe', { args: [] })).resolves.toBe(second)
    await expect(b.remote.settings.describe()).resolves.toBe(fallback)
  })

  it('keeps queued overrides on mockClear and restores the live default rule on mockReset', async () => {
    const original = describeValue(false)
    const updated = describeValue(true)
    const override = { ...describeValue(false), value: { writable: false, hasDocument: false, namespaces: [] } }
    const mock = RemoteMock.create().unary('settings/describe', original)
    const describe = mock.remote.settings.describe
    await describe()
    describe.mockResolvedValueOnce(override)
    describe.mockClear()
    await expect(mock.rpc.call('/api', 'settings/describe', { args: [] })).resolves.toBe(override)
    expect(describe.mock.calls).toEqual([[]])

    describe.mockResolvedValue(override)
    mock.load({ unary: { 'settings/describe': updated } })
    await expect(mock.dispatch('settings/describe', [])).resolves.toBe(override)
    describe.mockReset()
    await expect(mock.dispatch('settings/describe', [])).resolves.toBe(updated)
    expect(mock.remote.settings.describe).toBe(describe)
    expect(describe.mock.calls).toEqual([[]])
    expect(mock.log.calls('settings/describe').map(call => call.result)).toEqual([override, override, updated])
  })

  it('reports missing defaults after native one-shot answers are exhausted', async () => {
    const mock = RemoteMock.create()
    const describe = mock.remote.settings.describe
    expect(mock.modeOf('settings/describe')).toBeUndefined()
    const answer = describeValue(false)
    describe.mockResolvedValueOnce(answer)
    await expect(mock.rpc.call('/api', 'settings/describe', { args: [] })).resolves.toBe(answer)
    expect(() => describe()).toThrow('no rule for settings/describe')
    await expect(mock.dispatch('settings/describe', [])).rejects.toThrow('no rule for settings/describe')
    await expect(mock.rpc.call('/api', 'settings/describe', { args: [] })).rejects.toThrow('no rule for settings/describe')
    expect(describe).toHaveBeenCalledTimes(4)
    expect(mock.log.calls('settings/describe').map(call => [call.state, call.result])).toEqual([['answered', answer]])
    expect(mock.log.unmatched()).toEqual(Array.from({ length: 3 }, () => ({ endpoint: 'settings/describe', mode: 'unary' })))
    expect(() => { mock.assertNoUnmatched() }).toThrow('3 unmatched request(s)')
  })

  it('records native rejected answers as failed carrier calls without unmatched entries', async () => {
    const mock = RemoteMock.create()
    const failure = new Error('mock service unavailable')
    const describe = mock.remote.settings.describe.mockRejectedValueOnce(failure)
    await expect(mock.rpc.call('/api', 'settings/describe', { args: [] })).rejects.toBe(failure)
    expect(describe.mock.calls).toEqual([[]])
    expect(mock.log.calls('settings/describe').map(call => [call.state, call.result])).toEqual([['failed', failure]])
    mock.assertNoUnmatched()
  })

  it('preserves synchronous native override failures in the async carrier log', async () => {
    const mock = RemoteMock.create()
    const failure = new Error('handler threw')
    const describe = mock.remote.settings.describe.mockImplementation(() => { throw failure })
    await expect(mock.dispatch('settings/describe', [])).rejects.toBe(failure)
    expect(describe).toHaveBeenCalledOnce()
    expect(mock.log.calls('settings/describe').map(call => [call.state, call.result])).toEqual([['failed', failure]])
    mock.assertNoUnmatched()
  })
})

describe('RemoteMock.remote stream proxies', () => {
  it('selects the cached spy for the current mode and preserves its identity across script replacement', async () => {
    const mock = RemoteMock.create()
    const session = mock.remote.session
    const unary = session.control
    expect(() => unary()).toThrow('no rule for session/control')
    expect(mock.log.unmatched()).toEqual([{ endpoint: 'session/control', mode: 'unary' }])

    mock.stream('session/control', frames([baseline])).stream('session/control')
    const stream = session.control
    expect(mock.remote.session).toBe(session)
    expect(stream).not.toBe(unary)
    expect(vi.isMockFunction(stream)).toBe(true)
    expect(session.control).toBe(stream)
    const opened = stream()
    mock.stream('session/control', frames([]))
    expect(session.control).toBe(stream)
    await expect(drain(opened)).resolves.toEqual([baseline])
    await expect(drain(stream())).resolves.toEqual([])
    expect(unary).toHaveBeenCalledOnce()
    expect(stream).toHaveBeenCalledTimes(2)
    expect(mock.log.streams('session/control').map(entry => entry.state)).toEqual(['ended', 'ended'])
  })

  it('shares stream spies with the carrier, preserves its args, and reflects each caller cancellation', async () => {
    const signals: AbortSignal[] = []
    const script = vi.fn((_args: readonly unknown[], stream: StreamHandle) => {
      signals.push(stream.signal)
      stream.push(baseline)
    })
    const mock = RemoteMock.create().stream('session/control', script)
    const localController = new AbortController()
    const wireController = new AbortController()
    onTestFinished(async () => {
      localController.abort()
      wireController.abort()
      await mock.streams.drained('session/control')
    })
    const control = mock.remote.session.control
    const request = { after: 7 }
    const local = control(localController.signal)[Symbol.asyncIterator]()
    const wire = mock.rpc.open!('/api', 'session/control', { args: [request] }, wireController.signal)[Symbol.asyncIterator]()
    await expect(local.next()).resolves.toEqual({ value: baseline, done: false })
    await expect(wire.next()).resolves.toEqual({ value: baseline, done: false })
    expect(control.mock.calls).toEqual([[localController.signal], [request, wireController.signal]])
    expect(script.mock.calls.map(([args]) => args)).toEqual([[], [request]])
    expect(signals).toHaveLength(2)
    expect(signals.map(signal => signal.aborted)).toEqual([false, false])
    expect(mock.log.streams('session/control').map(entry => entry.args)).toEqual([[], [request]])

    const waiting = local.next()
    localController.abort()
    await expect(waiting).resolves.toEqual({ value: undefined, done: true })
    await wire.return!()
    await mock.streams.drained('session/control')
    expect(signals.map(signal => signal.aborted)).toEqual([true, true])
    expect(mock.streams.push('session/control', baseline)).toBe(0)
    expect(mock.log.streams('session/control').map(entry => entry.state)).toEqual(['cancelled', 'cancelled'])
  })

  it('provides a cancellable default signal when a local stream call omits one', async () => {
    let openedSignal: AbortSignal | undefined
    const mock = RemoteMock.create().stream('session/control', (_args, stream) => { openedSignal = stream.signal })
    const control = mock.remote.session.control
    const reader = control()[Symbol.asyncIterator]()
    onTestFinished(async () => { await reader.return!() })
    expect(openedSignal).toBeInstanceOf(AbortSignal)
    expect(openedSignal?.aborted).toBe(false)
    const waiting = reader.next()
    await reader.return!()
    await expect(waiting).resolves.toEqual({ value: undefined, done: true })
    expect(control.mock.calls).toEqual([[]])
    expect(mock.log.streams('session/control')[0]?.state).toBe('cancelled')
  })

  it('excludes unread native stream overrides from controlled streams and restores the script on reset', async () => {
    const mock = RemoteMock.create().stream('session/control', frames([baseline]))
    const control = mock.remote.session.control
    const signal = new AbortController().signal
    let consumed = false
    async function* response() {
      consumed = true
      yield baseline
    }
    const native = response()
    onTestFinished(async () => { await native.return(undefined) })
    control.mockReturnValueOnce(native)
    const overridden = mock.open('session/control', [], signal)
    expect(overridden).toBe(native)
    await expect(mock.streams.drained('session/control')).resolves.toBeUndefined()
    expect(consumed).toBe(false)
    expect(control.mock.calls).toEqual([[signal]])
    expect(mock.log.streams('session/control')).toHaveLength(0)
    await expect(drain(overridden)).resolves.toEqual([baseline])
    expect(consumed).toBe(true)

    control.mockReset()
    await expect(drain(mock.rpc.open!('/api', 'session/control', { args: [] }, signal))).resolves.toEqual([baseline])
    await expect(mock.streams.opened('session/control', 1)).resolves.toBeUndefined()
    await expect(mock.streams.drained('session/control')).resolves.toBeUndefined()
    expect(mock.remote.session.control).toBe(control)
    expect(control.mock.calls).toEqual([[signal]])
    expect(mock.log.streams('session/control').map(entry => [entry.state, entry.pushed])).toEqual([['ended', 1]])
    mock.assertNoUnmatched()
  })

  it('requires an explicit stream script and keeps live failures observable by the consumer', async () => {
    const mock = RemoteMock.create().stream('session/control')
    expect(() => mock.remote.session.control()).toThrow('no rule for session/control')
    expect(mock.log.unmatched()).toEqual([{ endpoint: 'session/control', mode: 'stream' }])
    mock.stream('session/control', openStream())
    const controller = new AbortController()
    onTestFinished(() => { controller.abort() })
    const reader = mock.remote.session.control(controller.signal)[Symbol.asyncIterator]()
    const failure = new Error('stream disconnected')
    const pending = expect(reader.next()).rejects.toBe(failure)
    expect(mock.streams.fail('session/control', failure)).toBe(1)
    await pending
    await mock.streams.drained('session/control')
    expect(mock.log.streams('session/control')[0]?.state).toBe('failed')
    expect(mock.streams.push('session/control', baseline)).toBe(0)
  })
})
