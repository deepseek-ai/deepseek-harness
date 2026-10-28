import { expect, it, vi } from 'vitest'
import { DesktopChannelSource } from '../src/client/desktop-channel-source.ts'
import type { DesktopChannelState } from '../src/types.ts'

const nightly: DesktopChannelState = { channel: 'nightly', packagedChannel: 'nightly', changing: false }
const latest: DesktopChannelState = { ...nightly, channel: 'latest' }

function fixture() {
  const get = Promise.withResolvers<DesktopChannelState>()
  const set = Promise.withResolvers<DesktopChannelState>()
  let listener: (state: DesktopChannelState) => void = () => {}
  const unsubscribe = vi.fn()
  const select = vi.fn(() => set.promise)
  const source = new DesktopChannelSource({ get: () => get.promise, set: select,
    subscribe(next) { listener = next; return unsubscribe } })
  return { source, get, set, select, unsubscribe, emit: (state: DesktopChannelState) => { listener(state) } }
}

it('keeps pushed multi-window state ahead of stale initial and selection replies', async () => {
  const f = fixture()
  f.emit(nightly)
  f.get.resolve(latest)
  await f.get.promise
  expect(f.source.store.getSnapshot().state).toEqual(nightly)
  const pending = f.source.select('latest')
  f.emit(latest)
  f.emit(nightly)
  f.set.resolve(latest)
  await pending
  expect(f.source.store.getSnapshot().state).toEqual(nightly)
  f.source.dispose()
  expect(f.unsubscribe).toHaveBeenCalledOnce()
})

it('keeps save failures visible and permits an explicit retry', async () => {
  const f = fixture()
  f.get.resolve(nightly)
  await f.get.promise
  const pending = f.source.select('latest')
  f.set.reject(new Error('IPC closed'))
  await pending
  expect(f.source.store.getSnapshot()).toEqual({ state: nightly, failed: true })
  f.emit(latest)
  expect(f.source.store.getSnapshot()).toEqual({ state: latest, failed: false })
  f.source.dispose()
})

it('ignores events and replies after disposal', async () => {
  const f = fixture()
  const pending = f.source.select('latest')
  f.source.dispose()
  f.emit(latest)
  f.get.resolve(nightly)
  f.set.resolve(latest)
  await pending
  await f.source.select('nightly')
  expect(f.select).toHaveBeenCalledOnce()
  expect(f.source.store.getSnapshot()).toEqual({ failed: false })
})


it('reports initial IPC failure and accepts a later explicit choice response', async () => {
  const f = fixture()
  f.get.reject(new Error('unavailable'))
  await Promise.resolve()
  expect(f.source.store.getSnapshot()).toEqual({ failed: true })
  const pending = f.source.select('latest')
  f.set.resolve(latest)
  await pending
  expect(f.source.store.getSnapshot()).toEqual({ state: latest, failed: false })
  f.source.dispose()
})

it('ignores rejected reads after an event or disposal, and rejected writes after a newer event', async () => {
  const f = fixture()
  f.emit(nightly)
  f.get.reject(new Error('stale read'))
  const pending = f.source.select('latest')
  f.emit(latest)
  f.set.reject(new Error('stale write'))
  await pending
  expect(f.source.store.getSnapshot()).toEqual({ state: latest, failed: false })
  f.source.dispose()
  const closed = fixture()
  const writing = closed.source.select('latest')
  closed.source.dispose()
  closed.get.reject(new Error('late read'))
  closed.set.reject(new Error('late write'))
  await writing
  expect(closed.source.store.getSnapshot()).toEqual({ failed: false })
})
