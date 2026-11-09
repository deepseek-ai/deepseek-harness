/** Provider configuration reaches the native transport without opening a macOS connection. */
import { resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { installCua } from '@deepseek-ai/dsh-cua'
import type { NativeChannel } from '@deepseek-ai/dsh-cua/native-client'
import { expect, it, onTestFinished, vi } from 'vitest'
import { apply, Config } from '../src/index.ts'
import { createSharedNativeChannel } from '../src/shared-native.ts'

vi.mock('@deepseek-ai/dsh-cua', async importOriginal => ({
  ...await importOriginal<typeof import('@deepseek-ai/dsh-cua')>(),
  installCua: vi.fn(),
}))
vi.mock('../src/shared-native.ts', () => ({ createSharedNativeChannel: vi.fn() }))

it.each([false, true])('forwards systemPointerHover=%s and native limits to each channel', async (systemPointerHover) => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const config = Config({ helperPath: resolve('fixture-helper'), systemPointerHover })
  const channel: NativeChannel = {
    stdin: new PassThrough(), stdout: new PassThrough(), done: Promise.resolve(),
    close() {}, waitForClose: async () => {},
  }
  onTestFinished(() => { channel.stdin.destroy(); channel.stdout.destroy() })
  vi.mocked(installCua).mockClear()
  vi.mocked(createSharedNativeChannel).mockReset().mockReturnValue(channel)

  await apply(ctx, config)
  expect(installCua).toHaveBeenCalledTimes(1)
  const backend = vi.mocked(installCua).mock.calls[0]![2]
  const owner = { subprocess: { spawn: vi.fn() } }
  const native = { ...config, helperPath: resolve('fixture-helper'), cwd: process.cwd() }
  expect(backend.createChannel(owner, native)).toBe(channel)
  expect(createSharedNativeChannel).toHaveBeenCalledExactlyOnceWith(owner, native, systemPointerHover)
})
