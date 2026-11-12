import { describe, expect, it, vi } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import {
  RemoteStreamCarrierError,
  RemoteStream,
  type RemoteStreamCarrierFailure,
} from '../src/client/index.ts'

const GENERATION = { id: 1, host: { home: '/home/fixture' } }

function hostSource(initiallyAvailable: boolean): {
  connection: Pick<ConnectionHandle, 'generation'>
  publish(available: boolean): void
} {
  let current = initiallyAvailable ? GENERATION : undefined
  const listeners = new Set<() => void>()
  return {
    connection: {
      generation: {
        getSnapshot: () => current,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
      },
    },
    publish: (available) => {
      current = available ? GENERATION : undefined
      for (const listener of listeners) listener()
    },
  }
}

interface Generation<Item> {
  readonly values?: readonly (Item | Promise<Item>)[]
  readonly terminal?: Error
  readonly hold?: boolean
  readonly afterAbortError?: Error
  readonly close?: () => Promise<void>
}

function scripted<Item>(generations: Generation<Item>[], opened?: () => void) {
  return (signal: AbortSignal): AsyncIterable<Item> => ({
    async * [Symbol.asyncIterator](): AsyncIterator<Item> {
      const generation = generations.shift()
      if (generation === undefined) throw new Error('fixture has no stream generation')
      opened?.()
      try {
        for (const value of generation.values ?? []) yield await value
        if (generation.terminal !== undefined) throw generation.terminal
        if (generation.hold === true && !signal.aborted) {
          await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => { resolve() }, { once: true })
          })
        }
        if (generation.afterAbortError !== undefined) throw generation.afterAbortError
      } finally {
        await generation.close?.()
      }
    },
  })
}

function supervisor<Item>(
  connection: Pick<ConnectionHandle, 'generation'>,
  generations: Generation<Item>[],
  carrierFailed?: (error: RemoteStreamCarrierError) => void,
): RemoteStream<Item> {
  return new RemoteStream(connection, {
    name: 'fixture stream',
    open: scripted(generations),
    ended: accepted => accepted
      ? new RemoteStreamCarrierError('accepted generation ended')
      : new Error('generation ended before acceptance'),
    ...(carrierFailed === undefined ? {} : { carrierFailed }),
  })
}

