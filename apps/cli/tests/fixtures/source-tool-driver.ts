/** Source-profile tool-dispatch evidence from the real Agent and Node module cache. */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-cmdline'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'

/** Observations from one isolated Agent's run through the shipped headless profile. */
export interface SourceToolEvidence {
  execArgv: string[]
  modules: string[]
  errors: string[]
  events: SessionEvent<'tool/call' | 'tool/result' | 'turn/end'>[]
}

/** Services needed to drive the Agent and inspect loaded modules. */
export const inject = ['agents', 'loader']

/**
 * Drive one mock-model turn after application readiness and dispose it before requesting exit.
 * @param ctx - context in the source-launched headless Loader tree.
 * @param config - isolated working directory for the Agent.
 */
export function apply(ctx: Context, config: { cwd: string }): void {
  const ready = ctx.get('appReady')
  const exit = ctx.get('appExit')
  if (ready === undefined || exit === undefined) throw new Error('Source tool driver requires appReady and appExit')
  const events: SourceToolEvidence['events'] = []
  const errors: string[] = []
  ctx.on('session/event', (_session, event) => {
    if (event.type === 'tool/call' || event.type === 'tool/result' || event.type === 'turn/end') events.push(event)
  }, { global: true })
  ctx.on('agent/error', ({ error }) => { errors.push(error instanceof Error ? error.message : String(error)) }, { global: true })

  const run = async (): Promise<void> => {
    const handle = await ctx.agents.create({
      sessionId: SessionId(randomUUID()),
      meta: { cwd: config.cwd },
      agentOptions: { provider: 'cli-mock', model: 'cli-mock' },
    })
    try {
      handle.agent.followup(createUserMessage({
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'Run the shell smoke command once.' }],
      }))
      await handle.agent.whenIdle()
      const internal = ctx.loader.internal
      if (internal === undefined) throw new Error('Source tool driver requires Node module-cache introspection')
      const evidence: SourceToolEvidence = {
        execArgv: process.execArgv,
        modules: [...internal.loadCache.keys()].filter(url => /\/packages\/core\/(?:tools|agent-loop)\//.test(url)),
        errors,
        events,
      }
      process.stdout.write(`DSH_SOURCE_TOOL_RESULT ${JSON.stringify(evidence)}\n`)
    } finally {
      await handle.dispose()
    }
    exit(errors.length === 0 ? 0 : 1)
  }

  ctx.effect(() => ready.onReady(() => {
    void run().catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
      exit(1)
    })
  }), 'source tool driver')
}
