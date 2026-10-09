import { mountWorkingDirectoryFixture } from './working-directory-fixture.ts'
/** External activation admission and resource ownership across parent lifetimes. */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '../src/index.ts'
import type { SubagentStartRequest, SubagentRun, SubagentResult } from '../src/types.ts'
import { externalTestParent } from './external-activation-helpers.ts'

const complete: SubagentResult = { output: [], stopReason: 'completed' }

async function setup(start: (request: SubagentStartRequest) => Promise<SubagentRun>, delivery: 'caller' | 'parent' = 'caller') {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await mountWorkingDirectoryFixture(ctx)
  await ctx.plugin(SubagentRuntime)
  const parent = await externalTestParent(ctx)
  ctx.subagents.registerProvider({
    name: 'external', inheritsParentContext: false,
    capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
    start,
  })
  return {
    ctx, parent,
    start: (owner: Agent = parent) => ctx.subagents.startActivation({
      provider: 'external', label: 'External work', signal: new AbortController().signal, delivery,
      request: { parent: owner, prompt: [{ type: 'text', text: 'work' }] },
    }),
  }
}

function run(id: string, result: Promise<SubagentResult>, dispose = () => Promise.resolve()): SubagentRun {
  return { id: SessionId(id), result, dispose }
}

describe('external activation ownership', () => {
  it('observes admitted startup and reports no children after the execution releases', async () => {
    const entered = Promise.withResolvers<undefined>()
    const published = Promise.withResolvers<SubagentRun>()
    const fixture = await setup(() => { entered.resolve(undefined); return published.promise })
    await expect(fixture.ctx.subagents.waitForChildren(fixture.parent)).resolves.toBe(false)
    const starting = fixture.start()
    await entered.promise
    const waiting = fixture.ctx.subagents.waitForChildren(fixture.parent)
    let released = false
    void waiting.then(() => { released = true })
    await Promise.resolve()
    expect(released).toBe(false)
    published.resolve(run('admitted-start', Promise.resolve(complete)))
    const activation = await starting
    await waiting
    await activation.dispose()
    await expect(fixture.ctx.subagents.waitForChildren(fixture.parent)).resolves.toBe(false)
  })

  it('drains one parent’s external child without cancelling another parent’s pending startup', async () => {
    const result = Promise.withResolvers<SubagentResult>()
    const startingSibling = Promise.withResolvers<undefined>()
    const sibling = Promise.withResolvers<SubagentRun>()
    let starts = 0
    let siblingSignal: AbortSignal | undefined
    const fixture = await setup(({ signal }) => {
      if (starts++ === 0) {
        signal.addEventListener('abort', () => { result.resolve({ output: [], stopReason: 'aborted' }) }, { once: true })
        return Promise.resolve(run('owned-child', result.promise))
      }
      siblingSignal = signal
      startingSibling.resolve(undefined)
      return sibling.promise
    })
    const otherParent = await externalTestParent(fixture.ctx)
    const first = await fixture.start()
    const other = fixture.start(otherParent)
    await startingSibling.promise
    await fixture.ctx.subagents.drainDescendants([fixture.parent])
    await expect(first.result).resolves.toMatchObject({ stopReason: 'aborted' })
    expect(siblingSignal?.aborted).toBe(false)
    sibling.resolve(run('sibling-child', Promise.resolve(complete)))
    const second = await other
    await second.dispose()
  })

  it('cleans an external execution whose id collides with a resident Session', async () => {
    const dispose = vi.fn(() => Promise.resolve())
    const fixture = await setup(() => Promise.resolve(run('occupied-id', Promise.resolve(complete), dispose)))
    fixture.ctx.sessions.create(SessionId('occupied-id'))
    await expect(fixture.start()).rejects.toMatchObject({ code: 'DUPLICATE_CHILD' })
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(fixture.ctx.sessionProjections.snapshot(fixture.parent.session, ['subagentCatalog']).values.subagentCatalog).toEqual([])
  })

  it('rejects a repeated external id across parents without disturbing its first execution', async () => {
    const firstResult = Promise.withResolvers<SubagentResult>()
    const firstDispose = vi.fn(() => Promise.resolve())
    const duplicateDispose = vi.fn(() => Promise.resolve())
    let starts = 0
    const fixture = await setup(() => Promise.resolve(starts++ === 0
      ? run('shared-external-id', firstResult.promise, firstDispose)
      : run('shared-external-id', Promise.resolve(complete), duplicateDispose)), 'parent')
    const otherParent = await externalTestParent(fixture.ctx)
    const first = await fixture.start()
    try {
      await expect(fixture.start(otherParent)).rejects.toMatchObject({ code: 'DUPLICATE_CHILD' })
      expect(duplicateDispose).toHaveBeenCalledOnce()
      expect(firstDispose).not.toHaveBeenCalled()
      expect(fixture.ctx.sessionProjections.snapshot(otherParent.session, ['subagentCatalog']).values.subagentCatalog).toEqual([])
      expect(fixture.ctx.sessionProjections.snapshot(fixture.parent.session, ['subagentCatalog']).values.subagentCatalog)
        .toMatchObject([{ id: first.childId, mode: 'external' }])
      await expect(fixture.ctx.subagents.waitForChildren(otherParent)).resolves.toBe(false)
    } finally {
      firstResult.resolve(complete)
      await first.dispose()
    }
    await expect(first.result).resolves.toEqual(complete)
    expect(firstDispose).toHaveBeenCalledOnce()
  })

  it('rejects messages to a resident external activation without affecting its result', async () => {
    const result = Promise.withResolvers<SubagentResult>()
    const fixture = await setup(() => Promise.resolve(run('no-continuation', result.promise)))
    const activation = await fixture.start()
    await expect(fixture.ctx.subagents.sendMessage(fixture.parent, activation.childId, [{ type: 'text', text: 'follow up' }], {
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'NOT_CONTINUABLE' })
    result.resolve(complete)
    await activation.dispose()
  })

  it('retains the catalog failure and reports cleanup failure during admission rollback', async () => {
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- external backends can reject without an Error.
    const dispose = vi.fn(() => Promise.reject(null))
    const fixture = await setup(() => Promise.resolve(run('rollback-child', Promise.resolve(complete), dispose)), 'parent')
    const failure = new Error('catalog unavailable')
    const append = vi.spyOn(fixture.parent.session, 'append').mockImplementationOnce(() => { throw failure })
    const warning = vi.spyOn(fixture.ctx.logger, 'warn')
    try {
      await expect(fixture.start()).rejects.toBe(failure)
      expect(dispose).toHaveBeenCalledOnce()
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('admission rollback failed:'))
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('unknown teardown failure'))
      await expect(fixture.ctx.subagents.waitForChildren(fixture.parent)).resolves.toBe(false)
    } finally {
      append.mockRestore()
      warning.mockRestore()
    }
  })

  it('contains a non-Error backend cleanup rejection and retains the execution result', async () => {
    const result = Promise.withResolvers<SubagentResult>()
    const cleanup = Promise.withResolvers<undefined>()
    const fixture = await setup(() => Promise.resolve(run('failed-cleanup', result.promise, () => cleanup.promise)))
    const activation = await fixture.start()
    result.resolve(complete)
    const disposal = activation.dispose()
    const rejected = expect(disposal).rejects.toThrow('unknown teardown failure')
    cleanup.reject({ private: 'SECRET_TOKEN' })
    await rejected
    await expect(activation.result).resolves.toEqual(complete)
    expect((await disposal.catch((error: unknown) => error) as Error).message).not.toContain('SECRET_TOKEN')
  })
})
