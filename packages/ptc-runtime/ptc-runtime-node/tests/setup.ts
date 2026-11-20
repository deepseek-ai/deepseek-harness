import { Context } from '@deepseek-ai/cordis'
import { onTestFinished } from 'vitest'
import SessionStore from '@deepseek-ai/dsh-session'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import NodeRuntime from '../src/index.ts'
import type { Config } from '../src/index.ts'

type Policy = { mode?: SandboxMode; workspaceRoot?: string }

/** Mount the provider with its exact configuration, without the per-call default that `mountRuntime` adds. */
export async function mountConfiguredRuntime(ctx: Context, config: Config, policy: Policy = {}) {
  onTestFinished(async () => { await ctx.fiber.dispose() })
  if (!ctx.get('sessions')) await ctx.plugin(SessionStore)
  if (!ctx.get('fs')) await ctx.plugin(FileSystem)
  if (!ctx.get('subprocess')) await ctx.plugin(Subprocess)
  if (!ctx.get('sandbox')) await ctx.plugin(Sandbox, {})
  if (!ctx.get('sessionProjections')) await ctx.plugin(SessionProjections)
  if (!ctx.get('sandboxPolicy')) await ctx.plugin(SandboxPolicy, { mode: 'danger-full-access', ...policy })
  const fiber = await ctx.plugin(NodeRuntime, config)
  return { runtime: ctx.ptcRuntime as NodeRuntime, fiber }
}

/** Mount the provider; suites exercise function bodies unless the configuration names an execution mode. */
export async function mountRuntime(ctx: Context, config: Config = {}, policy: Policy = {}) {
  return mountConfiguredRuntime(ctx, { executionMode: 'per-call', ...config }, policy)
}
