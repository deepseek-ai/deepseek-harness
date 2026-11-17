import { Context } from '@deepseek-ai/cordis'
import type { PluginOperation } from '@deepseek-ai/dsh-plugin-manager/types'
import type { PluginOperationRunId } from '@deepseek-ai/dsh-plugin-manager/diagnostic'
import { expect, it, onTestFinished, vi } from 'vitest'
import { installOperationDiagnostics } from '../src/operation-diagnostics.ts'

const operation: PluginOperation = {
  id: 'c254ab28-97c9-4382-95e6-2db9c66f98c9' as PluginOperation['id'],
  time: '2026-10-19T00:00:00.000Z', reason: 'plugin', phase: 'started', target: 'managed', stage: 'enable',
}
const runId = 'c254ab28-97c9-4382-95e6-2db9c66f98c8' as PluginOperationRunId

it('bounds outstanding deliveries and drains them on context disposal', async () => {
  const ctx = new Context()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  onTestFinished(async () => { release.resolve(undefined); await ctx.fiber.dispose() })
  const send = vi.fn(async () => { entered.resolve(undefined); await release.promise })
  installOperationDiagnostics(ctx, send, 1, runId)
  ctx.emit('plugin-manager/operation', operation)
  await entered.promise
  for (let i = 0; i < 1000; i++) ctx.emit('plugin-manager/operation', operation)
  expect(send).toHaveBeenCalledTimes(1)
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ runId }))
  let stopped = false
  const stopping = ctx.fiber.dispose().then(() => { stopped = true })
  await Promise.resolve(undefined)
  expect(stopped).toBe(false)
  release.resolve(undefined)
  await stopping
  ctx.emit('plugin-manager/operation', operation)
  expect(send).toHaveBeenCalledTimes(1)
})

it('contains transport rejections during teardown', async () => {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  installOperationDiagnostics(ctx, async () => { throw new Error('disconnected') }, 1, runId)
  ctx.emit('plugin-manager/operation', operation)
  await expect(ctx.fiber.dispose()).resolves.toBeUndefined()
})
