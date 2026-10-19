/** Real Claude permission enforcement with a loopback model; no provider credentials are used. */

import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { claudeRuntime } from '@botiverse/oar/runtimes/claude'
import { expect, it } from 'vitest'
import { externalTestParent } from '../../../subagent/subagent/tests/external-activation-helpers.ts'
import { startMessagesFixture } from '../../../subagent/subagent-claude-code/tests/messages-fixture.ts'
import { startOarRun } from '../src/run.ts'

const removedEnvironment = Object.fromEntries([
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
].map(name => [name, null]))

it.skipIf(process.env.DSH_OAR_NATIVE_PERMISSIONS !== '1').for([
  { mode: 'dontAsk', writes: false },
  { mode: 'acceptEdits', writes: true },
  { mode: 'plan', writes: false },
])('enforces Claude $mode through the patched dependency', { timeout: 90_000, retry: 0 }, async ({ mode, writes }, test) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-oar-permission-'))
  const workspace = join(root, 'workspace')
  const config = join(root, 'claude-config')
  await mkdir(workspace)
  await mkdir(config)
  const marker = join(workspace, 'permission.txt')
  const content = 'OAR_NATIVE_PERMISSION_WRITE\n'
  const fixture = await startMessagesFixture({
    kind: 'tool-use', toolName: 'Write', input: { file_path: marker, content }, finalText: 'OAR_PERMISSION_DONE',
  })
  const ctx = new Context()
  test.onTestFinished(async () => {
    await ctx.fiber.dispose()
    await fixture.close()
    await rm(root, { recursive: true, force: true })
  })
  const parent = await externalTestParent(ctx, workspace)
  const run = await startOarRun({
    parent, cwd: workspace, signal: test.signal,
    prompt: [{ type: 'text', text: 'Use Write to create the permission marker, then return OAR_PERMISSION_DONE.' }],
  }, {
    runtime: claudeRuntime,
    model: 'sonnet',
    timeoutMs: 45_000,
    env: {
      ...removedEnvironment,
      ANTHROPIC_BASE_URL: fixture.baseUrl,
      ANTHROPIC_API_KEY: 'local-fixture-key',
      CLAUDE_CONFIG_DIR: config,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_TELEMETRY: '1',
    },
    launchArgs: [
      '--permission-mode', mode, '--permission-prompts', 'none',
      '--no-session-persistence', '--setting-sources', '', '--strict-mcp-config',
    ],
  })
  test.onTestFinished(() => run.dispose())
  const result = await run.result
  await run.dispose()
  expect(result.stopReason, result.diagnostic).toBe('completed')
  expect(result.output).toEqual([{ type: 'text', text: 'OAR_PERMISSION_DONE' }])
  expect(fixture.requests.length).toBeGreaterThanOrEqual(2)
  if (writes) expect(await readFile(marker, 'utf8')).toBe(content)
  else await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  const messages = fixture.requests.at(-1)?.body.messages as { content?: { type?: string; is_error?: boolean }[] | string }[]
  const toolResults = messages.flatMap(message => Array.isArray(message.content)
    ? message.content.filter(block => block.type === 'tool_result')
    : [])
  expect(toolResults).toHaveLength(1)
  expect(toolResults[0]?.is_error === true).toBe(!writes)
})
