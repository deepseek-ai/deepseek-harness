import { mountWorkingDirectoryFixture } from '../../subagent/tests/working-directory-fixture.ts'
import { startExternalActivation } from '../../subagent/tests/external-activation-helpers.ts'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'
import * as acp from '../src/index.ts'

/**
 * With-key cross-process boundary proof: the backend spawns the real dsh ACP profile, speaks ACP over
 * stdio, and returns its real model answer. This is the out-of-process counterpart to in-process
 * spawn coverage and self-skips without `DEEPSEEK_API_KEY`.
 */

// The real ACP profile: dsh plus the example's live DeepSeek patch.
const binScript = fileURLToPath(new URL('../../../../apps/cli/src/bin.ts', import.meta.url))
const exampleConfig = fileURLToPath(new URL('../../../../snapshots/acp/escalation-approved/cordis.yml', import.meta.url))
const transportPatch = fileURLToPath(new URL('./fixtures/acp-transport.patch.yml', import.meta.url))
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

// How to launch the child ACP profile (src via tsx / lib via plain node, per DSH_EXAMPLE_MODE).
// The subprocess seam scrubs ambient creds while spec.env merges after it, so the model key is
// forwarded explicitly; TSX_TSCONFIG_PATH is added by the resolver in src mode only.
function resolveChildLaunch(dshHome: string) {
  return resolveExampleLaunch({
    srcBin: binScript,
    sourceImport: 'tsx/esm',
    configArgs: ['--profile', 'acp', '--patch', exampleConfig, '--patch', transportPatch],
    tsconfigPath: repoTsconfig,
    env: {
      ...process.env.DEEPSEEK_API_KEY !== undefined ? { DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY } : {},
      ...process.env.DEEPSEEK_BASE_URL !== undefined ? { DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL } : {},
      DSH_HOME: dshHome,
      DSH_PERMISSION_MODE: 'danger-full-access',
    },
  })
}

/** The ACP backend ignores the parent, but the seam requires one. */
const fakeParent = { id: 'parent', session: { header: {} } } as unknown as Agent

let ctx: Context | undefined
let workdir: string | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (workdir !== undefined) await rm(workdir, { recursive: true, force: true })
  workdir = undefined
})

describe.skipIf(!process.env.DEEPSEEK_API_KEY)('ACP backend with-key e2e (drive our own acp-agent)', () => {
  it('drives the real acp-agent example process to answer a prompt', async () => {
    workdir = await mkdtemp(join(tmpdir(), 'dsh-subagent-acp-e2e-'))
    const childLaunch = resolveChildLaunch(join(workdir, '.dsh-child'))
    ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await mountWorkingDirectoryFixture(ctx)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(acp, {
      providerName: 'acp',
      command: childLaunch.command,
      args: childLaunch.args,
      permission: 'reject',
      env: childLaunch.env as Record<string, string>,
    })

    const run = await startExternalActivation(ctx, 'acp', {
      cwd: workdir,
      prompt: [{ type: 'text', text: 'Reply with exactly the word PONG and nothing else. Do not use any tools.' }],
      parent: fakeParent,
      signal: new AbortController().signal,
    })
    const result = await run.result
    await run.dispose()

    // The real child process completed its turn and streamed a real answer back
    // across the ACP boundary.
    expect(result.stopReason).toBe('completed')
    const text = result.output.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('')
    expect(text.length).toBeGreaterThan(0)
    expect(text.toUpperCase()).toContain('PONG')
  }, 180_000)

  it('drives the child to do real file work via its own bash tool', async () => {
    workdir = await mkdtemp(join(tmpdir(), 'dsh-subagent-acp-e2e-'))
    const childLaunch = resolveChildLaunch(join(workdir, '.dsh-child'))
    ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await mountWorkingDirectoryFixture(ctx)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(acp, {
      providerName: 'acp',
      command: childLaunch.command,
      args: childLaunch.args,
      // The child needs to act (run bash), so approve its permission prompts.
      permission: 'allow',
      env: childLaunch.env as Record<string, string>,
    })

    const run = await startExternalActivation(ctx, 'acp', {
      cwd: workdir,
      prompt: [{ type: 'text', text:
        'Use the bash tool to write the text ACP_CHILD_WAS_HERE into a file named proof.txt '
        + 'in the current directory. Then reply DONE.' }],
      parent: fakeParent,
      signal: new AbortController().signal,
    })
    const result = await run.result
    await run.dispose()

    expect(result.stopReason).toBe('completed')
    // Assert the filesystem effect independently of the model response.
    const proof = await readFile(join(workdir, 'proof.txt'), 'utf8')
    expect(proof).toContain('ACP_CHILD_WAS_HERE')
  }, 180_000)
})
