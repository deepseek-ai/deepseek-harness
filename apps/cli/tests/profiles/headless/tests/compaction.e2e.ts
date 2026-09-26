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
    // An older file result must exceed the framed checkpoint's fixed sections.
    for (let i = 1; i <= 4; i++) {
      await writeFile(join(workdir, `file${i}.txt`), `This is file number ${i}. `.repeat(200))
    }

    // Reasoning tokens require a larger generation cap than the retained checkpoint.
    ctx = await codingHarness(workdir, {
      personaPrefix: SYSTEM_PROMPT,
      // The explicit output cap leaves an 8,000-token message budget.
      modelContextWindow: 15_000,
      modelMaxTokens: 7_000,
      compact: {
        thresholdRatio: 0.5,
        headroomTokens: 4_000,
        retainTokens: 400,
        summarizationProvider: '',
        summarizationModel: '',
        maxTokens: 1024,
        compactionRetries: 1,
      },
      persistenceRoot: join(workdir, '.sessions'),
    })
    const agent = await ctx.agentLoop.create(SessionId('e2e-compaction'), { provider: 'deepseek-official', model: 'deepseek-v4-flash' })

    // Completed read turns cannot collapse into one retained parallel tool group.
    for (let i = 1; i <= 4; i++) {
      agent.followup(createUserMessage({
        content: [{
          type: 'text',
          text: `Read only file${i}.txt using one bash cat command. Remember its number for my next question.`,
        }], source: { kind: 'user' } }))
      await waitForIdle(ctx, agent)
    }

    agent.followup(createUserMessage({
      content: [{
        type: 'text',
        text: 'How many files have you read, and what number was mentioned in file1.txt? Do not read them again.',
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
    expect(summaries.length, JSON.stringify(ends.map(event => event.data.error))).toBeGreaterThan(0)
    const replaceNode = events.find((e) => {
      const se = e as { type: string; surfaceOp?: unknown }
      return se.type === 'user/message' && typeof se.surfaceOp === 'object' && se.surfaceOp !== null
    })
    expect(replaceNode).toBeDefined()

    // The summary shadowed real older nodes (the surface shrank vs. the raw
    // message-producing event count).
    const summaryData = summaries[0]!.data as { shadowedSeqs: number[] }
    expect(summaryData.shadowedSeqs.length).toBeGreaterThan(0)
    expect(events.some(event => event.type === 'tool/result'
      && summaryData.shadowedSeqs.includes(event.seq)
      && event.data.message.content.some(block => block.type === 'text'
        && block.text.includes('This is file number')))).toBe(true)

    // The conversation survived compaction: the agent produced a final answer
    // that reflects the work (it read four files).
    const answer = finalText(events).toLowerCase()
    expect(answer.length).toBeGreaterThan(0)
    expect(answer).toMatch(/\b(4|four)\b/)
    expect(answer).toMatch(/\b(1|one)\b/)
  }, 240_000)
})
