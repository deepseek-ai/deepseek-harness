/** The service's Plugins page is the Forge panel's row page, not a generated Settings page. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, it } from 'vitest'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import WorkingDirectoryService from '@deepseek-ai/dsh-working-directory'
import { omitsGeneratedPage } from '../../../settings/settings/tests/live-config.ts'
import WorktreeService from '../src/index.ts'
import { UnusedSandbox } from './harness.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

it('keeps its own instance off the generated Settings pages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-worktree-settings-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  await omitsGeneratedPage(async (ctx) => {
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(LocalFileSystem, { cwd: root })
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(UnusedSandbox)
    await ctx.plugin(SandboxPolicyService, { mode: 'danger-full-access', workspaceRoot: root })
    await ctx.plugin(WorkingDirectoryService)
    return ctx.plugin(WorktreeService)
  })
})
