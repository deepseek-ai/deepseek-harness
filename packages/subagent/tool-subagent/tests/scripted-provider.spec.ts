import { mountWorkingDirectoryFixture } from '../../subagent/tests/working-directory-fixture.ts'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { type Agent } from '@deepseek-ai/dsh-agent'
import SubagentRuntime, { type ResolvedSubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as scripted from './scripted-provider.ts'

/** A minimal parent; the scripted provider only reads its id. */
function fakeParent(id = 'parent-1'): Agent {
  return { id: SessionId(id) } as unknown as Agent
}

function baseRequest(over: Partial<ResolvedSubagentStartRequest> = {}): ResolvedSubagentStartRequest {
  return {
    cwd: process.cwd(),
    prompt: [{ type: 'text', text: 'task' }],
    parent: fakeParent(),
    signal: new AbortController().signal,
    ...over,
  }
}

async function mount(config: Partial<scripted.Config> = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await mountWorkingDirectoryFixture(ctx)
  await ctx.plugin(SubagentRuntime)
  await scripted.mountScriptedProvider(ctx, { name: 'mock', ...config })
  return ctx
}

describe('scripted subagent provider fixture', () => {
  it('registers through the real service and returns the scripted reply', async () => {
    const ctx = await mount({ reply: 'hello from fixture' })
    expect(ctx.subagents.list()).toEqual(['mock'])

    const run = await ctx.subagents.getProvider('mock')!.start!(baseRequest())
    await expect(run.result).resolves.toEqual({
      output: [{ type: 'text', text: 'hello from fixture' }],
      structured: undefined,
      stopReason: 'completed',
    })
    await run.dispose()
  })

  it('registers under a configurable name', async () => {
    const ctx = await mount({ name: 'spawn' })
    expect(ctx.subagents.list()).toEqual(['spawn'])
  })

  it('returns configured and default structured results', async () => {
    const configured = await mount({ reply: 'r', structured: { answer: 42 } })
    const schema = { type: 'object' as const, properties: { answer: { type: 'number' as const } } }
    const configuredRun = await configured.subagents.getProvider('mock')!.start!(baseRequest({ outputSchema: schema }))
    await expect(configuredRun.result).resolves.toMatchObject({ structured: { answer: 42 } })

    const fallback = await mount({ reply: 'fallback reply' })
    const fallbackRun = await fallback.subagents.getProvider('mock')!.start!(baseRequest({ outputSchema: schema }))
    await expect(fallbackRun.result).resolves.toMatchObject({ structured: { reply: 'fallback reply' } })
  })

  it('omits structured output when no schema is requested', async () => {
    const ctx = await mount({ capabilities: { outputSchema: false } })
    const run = await ctx.subagents.getProvider('mock')!.start!(baseRequest())
    expect(await run.result).not.toHaveProperty('structured')
  })

  it('honors configured and cancellation stop reasons', async () => {
    const refused = await mount({ stopReason: 'refusal' })
    const refusedRun = await refused.subagents.getProvider('mock')!.start!(baseRequest())
    await expect(refusedRun.result).resolves.toMatchObject({ stopReason: 'refusal' })

    const cancelled = await mount({ onStart: () => new Promise<void>(() => {}) })
    const controller = new AbortController()
    const cancelledRun = await cancelled.subagents.getProvider('mock')!.start!(baseRequest({ signal: controller.signal }))
    controller.abort()
    await expect(cancelledRun.result).resolves.toMatchObject({ stopReason: 'aborted' })
  })

  it('rejects cancellation before or during asynchronous publication', async () => {
    const ctx = await mount()
    const alreadyAborted = new AbortController()
    alreadyAborted.abort()
    await expect(ctx.subagents.getProvider('mock')!.start!(baseRequest({ signal: alreadyAborted.signal })))
      .rejects.toThrow('scripted subagent start aborted before publication')

    const handoff = new AbortController()
    const pending = ctx.subagents.getProvider('mock')!.start!(baseRequest({ signal: handoff.signal }))
    handoff.abort()
    await expect(pending).rejects.toThrow('scripted subagent start aborted before publication')
  })

  it('unregisters with its owning fixture fiber', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await mountWorkingDirectoryFixture(ctx)
    await ctx.plugin(SubagentRuntime)
    const fiber = await scripted.mountScriptedProvider(ctx, { name: 'mock' })
    expect(ctx.subagents.list()).toEqual(['mock'])
    await fiber.dispose()
    expect(ctx.subagents.list()).toEqual([])
  })
})
