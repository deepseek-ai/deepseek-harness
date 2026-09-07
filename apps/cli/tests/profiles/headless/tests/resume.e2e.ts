import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { codingHarness, finalText, SYSTEM_PROMPT, waitForIdle } from './harness.ts'

/**
 * Proves durable conversation continuity end-to-end: run 1 tells the REAL model
 * a fact and persists the turn to JSONL; run 2 is a fresh harness (new Context,
 * same `.sessions` root) that RESUMES the persisted session id and asks the
 * model to recall the fact. The recall can only come from the rehydrated event
 * log — a fresh session would have no idea. Key-gated like the other e2es.
 */

const SECRET = 'plum-galaxy-1791'
const SESSION_ID = SessionId('resume-e2e-session')

let ctx: Context | undefined
let root: string | undefined

afterEach(async () => {
  // Dispose even on failure/retry: agent-loop teardown stops the loop and the
  // JSONL backend flushes; then drop the on-disk session log.
  await ctx?.fiber.dispose()
  ctx = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe.skipIf(!process.env.DEEPSEEK_API_KEY)('resume: continue a persisted session across processes', () => {
  it('recalls a fact stored in a prior, separately-disposed session', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-resume-e2e-'))

    // Run 1: a fresh agent on a KNOWN session id learns a secret, then we
    // dispose the whole context (simulating process exit) so only the JSONL
    // log on disk survives.
    ctx = await codingHarness(process.cwd(), { personaPrefix: SYSTEM_PROMPT, persistenceRoot: root })
    const first = (await ctx.agents.create({
      sessionId: SESSION_ID,
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    })).agent
    first.followup(createUserMessage({ content: [{ type: 'text', text: `Remember this code for later: ${SECRET}. Just acknowledge it.` }], source: { kind: 'user' } }))
    await waitForIdle(ctx, first)
    await ctx.fiber.dispose()
    ctx = undefined

    // Run 2: a brand-new context over the SAME root resumes the persisted
    // session. The loaded event log seeds the live session, so the model sees
    // run 1's exchange as conversation history.
    ctx = await codingHarness(process.cwd(), { personaPrefix: SYSTEM_PROMPT, persistenceRoot: root })
    const resumed = (await ctx.agents.resume({
      resumeSessionId: SESSION_ID,
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    })).agent
    expect(resumed.session.id).toBe(SESSION_ID)
    // The prior user turn is in the rehydrated log before the model is asked.
    expect(JSON.stringify(resumed.session.deriveMessages())).toContain(SECRET)

    resumed.followup(createUserMessage({ content: [{ type: 'text', text: 'What was the code I asked you to remember? Reply with just the code.' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, resumed)

    // The model recalls it — only possible from the resumed history.
    expect(finalText(resumed.session.snapshotEvents())).toContain(SECRET)
  }, 180_000)
})
