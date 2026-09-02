import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { spawnHarness, waitForIdle } from './harness.ts'
import { SessionId } from '@deepseek-ai/dsh-session'

/** Key-gated smoke for a real parent delegating filesystem work to a real child. */

let ctx: Context | undefined
let workdir: string | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (workdir !== undefined) await rm(workdir, { recursive: true, force: true })
  workdir = undefined
})

describe.skipIf(!process.env.DEEPSEEK_API_KEY)('spawn backend with-key smoke', () => {
  it('a parent delegates to a child that writes a file on disk', async () => {
    workdir = await mkdtemp(join(tmpdir(), 'dsh-subagent-spawn-e2e-'))
    ctx = await spawnHarness(workdir)
    const parent = await ctx.agentLoop.create(SessionId('e2e-parent'), { provider: 'deepseek-official', model: 'deepseek-v4-flash' })

    parent.followup(createUserMessage({
      content: [{ type: 'text', text:
      'Use the subagent tool to delegate this exact task: "Use the bash tool to write the text '
      + 'SUBAGENT_WAS_HERE into a file named proof.txt in the current directory." '
      + 'After the subagent finishes, tell me it is done.' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, parent)

    // Assert the filesystem effect independently of the model response.
    const proof = await readFile(join(workdir, 'proof.txt'), 'utf8')
    expect(proof).toContain('SUBAGENT_WAS_HERE')

    // The parent's log records the subagent tool/call + its result (not the
    // child's internal steps).
    const events = parent.session.snapshotEvents()
    const subagentCalls = events.filter(e => e.type === 'tool/call' && e.data.name === 'subagent')
    expect(subagentCalls.length).toBeGreaterThan(0)
  }, 180_000)
})
