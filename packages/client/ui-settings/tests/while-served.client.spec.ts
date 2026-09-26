/** The served-namespace watch: a registration that lives exactly while the Host serves a namespace. */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { SettingsSchemaService } from '../src/client/schema.ts'
import { ConfigForms } from '../src/client/config-form.ts'
import { SettingsDescribeMirror } from '../src/client/settings-mirror.ts'

/** What the Host describes: the named namespaces, each an empty section. */
function described(namespaces: readonly string[], revision = 0) {
  return {
    ok: true as const,
    value: {
      writable: true,
      hasDocument: true,
      namespaces: namespaces.map(ns => ({ ns, schema: {}, value: {}, applies: 'live', secrets: [], revision })),
    },
  }
}

/** A binder over a scripted Host, and the plugin context that will watch through it. */
async function bench(namespaces: readonly string[]) {
  const describeCall = vi.fn().mockResolvedValue(described(namespaces))
  const ctx = new Context()
  new TestRemote(ctx, { settings: { describe: describeCall } })
  const mirror = new SettingsDescribeMirror({ remote: { settings: { describe: describeCall } } } as never)
  await ctx.plugin(ConfigForms, { mirror, schema: new SettingsSchemaService(ctx), persistence: 'host' }).await()
  return { ctx, mirror, describeCall }
}

describe('ConfigForms.whileServed', () => {
  it('registers once any watched namespace is served, and withdraws when none is', async () => {
    const { ctx, mirror, describeCall } = await bench(['agent-loop'])
    const dispose = vi.fn()
    const register = vi.fn(() => dispose)
    let off!: () => void
    const fiber = ctx.plugin({
      inject: ['configForms'],
      apply: (plugin: Context) => {
        off = plugin.configForms.whileServed(['shell', 'subagent'], register)
      },
    })
    await fiber.await()
    await mirror.ensure()
    expect(register).not.toHaveBeenCalled()

    describeCall.mockResolvedValue(described(['agent-loop', 'subagent'], 1))
    await mirror.load()
    expect(register).toHaveBeenCalledOnce()
    // Still served: a further read changes nothing.
    await mirror.load()
    expect(register).toHaveBeenCalledOnce()
    expect(dispose).not.toHaveBeenCalled()

    describeCall.mockResolvedValue(described(['agent-loop'], 2))
    await mirror.load()
    expect(dispose).toHaveBeenCalledOnce()

    describeCall.mockResolvedValue(described(['shell'], 3))
    await mirror.load()
    expect(register).toHaveBeenCalledTimes(2)

    off()
    expect(dispose).toHaveBeenCalledTimes(2)
    // Ended: the watch no longer follows the Host.
    describeCall.mockResolvedValue(described([], 4))
    await mirror.load()
    describeCall.mockResolvedValue(described(['shell'], 5))
    await mirror.load()
    expect(register).toHaveBeenCalledTimes(2)
    expect(dispose).toHaveBeenCalledTimes(2)
    await fiber.dispose()
  })

  it('registers at once for a namespace the mirror already holds, and ending the watch with nothing live is harmless', async () => {
    const { ctx, mirror } = await bench(['shell'])
    await mirror.ensure()
    const dispose = vi.fn()
    let off!: () => void
    await ctx.plugin({
      inject: ['configForms'],
      apply: (plugin: Context) => {
        off = plugin.configForms.whileServed(['shell'], () => dispose)
      },
    }).await()

    expect(dispose).not.toHaveBeenCalled()
    off()
    expect(dispose).toHaveBeenCalledOnce()
    off()
    expect(dispose).toHaveBeenCalledOnce()
  })
})
