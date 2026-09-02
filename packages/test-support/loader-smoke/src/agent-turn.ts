/**
 * Test-only direct-agent turn driver shared by assembled Loader fixtures.
 * @module @deepseek-ai/dsh-loader-smoke/agent-turn
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type TokenUsage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** Result envelope consumed only by snapshot and composition tests. */
export interface FixtureTurnResult {
  readonly type: 'result'
  readonly sessionId: string
  readonly output: string
  readonly usage?: TokenUsage
}

/** Options for one fixture turn against exactly one configured root agent. */
export interface FixtureTurnOptions {
  readonly task: string
  readonly onEvent?: (sessionId: string, event: SessionEvent) => void
}

function addUsage(total: TokenUsage | undefined, step: TokenUsage): TokenUsage {
  const next: TokenUsage = {
    inputTokens: (total?.inputTokens ?? 0) + step.inputTokens,
    outputTokens: (total?.outputTokens ?? 0) + step.outputTokens,
  }
  for (const key of ['cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const) {
    if (total?.[key] !== undefined || step[key] !== undefined) next[key] = (total?.[key] ?? 0) + (step[key] ?? 0)
  }
  return next
}

function assistantText(event: Extract<SessionEvent, { type: 'assistant/message' }>): string | undefined {
  const blocks = event.data.message.content.filter(block => block.type === 'text')
  return blocks.length === 0 ? undefined : blocks.map(block => block.text).join('')
}

async function onlyRootAgent(ctx: Context): Promise<Agent> {
  const registry = ctx.get('agents')
  if (registry === undefined) throw new Error('fixture turn requires exactly one top-level agent, found 0')
  // Configured agents publish asynchronously (persistence create/resume runs
  // before publication), so a settled Loader does not imply a registered
  // agent yet; wait for the first publication instead of requiring it.
  if (registry.roots().length === 0) {
    await new Promise<void>((resolve) => {
      const dispose = ctx.on('agent/created', () => {
        dispose()
        resolve()
      })
    })
  }
  const agents = registry.roots()
  const [agent] = agents
  if (agent === undefined || agents.length !== 1) {
    throw new Error(`fixture turn requires exactly one top-level agent, found ${agents.length}`)
  }
  return agent
}

/**
 * Drive one task from its durable inbox receipt through whole-agent idle.
 * @param ctx - settled Loader context with exactly one configured root agent.
 * @param options - task and optional canonical-event observer.
 * @returns the final assistant text and accumulated model usage.
 */
export async function runFixtureTurn(ctx: Context, options: FixtureTurnOptions): Promise<FixtureTurnResult> {
  const agent = await onlyRootAgent(ctx)
  await agent.whenIdle()

  const message = createUserMessage({
    content: [{ type: 'text', text: options.task }],
    source: { kind: 'user' },
  })
  let received = false
  let output = ''
  const usageByStep = new Map<string, TokenUsage>()
  const disposeListener = ctx.on('session/event', (session, event) => {
    if (session !== agent.session) return
    if (!received) {
      if (event.type !== 'agent/inbox/spliced'
        || !event.data.inserted.some(inserted => inserted.id === message.id)) return
      received = true
    }
    options.onEvent?.(session.id, event)
    if (event.type === 'assistant/chunk' && event.data.chunk.type === 'usage') {
      usageByStep.set(`${event.data.turn}/${event.data.step}`, event.data.chunk.usage)
    }
    if (event.type === 'assistant/message') {
      output = assistantText(event) ?? output
      if (event.data.usage !== undefined) {
        usageByStep.set(`${event.data.turn}/${event.data.step}`, event.data.usage)
      }
    }
  })

  try {
    agent.followup(message)
    await agent.whenIdle()
  } finally {
    disposeListener()
  }
  await ctx.sessions.flush(agent.session)
  const usage = [...usageByStep.values()].reduce<TokenUsage | undefined>(addUsage, undefined)
  return {
    type: 'result',
    sessionId: agent.session.id,
    output,
    ...usage === undefined ? {} : { usage },
  }
}
