/**
 * Property-based tests for the agent loop's inbox/turn scheduling (the
 * property-testing Agent Note). Deterministic by construction: schedules are driven
 * through the `agent/status` settle signal (no wall-clock sleeps), so a flake
 * is a finding, not timing noise.
 *
 * Invariants: every sent message appears exactly once in the log (none lost);
 * turn numbers strictly increase; status transitions follow
 * idle→running→idle, while teardown is a registry lifecycle.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'

import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import fc from 'fast-check'

/** A never-exhausting adapter: every model call returns the same short reply. */
class EchoAdapter extends LlmAdapter {
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.signal?.aborted) throw new Error('aborted')
    const text = 'ok'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function harness() {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], new EchoAdapter())
  return ctx
}

/** Resolve on the agent's next transition to idle (event-based, not polled). */
function nextIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

/** Record every status transition for the legal-machine assertion. Returns
 * the seen list plus a disposer for the listener (per the registry convention). */
function recordStatus(ctx: Context, agent: Agent): { seen: string[]; dispose: () => void } {
  const seen: string[] = []
  const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
    if (subject === agent) seen.push(status)
  })
  return { seen, dispose }
}

function userMessageTexts(agent: Agent): string[] {
  return agent.session.snapshotEvents()
    .filter(e => e.type === 'user/message')
    .map(e => (e.data as { content: { type: string; text?: string }[] }).content.map(b => b.text ?? '').join(''))
}

function turnNumbers(agent: Agent): number[] {
  return agent.session.snapshotEvents()
    .filter(e => e.type === 'turn/start')
    .map(e => e.data.turn)
}

function turnEndNumbers(agent: Agent): number[] {
  return agent.session.snapshotEvents()
    .filter(e => e.type === 'turn/end')
    .map(e => (e.data as { turn: number }).turn)
}

function userMessageCountsByTurn(agent: Agent): number[] {
  const counts: number[] = []
  for (const event of agent.session.snapshotEvents()) {
    if (event.type === 'turn/start') counts.push(0)
    if (event.type === 'user/message') counts[counts.length - 1]! += 1
  }
  return counts
}

/** Assert a status trace is a legal run: idle/running alternating, ending idle. */
function assertLegalStatusTrace(trace: string[]): void {
  for (let i = 1; i < trace.length; i++) {
    expect(trace[i]).not.toBe(trace[i - 1]) // no repeats (setStatus dedups)
  }
  for (const s of trace) expect(['idle', 'running']).toContain(s)
}

describe('agent loop scheduling properties', () => {
  it('a synchronous burst gives every message its own strictly increasing turn', async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.string({ minLength: 1 }), { minLength: 1, maxLength: 6 }),
      async (texts) => {
        const ctx = await harness()
        try {
          const agent = ctx.agentLoop.create(SessionId('a'), { provider: 'mock', model: 'mock' })
          const { seen: trace } = recordStatus(ctx, agent)
          const idle = nextIdle(ctx, agent)
          // Send all in one synchronous tick: they queue before the loop wakes.
          for (const text of texts) agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
          await idle

          // No message lost: every send appears as a user/message, in order.
          expect(userMessageTexts(agent)).toEqual(texts)
          // This failure-free fixture maps every item to an independent turn.
          expect(turnNumbers(agent)).toEqual(texts.map((_, i) => i + 1))
          expect(turnEndNumbers(agent)).toEqual(texts.map((_, i) => i + 1))
          expect(userMessageCountsByTurn(agent)).toEqual(texts.map(() => 1))
          expect(trace).toEqual(['running', 'idle'])
          assertLegalStatusTrace(trace)
        } finally {
          await ctx.fiber.dispose()
        }
      },
    ), { numRuns: 25, timeout: 2000 })
  })

  it('sequential sends each get their own turn with increasing numbers', async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.string({ minLength: 1 }), { minLength: 1, maxLength: 5 }),
      async (texts) => {
        const ctx = await harness()
        try {
          const agent = ctx.agentLoop.create(SessionId('a'), { provider: 'mock', model: 'mock' })
          for (const text of texts) {
            const idle = nextIdle(ctx, agent)
            agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
            await idle
          }
          // Each send was drained at a separate turn start: N turns, 1..N.
          expect(turnNumbers(agent)).toEqual(texts.map((_, i) => i + 1))
          expect(userMessageTexts(agent)).toEqual(texts)
        } finally {
          await ctx.fiber.dispose()
        }
      },
    ), { numRuns: 20, timeout: 2000 })
  })

  it('mixed settled and same-tick sends preserve one turn per message', async () => {
    // Each step optionally waits for idle before the next send; that scheduling
    // choice must not change the ordinary message-to-turn mapping.
    const stepArb = fc.record({ text: fc.string({ minLength: 1 }), settle: fc.boolean() })
    await fc.assert(fc.asyncProperty(
      fc.array(stepArb, { minLength: 1, maxLength: 6 }),
      async (steps) => {
        const ctx = await harness()
        try {
          const agent = ctx.agentLoop.create(SessionId('a'), { provider: 'mock', model: 'mock' })
          // Capture before each send; the last waiter covers the final turn, and
          // awaiting an already-settled earlier waiter is harmless.
          let lastIdle: Promise<void> | undefined
          for (const step of steps) {
            const idle = nextIdle(ctx, agent)
            lastIdle = idle
            agent.followup(createUserMessage({ content: [{ type: 'text', text: step.text }], source: { kind: 'user' } }))
            if (step.settle) await idle
          }
          await lastIdle

          // No message is lost or reordered, regardless of driver timing.
          expect(userMessageTexts(agent)).toEqual(steps.map(s => s.text))
          // Every item forms one FIFO-ordered turn containing only that message.
          const turns = turnNumbers(agent)
          expect(turns).toEqual(steps.map((_, i) => i + 1))
          expect(turnEndNumbers(agent)).toEqual(turns)
          expect(userMessageCountsByTurn(agent)).toEqual(steps.map(() => 1))
        } finally {
          await ctx.fiber.dispose()
        }
      },
    ), { numRuns: 25, timeout: 3000 })
  })
})
