import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { codingHarness, finalText, SYSTEM_PROMPT, waitForIdle } from './harness.ts'
import { SessionId } from '@deepseek-ai/dsh-session'

/**
 * The first place a REAL model meets the REAL bash tool: the cheap canary
 * before the coding-task e2e. Key-gated (see vitest.e2e.config.ts).
 */

let ctx: Context | undefined
let workdir: string | undefined

afterEach(async () => {
  // Always dispose the harness, even on failure/retry/timeout: agent-loop
  // teardown stops the loop and LocalBashExecutor teardown kills any
  // process the model left behind.
  await ctx?.fiber.dispose()
  ctx = undefined
  if (workdir !== undefined) await rm(workdir, { recursive: true, force: true })
  workdir = undefined
})

describe.skipIf(!process.env.DEEPSEEK_API_KEY)('full loop: real model + real bash tool', () => {
  it('runs a bash command on request and reports its output', async () => {
    workdir = await mkdtemp(join(tmpdir(), 'dsh-full-loop-e2e-'))
    ctx = await codingHarness(workdir, { persona: SYSTEM_PROMPT })
    const agent = await ctx.agentLoop.create(SessionId('e2e-loop'), { provider: 'deepseek-official', model: 'deepseek-v4-flash' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Run `echo e2e-ok` with the bash tool and tell me its exact output.' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const events = agent.session.snapshotEvents()
    const calls = events.filter(event => event.type === 'tool/call')
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.some(event => event.data.name === 'bash')).toBe(true)

    const results = events.filter(event => event.type === 'tool/result')
    const resultTexts = results.flatMap(event =>
      event.data.message.content[0].content.filter(block => block.type === 'text').map(block => block.text))
    expect(resultTexts.some(text => text.includes('e2e-ok'))).toBe(true)

    expect(finalText(events)).toContain('e2e-ok')
  }, 120_000)
})
