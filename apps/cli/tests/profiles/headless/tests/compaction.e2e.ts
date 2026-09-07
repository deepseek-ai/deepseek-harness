import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { codingHarness, finalText, SYSTEM_PROMPT, waitForIdle } from './harness.ts'
import { SessionId } from '@deepseek-ai/dsh-session'

/**
 * Key-gated smoke for mid-session compaction. It verifies the compact event
 * pair, replacement of older surface nodes, and a final answer after compaction.
 */
// The keyless headless snapshot pins deterministic overflow recovery; this test
// remains the independent live-provider smoke for organic pressure and summary quality.

let workdir: string | undefined
let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (workdir !== undefined) await rm(workdir, { recursive: true, force: true })
  workdir = undefined
})

describe.skipIf(!process.env.DEEPSEEK_API_KEY)('compaction: a long session compacts mid-flight and keeps running', () => {
  it('summarizes older history into a checkpoint without breaking the task', async () => {
    workdir = await mkdtemp(join(tmpdir(), 'dsh-compaction-'))
    for (let i = 1; i <= 4; i++) {
      await writeFile(join(workdir, `file${i}.txt`), `This is file number ${i}. `.repeat(50))
    }

    // Reasoning tokens require a larger generation cap than the retained checkpoint.
    ctx = await codingHarness(workdir, {
      personaPrefix: SYSTEM_PROMPT,
      modelContextWindow: 2000,
      compact: {
        thresholdRatio: 0.5,
        retainTokens: 400,
        summarizationProvider: '',
        summarizationModel: '',
        maxTokens: 1024,
        compactionRetries: 1,
      },
      persistenceRoot: join(workdir, '.sessions'),
    })
    const agent = await ctx.agentLoop.create(SessionId('e2e-compaction'), { provider: 'deepseek-official', model: 'deepseek-v4-flash' })

    agent.followup(createUserMessage({
      content: [{
        type: 'text',
        text: 'Read file1.txt, file2.txt, file3.txt, and file4.txt one at a '
        + 'time using cat (a separate bash command for each). After reading all four, tell me how '
        + 'many files you read and the number mentioned in file1.txt.',
      }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const events = agent.session.snapshotEvents()

    // A compaction ran: the start…end bracket landed in the real log.
    const starts = events.filter(e => e.type === 'compaction/start')
    const ends = events.filter(e => e.type === 'compaction/end')
    expect(starts.length).toBeGreaterThan(0)
    expect(ends.length).toBe(starts.length) // every start was released

    // It succeeded at least once: a `compaction/summary` event describing the summary and a
    // replace-op user/message (the surface mutation) both landed.
    const summaries = events.filter(e => e.type === 'compaction/summary')
    expect(summaries.length).toBeGreaterThan(0)
    const replaceNode = events.find((e) => {
      const se = e as unknown as { type: string; surfaceOp?: unknown }
      return se.type === 'user/message' && typeof se.surfaceOp === 'object' && se.surfaceOp !== null
    })
    expect(replaceNode).toBeDefined()

    // The summary shadowed real older nodes (the surface shrank vs. the raw
    // message-producing event count).
    const summaryData = summaries[0]!.data as { shadowedSeqs: number[] }
    expect(summaryData.shadowedSeqs.length).toBeGreaterThan(0)

    // The conversation survived compaction: the agent produced a final answer
    // that reflects the work (it read four files).
    const answer = finalText(events).toLowerCase()
    expect(answer.length).toBeGreaterThan(0)
    expect(answer).toMatch(/\b(4|four)\b/)
  }, 240_000)
})
