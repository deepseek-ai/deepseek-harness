/** Live executor configuration through Loader updates. */
import { expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { PwshLocalExecutor } from '../src/index.ts'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'

it('uses changed budgets for later commands without remounting the executor', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LocalSubprocessRuntime)
  const live = await liveConfig(ctx, PwshLocalExecutor, { timeoutMs: 60_000 })
  const before = live.fiber
  await live.update({ timeoutMs: 5_000, maxOutputBytes: 1_024 })
  expect(live.entry.fiber === before).toBe(true)
  expect(ctx.shell.resolve({ command: 'echo ok' })).toMatchObject({ timeoutMs: 5_000, stdoutMaxBytes: 1_024 })
  // A stored budget the executor cannot use fails the next command, not the profile write.
  await live.update({ timeoutMs: 0 })
  expect(() => ctx.shell.resolve({ command: 'echo ok' })).toThrow('timeoutMs must be a positive finite number')
  await live.update({ timeoutMs: 5_000, graceMs: Number.MAX_SAFE_INTEGER })
  expect(() => ctx.shell.resolve({ command: 'echo ok' })).toThrow('graceMs must be no greater')
  await live.update({ graceMs: 200 })
  expect(ctx.shell.resolve({ command: 'echo ok' }).timeoutMs).toBe(5_000)
  await live.replace({})
  expect(ctx.shell.resolve({ command: 'echo ok' }).timeoutMs).toBe(120_000)
})

it('resolves a changed pwsh path for later commands without remounting the executor', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LocalSubprocessRuntime)
  const live = await liveConfig(ctx, PwshLocalExecutor, {})
  const executor = ctx.shell as PwshLocalExecutor
  const before = live.fiber
  const initial = executor.pwshPath
  await live.update({ pwshPath: '/opt/pwsh/pwsh' })
  expect(live.entry.fiber === before).toBe(true)
  expect(executor.pwshPath).toBe('/opt/pwsh/pwsh')
  await live.replace({})
  expect(executor.pwshPath).toBe(initial)
})
