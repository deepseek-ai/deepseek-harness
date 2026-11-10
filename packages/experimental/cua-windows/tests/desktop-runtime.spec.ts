/** Opt-in real desktop admission through the shipped managed subprocess provider. */
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { NativeClient } from '@deepseek-ai/dsh-cua/native-client'
import { expect, it, onTestFinished } from 'vitest'
import { Config } from '../src/index.ts'
import { WindowsNativeRuntime } from '../src/native-runtime.ts'

const helperPath = process.env.DSH_CUA_DESKTOP_TEST_HELPER
it.skipIf(!helperPath)('admits Windows desktop requests through managed WSL or native Windows processes', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LocalSubprocessRuntime)
  const runtime = new WindowsNativeRuntime(ctx, 25, process.platform === 'win32' ? 'pipe' : 'stdio')
  onTestFinished(() => runtime.dispose())
  const client = new NativeClient(ctx, { ...Config({}), helperPath: helperPath!, cwd: process.cwd() },
    (_owner, config) => runtime.connect(config))
  onTestFinished(() => client.dispose())
  const capabilities = await client.request('getCapabilities', {}, new AbortController().signal)
  expect(capabilities).toHaveProperty('permissions.accessibility', expect.any(Boolean))
  expect(capabilities).toHaveProperty('permissions.screenRecording', expect.any(Boolean))
}, 60_000)
