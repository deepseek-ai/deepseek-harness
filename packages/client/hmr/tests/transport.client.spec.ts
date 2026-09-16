/** Web transport delegates module and entry changes to the page-owned controller. */
import { Context } from '@deepseek-ai/cordis'
import type { ClientModuleLoader } from '@deepseek-ai/dsh-client-modules/client'
import { afterEach, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('forwards full graphs and rebuilt frames, contains wire errors and closes its EventSource', async () => {
  const ctx = new Context()
  const sync = vi.fn(async () => {})
  const reload = vi.fn(async () => {})
  ctx.provide('modules', { entries: { sync, reload } } as unknown as ClientModuleLoader)
  const warnings = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
  const errors = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
  let receive!: (event: { data: string }) => void
  const close = vi.fn()
  vi.stubGlobal('EventSource', class {
    close = close
    addEventListener(_name: string, listener: typeof receive) { receive = listener }
  })
  const fiber = ctx.plugin({ apply, inject })
  try {
    await fiber.await()
    const graph = { rev: 'r', entries: [], batches: [] }
    receive({ data: JSON.stringify({ type: 'graph', graph }) })
    receive({ data: JSON.stringify({ type: 'rebuilt', id: 'a', rev: 'r1' }) })
    await vi.waitFor(() => { expect(sync).toHaveBeenCalledWith(graph) })
    expect(reload).toHaveBeenCalledWith('a', 'r1')
    receive({ data: '{' })
    receive({ data: JSON.stringify({ type: 'graph', graph: null }) })
    receive({ data: JSON.stringify({ type: 'future' }) })
    expect(warnings).toHaveBeenCalledTimes(2)
    sync.mockRejectedValueOnce(new Error('invalid graph'))
    receive({ data: JSON.stringify({ type: 'graph', graph: {} }) })
    await vi.waitFor(() => { expect(errors).toHaveBeenCalledWith(expect.objectContaining({ message: 'invalid graph' })) })
  } finally {
    await fiber.dispose()
    await ctx.fiber.dispose()
  }
  expect(close).toHaveBeenCalledOnce()
})
