/** Opt-in real desktop admission through the shipped managed subprocess provider. */
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { NativeClient } from '@deepseek-ai/dsh-cua/native-client'
import { expect, it, onTestFinished } from 'vitest'
import { Config } from '../src/index.ts'
import { WindowsNativeRuntime } from '../src/native-runtime.ts'

const helperPath = process.env.DSH_CUA_DESKTOP_TEST_HELPER

async function connect(): Promise<NativeClient> {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LocalSubprocessRuntime)
  const runtime = new WindowsNativeRuntime(ctx, 25, 1000, process.platform === 'win32' ? 'pipe' : 'stdio')
  onTestFinished(() => runtime.dispose())
  const client = new NativeClient(ctx, { ...Config({}), helperPath: helperPath!, cwd: process.cwd() },
    (_owner, config) => runtime.connect(config))
  onTestFinished(() => client.dispose())
  return client
}

it.skipIf(!helperPath)('admits Windows desktop requests through managed WSL or native Windows processes', async () => {
  const client = await connect()
  const capabilities = await client.request('getCapabilities', {}, new AbortController().signal)
  expect(capabilities).toHaveProperty('permissions.accessibility', expect.any(Boolean))
  expect(capabilities).toHaveProperty('permissions.screenRecording', expect.any(Boolean))
}, 60_000)

it.skipIf(!helperPath)('describes one action argument without an application or window', async () => {
  const client = await connect()
  const signal = new AbortController().signal
  expect(await client.request('getActionSchema', { action: 'Invoke.Invoke' }, signal)).toEqual({
    type: 'object', properties: { argument: { type: 'null' } }, required: [], additionalProperties: false,
  })
  expect(await client.request('getActionSchema', { action: 'Window.SetWindowVisualState' }, signal)).toEqual({
    type: 'object',
    properties: { argument: { type: 'string', description: 'Accepted values: Normal, Maximized, Minimized (case-sensitive).' } },
    required: ['argument'], additionalProperties: false,
  })
  expect(await client.request('getActionSchema', { action: 'Transform.Resize' }, signal)).toEqual({
    type: 'object',
    properties: { argument: {
      type: 'object',
      properties: {
        width: { type: 'number', description: 'Pixel dimension; must be positive.' },
        height: { type: 'number', description: 'Pixel dimension; must be positive.' },
      },
      required: ['width', 'height'], additionalProperties: false,
    } },
    required: ['argument'], additionalProperties: false,
  })
  expect(await client.request('getActionSchema', { action: 'MultipleView.SetCurrentView' }, signal)).toEqual({
    type: 'object',
    properties: { argument: { type: 'number', description: 'A 32-bit integer element view ID.' } },
    required: ['argument'], additionalProperties: false,
  })
  expect(await client.request('getActionSchema', { action: 'Scroll.SetScrollPercent' }, signal)).toEqual({
    type: 'object',
    properties: { argument: {
      type: 'object',
      properties: {
        horizontalPercent: { type: 'number', description: 'Scroll percentage from 0 to 100, or -1 (NoScroll) to leave the axis unchanged.' },
        verticalPercent: { type: 'number', description: 'Scroll percentage from 0 to 100, or -1 (NoScroll) to leave the axis unchanged.' },
      },
      required: ['horizontalPercent', 'verticalPercent'], additionalProperties: false,
    } },
    required: ['argument'], additionalProperties: false,
  })
  await expect(client.request('getActionSchema', { action: 'Missing.Action' }, signal))
    .rejects.toMatchObject({ code: 'UNSUPPORTED' })
}, 60_000)
