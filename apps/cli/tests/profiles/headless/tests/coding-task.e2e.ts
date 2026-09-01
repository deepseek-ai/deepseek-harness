import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { codingHarness, finalText, SYSTEM_PROMPT, waitForIdle } from './harness.ts'
import { SessionId } from '@deepseek-ai/dsh-session'

/**
 * The swebench-style smoke test: a real model fixes a real bug in a temp
 * directory using only the bash tool, and the fix is verified OUTSIDE the
 * agent by re-running the test script. Key-gated.
 */

const TEST_FILE = [
  "const assert = require('node:assert');",
  "const { add } = require('./add.js');",
  'assert.strictEqual(add(2, 3), 5);',
  'assert.strictEqual(add(-1, 1), 0);',
  "console.log('PASS');",
  '',
].join('\n')

const BUGGY_ADD = [
  '// A tiny module with an obvious bug.',
  'function add(a, b) {',
  '  return a - b;',
  '}',
  'module.exports = { add };',
  '',
].join('\n')

let workdir: string | undefined
let ctx: Context | undefined

afterEach(async () => {
  // Dispose the harness even on failure/retry: agent-loop teardown stops the
  // loop and LocalBashExecutor teardown kills anything the model left running.
  await ctx?.fiber.dispose()
  ctx = undefined
  if (workdir !== undefined) await rm(workdir, { recursive: true, force: true })
  workdir = undefined
})

describe.skipIf(!process.env.DEEPSEEK_API_KEY)('coding task: fix a failing test via bash', () => {
  it('repairs add.js so node add.test.js passes', async () => {
    workdir = await mkdtemp(join(tmpdir(), 'dsh-coding-task-'))
    await writeFile(join(workdir, 'add.js'), BUGGY_ADD)
    await writeFile(join(workdir, 'add.test.js'), TEST_FILE)

    // Confirm the fixture actually fails before the agent touches it.
    const before = spawnSync('node', ['add.test.js'], { cwd: workdir })
    expect(before.status).not.toBe(0)

    ctx = await codingHarness(workdir, { persona: SYSTEM_PROMPT })
    const agent = ctx.agentLoop.create(SessionId('e2e-task'), { provider: 'deepseek-official', model: 'deepseek-v4-flash' })

    agent.followup(createUserMessage({
      content: [{
        type: 'text',
        text: 'In the current directory, `node add.test.js` fails because add.js has a bug. '
        + 'Fix add.js so the test passes, run `node add.test.js` to verify, and report the result. '
        + 'Do not modify add.test.js.',
      }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    // The agent claims success…
    const summary = finalText(agent.session.snapshotEvents()).toLowerCase()
    expect(summary.length).toBeGreaterThan(0)

    // …and the world agrees: the test passes when WE run it, and the test
    // file is byte-identical (an agent that neutered the test instead of
    // fixing the bug fails here, not just on a keyword probe).
    const untouchedTest = await readFile(join(workdir, 'add.test.js'), 'utf8')
    expect(untouchedTest).toBe(TEST_FILE)

    const after = spawnSync('node', ['add.test.js'], { cwd: workdir, encoding: 'utf8' })
    expect(after.stdout).toContain('PASS')
    expect(after.status).toBe(0)

    const fixed = await readFile(join(workdir, 'add.js'), 'utf8')
    expect(fixed).not.toMatch(/a\s*-\s*b/)
  }, 180_000)
})
