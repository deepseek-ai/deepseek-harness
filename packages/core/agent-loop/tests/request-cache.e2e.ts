import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'

import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'

/**
 * With-key proof that log-derived requests translate into real provider cache hits: a
 * multi-step tool turn (plus a follow-up turn) against the live DeepSeek API must report
 * `cacheReadTokens > 0` on every request after the first — the adapter maps the provider's
 * `prompt_cache_hit_tokens`, and the per-step usage recorded on `assistant/message` events is
 * the production observable for cache behavior (the reconstructability Agent Note's measurement
 * layer: prefix stability is corollary #1). Mocks establish append-extension;
 * this key-gated test establishes a real provider cache hit.
 */

// Long enough that the shared request prefix comfortably spans the provider's
// cache-block granularity (64 tokens) from the very first request.
const SYSTEM = 'You are a terse coding assistant used in an automated cache test. '
  + 'Always follow instructions literally and exactly. When the user asks you to look '
  + 'something up, call the lookup tool with the requested key and wait for its result '
  + 'before answering. Never invent a value the tool has not returned. After the tool '
  + 'returns, answer with a single short sentence that repeats the returned value '
  + 'verbatim. Do not add explanations, do not use markdown, do not ask follow-up '
  + 'questions. If the user asks anything else, answer in one short sentence.'

let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
})

async function loopHarness(): Promise<Context> {
  const created = new Context()
  await created.plugin(LlmRuntime)
  await created.plugin(SessionStore)
  await created.plugin(SessionProjectionRegistry)
  await created.plugin(SystemPrompt, { personaPrefix: SYSTEM })
  await created.plugin(ToolRuntime)
  await created.plugin(AgentRegistry)
  await created.plugin(AgentLoop, { agents: [] })
  await created.plugin(LlmDeepSeek)
  created.tools.register(defineContentToolFixture({
    name: 'lookup',
    description: 'Look up the stored value for a key.',
    parameters: { key: { type: 'string', description: 'The key to look up.' } },
    async execute(args) {
      return [{ type: 'text', text: `value(${String(args.key)}) = azure-falcon-42` }]
    },
  }))
  return created
}

function waitForIdle(context: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = context.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

describe.skipIf(!process.env.DEEPSEEK_API_KEY)('log-derived request cache hits (real API)', () => {
  it('every request after the first hits the provider prefix cache', async () => {
    ctx = await loopHarness()
    const agent = await ctx.agentLoop.create(SessionId('cache-e2e'), { provider: 'deepseek-official', model: 'deepseek-v4-flash' })

    // Turn 1: forces a tool call → at least two steps (two model requests).
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Look up the key "deploy-color" with the lookup tool and tell me the value.' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    // Turn 2: a follow-up over the same (longer) prefix.
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Thanks. Repeat that value one more time.' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const usages = agent.session.snapshotEvents()
      .filter(e => e.type === 'assistant/message')
      .map(e => e.data.usage)
    expect(usages.length).toBeGreaterThanOrEqual(3) // 2 steps in turn 1 + ≥1 in turn 2
    for (const usage of usages) expect(usage).toBeDefined()

    // The first request has nothing to hit; every later one shares its
    // predecessor as a byte-identical prefix, so the provider must report
    // cached prompt tokens (prompt_cache_hit_tokens → cacheReadTokens).
    for (const usage of usages.slice(1)) {
      expect(usage!.cacheReadTokens ?? 0).toBeGreaterThan(0)
    }

    // World-verification of the conversation itself: the tool value made it
    // through the loop into the final answer.
    const finalText = agent.session.deriveMessages().at(-1)!.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    expect(finalText).toContain('azure-falcon-42')
  }, 180_000)
})
