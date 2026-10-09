/** Local backend fixtures over the production activation lifecycle. */
import { mountWorkingDirectoryFixture } from './working-directory-fixture.ts'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { type ContinuableCreateSpec, type SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { onTestFinished } from 'vitest'

/**
 * Mount isolated persistence and remove it after the context reaches quiescence.
 * @param ctx - test runtime that owns the local child sessions.
 */
export async function mountLocalActivations(ctx: Context): Promise<void> {
  await mountWorkingDirectoryFixture(ctx)
  const root = await mkdtemp(join(tmpdir(), 'dsh-local-activation-'))
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  await ctx.plugin(JsonlSessionPersistence, { root })
}

/**
 * Start a real activation while retaining its published local Agent for assertions.
 * @param ctx - runtime carrying the subagent and Agent services.
 * @param provider - registered local provider name.
 * @param request - child task and optional publication cancellation signal.
 * @returns The activation with test aliases for its child identity and Agent.
 */
export async function startTestActivation(
  ctx: Context,
  provider: string,
  request: Omit<SubagentStartRequest, 'signal'> & { signal?: AbortSignal },
) {
  const { signal = new AbortController().signal, label = provider, ...task } = request
  const activation = await ctx.get('subagents')!.startActivation({ provider, label, request: task, signal, delivery: 'caller' })
  return { ...activation, id: activation.childId, localAgent: ctx.get('agents')!.get(activation.childId)! }
}

/**
 * Supply a test-selected seed through a temporary preparation provider.
 * @param request - child task and exact live parent.
 * @param prepared - detached local creation inputs.
 * @returns The published local activation and assertion aliases.
 */
export function startPreparedActivation(request: SubagentStartRequest, prepared: ContinuableCreateSpec = {}) {
  const ctx = request.parent.ctx
  const provider = `prepared-${randomUUID()}`
  const unregister = ctx.get('subagents')!.registerProvider({
    name: provider,
    capabilities: { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
    inheritsParentContext: prepared.seed !== undefined,
    prepareContinuable: () => Promise.resolve(prepared),
  })
  return startTestActivation(ctx, provider, request).finally(() => { unregister() })
}
