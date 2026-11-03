import { expect, it, vi } from 'vitest'
import { DesktopChannelSource } from '../src/client/desktop-channel-source.ts'
import type { DesktopChannelState, DesktopChannelChangeResult } from '../src/types.ts'

const nightly: DesktopChannelState = { channel: 'nightly', packagedChannel: 'nightly', changing: false }
const stable: DesktopChannelState = { ...nightly, channel: 'stable' }

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
  f.get.resolve(stable)
  await f.get.promise
  expect(f.source.store.getSnapshot().state).toEqual(nightly)
  const pending = f.source.select('stable')
  expect(f.source.store.getSnapshot().pending).toBe('stable')
  await f.source.select('nightly')
  expect(f.select).toHaveBeenCalledOnce()
  f.emit(stable)
  f.emit(nightly)
  f.set.resolve({ kind: 'applied', state: stable })
  await pending
  expect(f.source.store.getSnapshot()).toEqual({ state: nightly, failed: false, notice: { sequence: 1, outcome: 'applied' } })
  f.source.dispose()
  expect(f.unsubscribe).toHaveBeenCalledOnce()
})

it('rolls back a rejected save and retains a toast across shell broadcasts', async () => {
  const f = fixture()
  f.get.resolve(nightly)
  await f.get.promise
  const pending = f.source.select('stable')
  f.emit({ ...nightly, changing: true })
  f.emit(nightly)
  f.set.resolve({ kind: 'failed', state: nightly, reason: 'format' })
  await pending
  expect(f.source.store.getSnapshot()).toEqual({ state: nightly, failed: false, notice: { sequence: 1, outcome: 'format' } })
  f.emit(stable)
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
  const pending = f.source.select('stable')
  f.emit(stable)
  f.set.reject(new Error('IPC closed'))
  await pending
  expect(f.source.store.getSnapshot()).toEqual({ state: stable, failed: false, notice: { sequence: 1, outcome: 'save' } })
  f.source.dispose()
})

it('ignores events, successful replies and new requests after disposal', async () => {
  const f = fixture()
  const pending = f.source.select('stable')
  f.source.dispose()
  const before = f.source.store.getSnapshot()
  f.emit(stable)
  f.get.resolve(nightly)
  f.set.resolve({ kind: 'applied', state: stable })
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
  const pending = f.source.select('stable')
  f.set.resolve({ kind: 'applied', state: stable })
  await pending
  expect(f.source.store.getSnapshot()).toEqual({ state: stable, failed: false, notice: { sequence: 1, outcome: 'applied' } })
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
  const writing = closed.source.select('stable')
  closed.source.dispose()
  const before = closed.source.store.getSnapshot()
  closed.get.reject(new Error('late read'))
  closed.set.reject(new Error('late write'))
  await writing
  expect(closed.source.store.getSnapshot()).toBe(before)
})

it('does not let a late initial read overwrite an accepted selection', async () => {
  const f = fixture()
  const pending = f.source.select('stable')
  f.set.resolve({ kind: 'applied', state: stable })
  await pending
  f.get.resolve(nightly)
  await f.get.promise
  expect(f.source.store.getSnapshot().state).toEqual(stable)
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


it('announces startup file errors once and keeps their state after the toast closes', async () => {
  const f = fixture()
  const state: DesktopChannelState = { ...nightly, channel: null, error: 'format' }
  f.get.resolve(state)
  await f.get.promise
  expect(f.source.store.getSnapshot().notice).toEqual({ sequence: 1, outcome: 'configuration' })
  f.source.dismissNotice(1)
  f.emit(state)
  expect(f.source.store.getSnapshot()).toEqual({ state, failed: false })
  f.source.dispose()
})

it.each(['before', 'after'] as const)('retains uncertain-save feedback when suspension arrives %s the reply', async (order) => {
  const f = fixture()
  f.emit(nightly)
  const pending = f.source.select('stable')
  const suspended = { ...nightly, error: 'read' as const }
  if (order === 'before') f.emit(suspended)
  f.set.resolve({ kind: 'failed', state: suspended, reason: 'uncertain' })
  await pending
  if (order === 'after') f.emit(suspended)
  expect(f.source.store.getSnapshot()).toMatchObject({ state: suspended, notice: { outcome: 'uncertain' } })
  f.source.dispose()
})
