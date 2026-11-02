import { expect, it, vi } from 'vitest'
import { DesktopChannelSource } from '../src/client/desktop-channel-source.ts'
import type { DesktopChannelState, DesktopChannelChangeResult } from '../src/types.ts'

const nightly: DesktopChannelState = { channel: 'nightly', packagedChannel: 'nightly', changing: false }
const latest: DesktopChannelState = { ...nightly, channel: 'latest' }

function fixture() {
  const get = Promise.withResolvers<DesktopChannelState>()
  const set = Promise.withResolvers<DesktopChannelChangeResult>()
  let listener: (state: DesktopChannelState) => void = () => {}
  const unsubscribe = vi.fn()
  const select = vi.fn(() => set.promise)
  const source = new DesktopChannelSource({ get: () => get.promise, set: select,
    subscribe(next) { listener = next; return unsubscribe } })
  return { source, get, set, select, unsubscribe, emit: (state: DesktopChannelState) => { listener(state) } }
}

it('keeps pushed multi-window state ahead of stale replies while settling its own operation', async () => {
  const f = fixture()
  f.emit(nightly)
  f.get.resolve(latest)
  await f.get.promise
  expect(f.source.store.getSnapshot().state).toEqual(nightly)
  const pending = f.source.select('latest')
  expect(f.source.store.getSnapshot().pending).toBe('latest')
  await f.source.select('nightly')
  expect(f.select).toHaveBeenCalledOnce()
  f.emit(latest)
  f.emit(nightly)
  f.set.resolve({ kind: 'applied', state: latest })
  await pending
  expect(f.source.store.getSnapshot()).toEqual({ state: nightly, failed: false, notice: { sequence: 1, outcome: 'applied' } })
  f.source.dispose()
  expect(f.unsubscribe).toHaveBeenCalledOnce()
})

it('rolls back a rejected save and retains a toast across shell broadcasts', async () => {
  const f = fixture()
  f.get.resolve(nightly)
  await f.get.promise
  const pending = f.source.select('latest')
  f.emit({ ...nightly, changing: true })
  f.emit(nightly)
  f.set.resolve({ kind: 'failed', state: nightly, reason: 'format' })
  await pending
  expect(f.source.store.getSnapshot()).toEqual({ state: nightly, failed: false, notice: { sequence: 1, outcome: 'format' } })
  f.emit(latest)
  expect(f.source.store.getSnapshot().notice?.outcome).toBe('format')
  await f.source.select('nightly')
  f.source.dismissNotice(1)
  expect(f.source.store.getSnapshot().notice?.sequence).toBe(2)
  f.source.dismissNotice(2)
  expect(f.source.store.getSnapshot().notice).toBeUndefined()
  f.source.dispose()
})

it('reports generic save failure after transport rejection without flagging global state', async () => {
  const f = fixture()
  f.get.resolve(nightly)
  await f.get.promise
  const pending = f.source.select('latest')
  f.emit(latest)
  f.set.reject(new Error('IPC closed'))
  await pending
  expect(f.source.store.getSnapshot()).toEqual({ state: latest, failed: false, notice: { sequence: 1, outcome: 'save' } })
  f.source.dispose()
})

it('ignores events, successful replies and new requests after disposal', async () => {
  const f = fixture()
  const pending = f.source.select('latest')
  f.source.dispose()
  const before = f.source.store.getSnapshot()
  f.emit(latest)
  f.get.resolve(nightly)
  f.set.resolve({ kind: 'applied', state: latest })
  await pending
  await f.source.select('nightly')
  expect(f.select).toHaveBeenCalledOnce()
  expect(f.source.store.getSnapshot()).toBe(before)
})

it('reports initial IPC failure and accepts a later explicit choice response', async () => {
  const f = fixture()
  f.get.reject(new Error('unavailable'))
  await Promise.resolve()
  expect(f.source.store.getSnapshot()).toEqual({ failed: true })
  const pending = f.source.select('latest')
  f.set.resolve({ kind: 'applied', state: latest })
  await pending
  expect(f.source.store.getSnapshot()).toEqual({ state: latest, failed: false, notice: { sequence: 1, outcome: 'applied' } })
  f.source.dispose()
})

it('ignores rejected reads after an event and all rejected responses after disposal', async () => {
  const f = fixture()
  f.emit(nightly)
  f.get.reject(new Error('stale read'))
  await Promise.resolve()
  expect(f.source.store.getSnapshot()).toEqual({ state: nightly, failed: false })
  f.source.dispose()
  const closed = fixture()
  const writing = closed.source.select('latest')
  closed.source.dispose()
  const before = closed.source.store.getSnapshot()
  closed.get.reject(new Error('late read'))
  closed.set.reject(new Error('late write'))
  await writing
  expect(closed.source.store.getSnapshot()).toBe(before)
})

it('does not let a late initial read overwrite an accepted selection', async () => {
  const f = fixture()
  const pending = f.source.select('latest')
  f.set.resolve({ kind: 'applied', state: latest })
  await pending
  f.get.resolve(nightly)
  await f.get.promise
  expect(f.source.store.getSnapshot().state).toEqual(latest)
  f.source.dispose()
})


it('does not submit or toast for the current healthy selection', async () => {
  const f = fixture()
  f.get.resolve(nightly)
  await f.get.promise
  await f.source.select('nightly')
  expect(f.select).not.toHaveBeenCalled()
  expect(f.source.store.getSnapshot()).toEqual({ state: nightly, failed: false })
  f.source.dispose()
})

it('allows same-channel recovery and suppresses feedback for a shell no-op', async () => {
  const f = fixture()
  f.emit({ ...nightly, error: 'cleanup' })
  const pending = f.source.select('nightly')
  expect(f.select).toHaveBeenCalledWith('nightly')
  f.set.resolve({ kind: 'unchanged', state: nightly })
  await pending
  expect(f.source.store.getSnapshot()).toEqual({ state: nightly, failed: false })
  f.source.dispose()
})
