/** Session storage integration driver mounted through the shipped headless profile. @module */
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as json } from 'zod'
import { SessionId, SessionLogOffset, SessionSeq, buildForkSeed } from '@deepseek-ai/dsh-session'
import { EchoModel, runSession } from './segment-runtime.ts'

interface Config { report: string; stage: 'legacy' | 'seed' | 'branch' | 'resume' | 'failure'; mock: boolean; cut?: number }
export const name = 'segment-storage-test-driver'
export const inject = ['agents', 'agentLoop', 'sessions', 'sessionPersistence', 'llm', 'agentDefaultModel', 'tools']
export const Config: z<Config> = z.object({ report: z.string().required(),
  stage: z.union(['legacy', 'seed', 'branch', 'resume', 'failure']).required(), mock: z.boolean().required(), cut: z.natural() })

/**
 * Execute storage scenarios through real profile services.
 * @param ctx - normal application profile context.
 * @param config - test report destination and requested scenario.
 */
export function apply(ctx: Context, config: Config): void {
  if (config.mock) ctx.llm.registerAdapter(['segment-test'], new EchoModel())
  const toolRuns: { id: string; value: string }[] = []
  ctx.tools.register({ name: 'segment_probe', description: 'Return a unique test result for this Session.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: json.string().parse(value) }] },
    async execute(_args, exec) {
      if (exec.agent === undefined) throw new Error('Missing Agent')
      const value = `result-${randomUUID()}`
      toolRuns.push({ id: exec.agent.session.id, value })
      return value
    },
  })
  const ready = ctx.get('appReady')
  if (ready === undefined) throw new Error('Expected normal launcher readiness')
  const execute = async () => {
    const exit = ctx.get('appExit')
    if (exit === undefined) throw new Error('Expected normal launcher exit service')
    try {
      const results: Awaited<ReturnType<typeof runSession>>[] = []
      const refusals: { name: string; message: string }[] = []
      let cut: number | undefined
      const recall = 'RECALL_LAST_TOOL: Return exactly the most recent segment_probe result in this conversation. Do not call tools.'
      const probe = 'TOOL_PROOF: Call segment_probe once and return exactly its result.'
      switch (config.stage) {
        case 'legacy': results.push(await runSession(ctx, 'legacy-chat', probe)); break
        case 'seed': {
          results.push(await runSession(ctx, 'legacy-chat', recall))
          results.push(await runSession(ctx, 'source-chat', probe))
          const stored = await ctx.sessionPersistence.stat(SessionId('source-chat'))
          if (stored?.eventCount === undefined) throw new Error('Missing prefix offset')
          cut = stored.eventCount
          results.push(await runSession(ctx, 'source-chat', probe))
          break
        }
        case 'branch': {
          const storage = ctx.sessionPersistence
          if (config.cut === undefined) throw new Error('Missing fork setup')
          const cut = config.cut
          const parent = await storage.open(SessionId('source-chat'), 'read')
          let seed
          try { seed = buildForkSeed((await parent.read()).events, SessionSeq(cut - 1)) }
          finally { await parent.close() }
          const child = await ctx.agents.create({ sessionId: SessionId('side-chat'), seed,
            inheritedEventCount: SessionLogOffset(cut), meta: { cwd: process.cwd(), isSeeded: true },
            agentOptions: ctx.agentDefaultModel.currentSelection() })
          await child.dispose()
          results.push(await runSession(ctx, 'side-chat', recall))
          results.push(await runSession(ctx, 'side-chat', probe))
          results.push(await runSession(ctx, 'source-chat', recall))
          results.push(await runSession(ctx, 'source-chat', probe))
          results.push(await runSession(ctx, 'side-chat', recall))
          break
        }
        case 'resume':
          results.push(...await Promise.all(['legacy-chat', 'source-chat', 'side-chat'].map(id => runSession(ctx, id, recall))))
          results.push(await runSession(ctx, 'post-restart', probe))
          break
        case 'failure':
          try { await runSession(ctx, 'source-chat', recall) }
          catch (error: unknown) { if (!(error instanceof Error)) throw error; refusals.push({ name: error.name, message: error.message }) }
          if (refusals.length !== 1) throw new Error('Damaged storage unexpectedly loaded')
          results.push(await runSession(ctx, 'legacy-chat', recall))
          break
      }
      await writeFile(config.report, JSON.stringify({ stage: config.stage, results, toolRuns, refusals,
        ...cut === undefined ? {} : { cut } }, null, 2) + '\n')
      exit(0)
    } catch (error: unknown) { ctx.logger.error(error); exit(1) }
  }
  ctx.effect(() => ready.onReady(() => { void execute() }))
}
