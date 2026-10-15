/** Shared discovery preserves explicit retries, acknowledged changes and connection ownership. */
import { expect, it, vi } from 'vitest'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { TerminalInventory } from '../src/client/inventory.ts'
import type { WebTerminalId, WebTerminalInfo } from '../src/types.ts'

const info: WebTerminalInfo = { id: 'terminal' as WebTerminalId, title: 'bash', shell: { name: 'bash', path: '/bin/bash', args: [] }, cwd: '/workspace', cols: 80, rows: 24, state: 'running', exitCode: null }
const success = (value: WebTerminalInfo[]): RemoteResult<WebTerminalInfo[]> => ({ ok: true, value })

it('retains an empty list and a discovery failure until an explicit shared retry', async () => {
  const error = new RemoteError('gateway/bad-request', 'Host unavailable', {})
  const load = vi.fn<() => Promise<RemoteResult<WebTerminalInfo[]>>>()
    .mockResolvedValueOnce({ ok: false, error }).mockResolvedValue(success([]))
  const inventory = new TerminalInventory(load)
  try {
    await expect(inventory.read()).rejects.toBe(error)
    await expect(inventory.read()).rejects.toBe(error)
    expect(load).toHaveBeenCalledOnce()
    const retry = inventory.read(true)
    expect(inventory.read(true)).toBe(retry)
    expect((await retry).size).toBe(0)
    expect((await inventory.read()).size).toBe(0)
    expect(load).toHaveBeenCalledTimes(2)
  } finally { await inventory.dispose() }
})

it('merges creation, rename, state frames and closure over an older pending list', async () => {
  const listed = Promise.withResolvers<RemoteResult<WebTerminalInfo[]>>()
  const inventory = new TerminalInventory(() => listed.promise)
  const created = { ...info, id: 'created' as WebTerminalId }
  const closed = { ...info, id: 'closed' as WebTerminalId }
  const renamed = { ...info, title: 'Build', state: 'exited' as const, exitCode: 0 }
  const pending = inventory.read()
  try {
    inventory.update(created)
    inventory.update(renamed)
    inventory.remove(closed.id)
    listed.resolve(success([info, closed]))
    const result = await pending
    expect([...result.values()]).toEqual([renamed, created])
    inventory.remove(created.id)
    expect([...(await inventory.read()).values()]).toEqual([renamed])
  } finally { listed.resolve(success([])); await inventory.dispose() }
})

it.each(['success', 'failure'] as const)('ignores a previous connection response after replacement: %s', async (outcome) => {
  const previous = Promise.withResolvers<RemoteResult<WebTerminalInfo[]>>()
  const current = Promise.withResolvers<RemoteResult<WebTerminalInfo[]>>()
  const load = vi.fn<() => Promise<RemoteResult<WebTerminalInfo[]>>>()
    .mockReturnValueOnce(previous.promise).mockReturnValueOnce(current.promise)
  const inventory = new TerminalInventory(load)
  const pending = inventory.read()
  const next = { ...info, title: 'Current Host' }
  try {
    const replacement = inventory.reset()
    expect(inventory.read()).toBe(replacement)
    current.resolve(success([next]))
    expect([...(await inventory.read()).values()]).toEqual([next])
    if (outcome === 'success') previous.resolve(success([info]))
    else previous.reject(new Error('Old connection failed'))
    expect([...(await pending).values()]).toEqual([next])
    expect(load).toHaveBeenCalledTimes(2)
  } finally { previous.resolve(success([])); current.resolve(success([])); await inventory.dispose() }
})

it('does not discover unused inventories on reconnect and refreshes a settled inventory once', async () => {
  const load = vi.fn(async () => success([info]))
  const inventory = new TerminalInventory(load)
  try {
    inventory.update(info)
    expect(inventory.reset()).toBeUndefined()
    expect(load).not.toHaveBeenCalled()
    await inventory.read()
    const refreshed = inventory.reset()
    expect(inventory.read()).toBe(refreshed)
    await refreshed
    expect(load).toHaveBeenCalledTimes(2)
  } finally { await inventory.dispose() }
})

it('joins outstanding requests on disposal and rejects their late results', async () => {
  const listed = Promise.withResolvers<RemoteResult<WebTerminalInfo[]>>()
  const load = vi.fn(() => listed.promise)
  const inventory = new TerminalInventory(load)
  const pending = inventory.read()
  const rejected = expect(pending).rejects.toThrow('Terminal inventory disposed')
  let disposed = false
  const disposing = inventory.dispose().then(() => { disposed = true })
  try {
    expect(disposed).toBe(false)
    inventory.update(info)
    inventory.remove(info.id)
    expect(inventory.reset()).toBeUndefined()
    await expect(inventory.read()).rejects.toThrow('Terminal inventory disposed')
    listed.resolve(success([info]))
    await rejected
    await disposing
    expect(disposed).toBe(true)
    expect(load).toHaveBeenCalledOnce()
  } finally { listed.resolve(success([])); await disposing }
})

it('preserves a non-Error transport rejection as the cached failure cause', async () => {
  const load = vi.fn<() => Promise<RemoteResult<WebTerminalInfo[]>>>().mockRejectedValue('offline')
  const inventory = new TerminalInventory(load)
  try {
    await expect(inventory.read()).rejects.toMatchObject({ message: 'Terminal discovery failed', cause: 'offline' })
  } finally { await inventory.dispose() }
})