describe('RemoteStream', () => {
  it('annotates replacement generations and resets retry state after acceptance', async () => {
    const source = hostSource(true)
    const stream = supervisor(source.connection, [
      { values: ['first'], terminal: new RemoteStreamCarrierError('first lost') },
      { values: ['second'], hold: true },
    ])
    const iterator = stream[Symbol.asyncIterator]()

    const first = await iterator.next()
    expect(first).toMatchObject({ done: false, value: { generation: 1, value: 'first' } })
    if (first.done) throw new Error('fixture generation ended early')
    first.value.accept()
    const second = await iterator.next()
    expect(second).toMatchObject({ done: false, value: { generation: 2, value: 'second' } })
    if (second.done) throw new Error('fixture replacement ended early')
    second.value.accept()

    await stream.dispose()
  })

  it('permits one isolated retry while the Host remains available', async () => {
    const source = hostSource(true)
    const first = new RemoteStreamCarrierError('first carrier failure')
    const repeated = new RemoteStreamCarrierError('isolated retry failed')
    const carrierFailed = vi.fn<(error: RemoteStreamCarrierError) => void>()
    const stream = supervisor(source.connection, [
      { terminal: first },
      { terminal: repeated },
    ], carrierFailed)

    await expect(stream[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      isDSHRemoteError: true,
      code: 'gateway/internal',
      message: 'isolated retry failed',
      details: {},
      cause: repeated,
    })
    expect(carrierFailed).toHaveBeenNthCalledWith(1, first)
    expect(carrierFailed).toHaveBeenNthCalledWith(2, repeated)
  })

  it('reconnects on a plain Error carrying the carrier code and stops on one without it', async () => {
    const carrierLoss = Object.assign(new Error('domain stream ended'), { code: 'gateway/carrier-lost' as const })
    const carrierFailed = vi.fn<(error: RemoteStreamCarrierFailure) => void>()
    const reconnecting = new RemoteStream(hostSource(true).connection, {
      name: 'fixture stream',
      open: scripted([{ values: ['first'] }, { values: ['second'], hold: true }]),
      ended: accepted => accepted ? carrierLoss : new Error('generation ended before acceptance'),
      carrierFailed,
    })
    const iterator = reconnecting[Symbol.asyncIterator]()
    const first = await iterator.next()
    if (first.done) throw new Error('fixture generation ended early')
    first.value.accept()
    await expect(iterator.next()).resolves.toMatchObject({ done: false, value: { generation: 2, value: 'second' } })
    expect(carrierFailed).toHaveBeenCalledExactlyOnceWith(carrierLoss)
    await reconnecting.dispose()

    const plain = new Error('domain stream ended')
    const terminal = new RemoteStream(hostSource(true).connection, {
      name: 'fixture stream',
      open: scripted([{ values: ['first'] }, { values: ['unreached'] }]),
      ended: () => plain,
    })
    const stopping = terminal[Symbol.asyncIterator]()
    const opened = await stopping.next()
    if (opened.done) throw new Error('fixture generation ended early')
    opened.value.accept()
    await expect(stopping.next()).rejects.toMatchObject({
      isDSHRemoteError: true, code: 'gateway/internal', message: 'domain stream ended', cause: plain,
    })
    expect(new RemoteStreamCarrierError('socket lost').code).toBe('gateway/carrier-lost')
  })

  it('terminates on a Host RemoteError even when it carries the carrier code', async () => {
    const hostFailure = new RemoteError('gateway/carrier-lost' as never, 'host reused the carrier code', {} as never)
    const carrierFailed = vi.fn<(error: RemoteStreamCarrierFailure) => void>()
    const stream = supervisor(hostSource(true).connection, [{ terminal: hostFailure }, { values: ['unreached'] }], carrierFailed)

    await expect(stream[Symbol.asyncIterator]().next()).rejects.toBe(hostFailure)
    expect(carrierFailed).not.toHaveBeenCalled()
  })

  it('folds a non-Error terminal escape into a marked gateway/internal failure', async () => {
    const stream = new RemoteStream(hostSource(true).connection, {
      name: 'fixture stream',
      open: () => ({
        [Symbol.asyncIterator]: (): AsyncIterator<string> => ({
          next: vi.fn<() => Promise<IteratorResult<string>>>().mockRejectedValue('generation exploded'),
        }),
      }),
      ended: () => new Error('fixture stream ended'),
    })

    await expect(stream[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      isDSHRemoteError: true,
      code: 'gateway/internal',
      message: 'generation exploded',
    })
  })

  it('passes a marked Remote failure through the terminal boundary verbatim', async () => {
    const failure = new RemoteError('gateway/internal', 'host stream failed', {})
    const stream = supervisor(hostSource(true).connection, [{ terminal: failure }])

    await expect(stream[Symbol.asyncIterator]().next()).rejects.toBe(failure)
  })

  it('waits for a replacement Host generation after observing unavailability', async () => {
    let available = false
    let listener: (() => void) | undefined
    const subscribed = Promise.withResolvers<undefined>()
    const connection = {
      generation: {
        getSnapshot: () => available ? GENERATION : undefined,
        subscribe: (value: () => void) => {
          listener = value
          subscribed.resolve(undefined)
          return () => { listener = undefined }
        },
      },
    }
    let opened = 0
    const stream = new RemoteStream(connection, {
      name: 'fixture stream',
      open: scripted([
        { terminal: new RemoteStreamCarrierError('offline') },
        { values: ['ready'], hold: true },
      ], () => { opened++ }),
      ended: () => new Error('ended'),
    })
    const pending = stream[Symbol.asyncIterator]().next()
    await vi.waitFor(() => { expect(opened).toBe(1) })
    await subscribed.promise

    listener?.()
    expect(opened).toBe(1)
    available = true
    listener?.()
    await expect(pending).resolves.toMatchObject({
      done: false,
      value: { generation: 2, value: 'ready' },
    })
    await stream.dispose()
  })

  it('stops a pending retry when the logical stream is disposed', async () => {
    const source = hostSource(false)
    let opened = 0
    const stream = new RemoteStream(source.connection, {
      name: 'fixture stream',
      open: scripted([
        { terminal: new RemoteStreamCarrierError('offline') },
      ], () => { opened++ }),
      ended: () => new Error('ended'),
    })
    const pending = stream[Symbol.asyncIterator]().next()
    await vi.waitFor(() => { expect(opened).toBe(1) })
    source.publish(false)

    await stream.dispose()
    await expect(pending).resolves.toEqual({ done: true, value: undefined })
  })

  it('contains a Host publication during subscription setup', async () => {
    let reads = 0
    let disposed = 0
    const connection = {
      generation: {
        getSnapshot: () => reads++ === 0 ? undefined : GENERATION,
        subscribe: (listener: () => void) => {
          listener()
          return () => { disposed++ }
        },
      },
    }
    const stream = supervisor(connection, [
      { terminal: new RemoteStreamCarrierError('offline') },
      { values: ['ready'], hold: true },
    ])

    await expect(stream[Symbol.asyncIterator]().next()).resolves.toMatchObject({
      value: { generation: 2, value: 'ready' },
    })
    expect(disposed).toBe(1)
    await stream.dispose()
  })

  it('restarts with a fresh physical generation', async () => {
    const source = hostSource(true)
    const stream = supervisor(source.connection, [
      { values: ['first'], hold: true },
      { values: ['second'], hold: true },
    ])
    const iterator = stream[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({ value: { generation: 1, value: 'first' } })

    stream.restart()

    await expect(iterator.next()).resolves.toMatchObject({ value: { generation: 2, value: 'second' } })
    await stream.dispose()
  })

  it('drops values and cancellation failures from a replaced generation', async () => {
    const source = hostSource(true)
    const stream = supervisor(source.connection, [
      { values: ['first', 'stale'] },
      {
        values: ['second'],
        hold: true,
        afterAbortError: new Error('replaced generation cancelled'),
      },
      { values: ['third'], hold: true },
    ])
    const iterator = stream[Symbol.asyncIterator]()
    const first = await iterator.next()
    if (first.done) throw new Error('fixture generation ended early')

    stream.restart()
    first.value.accept()
    await expect(iterator.next()).resolves.toMatchObject({
      value: { generation: 2, value: 'second' },
    })

    stream.restart()
    await expect(iterator.next()).resolves.toMatchObject({
      value: { generation: 3, value: 'third' },
    })
    await stream.dispose()
  })

  it('honors replacement requested by carrier diagnostics', async () => {
    const source = hostSource(true)
    const holder: { stream?: RemoteStream<string> } = {}
    const carrierFailed = vi.fn(() => { holder.stream?.restart() })
    const stream = supervisor(source.connection, [
      { terminal: new RemoteStreamCarrierError('replace this generation') },
      { values: ['ready'], hold: true },
    ], carrierFailed)
    holder.stream = stream

    await expect(stream[Symbol.asyncIterator]().next()).resolves.toMatchObject({
      value: { generation: 2, value: 'ready' },
    })
    expect(carrierFailed).toHaveBeenCalledOnce()
    await stream.dispose()
  })

  it('contains replacement during Host-readiness subscription setup', async () => {
    const holder: { stream?: RemoteStream<string> } = {}
    let subscriptions = 0
    const connection = {
      generation: {
        getSnapshot: () => undefined,
        subscribe: () => {
          subscriptions++
          holder.stream?.restart()
          return () => {}
        },
      },
    }
    const stream = supervisor(connection, [
      { terminal: new RemoteStreamCarrierError('offline') },
      { values: ['ready'], hold: true },
    ])
    holder.stream = stream

    await expect(stream[Symbol.asyncIterator]().next()).resolves.toMatchObject({
      value: { generation: 2, value: 'ready' },
    })
    expect(subscriptions).toBe(1)
    await stream.dispose()
  })

  it('waits for generation cleanup during disposal', async () => {
    const source = hostSource(true)
    const release = Promise.withResolvers<undefined>()
    let closed = false
    const stream = supervisor(source.connection, [{
      values: ['ready'],
      hold: true,
      close: async () => {
        await release.promise
        closed = true
      },
    }])
    const iterator = stream[Symbol.asyncIterator]()
    await iterator.next()
    const pending = iterator.next()

    const disposing = stream.dispose()
    expect(stream.dispose()).toBe(disposing)
    await Promise.resolve()
    expect(closed).toBe(false)
    release.resolve(undefined)

    await expect(disposing).resolves.toBeUndefined()
    await expect(pending).resolves.toEqual({ done: true, value: undefined })
    expect(closed).toBe(true)
  })

  it('uses the domain normal-end classification and permits one consumer', async () => {
    const source = hostSource(true)
    const stream = supervisor<string>(source.connection, [{}])
    const iterator = stream[Symbol.asyncIterator]()

    expect(() => stream[Symbol.asyncIterator]()).toThrow('already has a consumer')
    await expect(iterator.next()).rejects.toThrow('generation ended before acceptance')
    await stream.dispose()
  })

  it('can be disposed before consumption and ignores later restart', async () => {
    const source = hostSource(true)
    const stream = supervisor<string>(source.connection, [])

    await stream.dispose()
    expect(stream.signal.aborted).toBe(true)
    stream.restart()
    await expect(stream[Symbol.asyncIterator]().next()).resolves.toEqual({
      done: true,
      value: undefined,
    })
  })

  it('drops a value that arrives after disposal begins', async () => {
    const source = hostSource(true)
    const late = Promise.withResolvers<string>()
    const stream = supervisor(source.connection, [{ values: [late.promise] }])
    const pending = stream[Symbol.asyncIterator]().next()
    const disposing = stream.dispose()
    late.resolve('late')

    await expect(pending).resolves.toEqual({ done: true, value: undefined })
    await disposing
  })
})
