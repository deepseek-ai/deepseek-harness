import { expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Invariants from '@deepseek-ai/dsh-invariants'
import { assembleContextFor } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { harness, declare, contribution, agentOn } from './harness.ts'
import { livePresetMounts } from '../src/index.ts'
import * as invariant from '../src/invariant.ts'

it('rejects model use by an unjoined Agent but permits Host and cold-scope reads', async () => {
  const ctx = await harness()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(Invariants)
  await ctx.plugin(invariant)
  await declare(ctx, contribution('standard'))
  const handle = await ctx.agents.create({ sessionId: SessionId('unjoined') })
  await expect(ctx.systemPrompt.assemble(assembleContextFor(handle.agent))).rejects.toThrow('without joining')
  const agent = await agentOn(ctx, 'joined')
  await expect(ctx.systemPrompt.assemble(assembleContextFor(agent))).resolves.toBeDefined()
  await expect(ctx.systemPrompt.assemble({})).resolves.toBeDefined()
  await using lease = await ctx.agentPresets.acquireScope()
  await expect(ctx.systemPrompt.assemble({ scope: lease.key })).resolves.toBeDefined()
})

it('detects a late global service without confusing independent runtimes', async () => {
  const first = await harness()
  const second = await harness()
  onTestFinished(async () => { await first.fiber.dispose(); await second.fiber.dispose() })
  await first.plugin(Invariants)
  await first.plugin(invariant)
  let publish!: () => void
  first.loader.builtins.late = { apply(ctx: Context) {
    publish = () => { ctx.effect(() => ctx.reflect.provide('latePresetService', {})) }
  } }
  await declare(first, { id: 'standard', plugins: [{ name: 'cordis:late' }] })
  await declare(second, contribution('standard'))
  expect(livePresetMounts(first.fiber)).toHaveLength(1)
  expect(livePresetMounts(second.fiber)).toHaveLength(1)
  expect(() =>{  publish() }).toThrow('published process-global')
})
