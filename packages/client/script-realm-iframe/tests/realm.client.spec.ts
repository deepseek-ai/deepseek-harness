// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import ScriptRealmRegistry, { type ScriptRealmId } from '@deepseek-ai/dsh-client-script-realm/client'
import * as IFrame from '../src/client/index.ts'
import { apply as hostApply } from '../src/index.ts'

it('registers the optional provider without allocating a frame and keeps instances caller-owned', async () => {
  expect(() => { hostApply() }).not.toThrow()
  const ctx = new Context()
  await ctx.plugin(ScriptRealmRegistry).await()
  const provider = ctx.plugin(IFrame)
  await provider.await()
  expect(document.querySelector('iframe[data-realm]')).toBeNull()
  const controller = new AbortController()
  const realm = await ctx.get('scriptRealms')!.create('iframe', { id: 'optional' as ScriptRealmId, signal: controller.signal })
  try {
    const frame = document.querySelector<HTMLIFrameElement>('iframe[data-realm="optional"]')!
    expect(frame).not.toBeNull()
    const shared = { marker: true }
    await realm.expose({ __sharedRealmProbe: shared })
    expect(Reflect.get(frame.contentWindow!, '__sharedRealmProbe')).toBe(shared)
    await provider.dispose()
    expect(frame.isConnected).toBe(true)
    await expect(ctx.get('scriptRealms')!.create('iframe', { id: realm.id, signal: controller.signal })).rejects.toThrow('not registered')
    await realm.dispose()
    expect(frame.isConnected).toBe(false)
  } finally {
    controller.abort()
    await realm.dispose()
    await ctx.fiber.dispose()
  }
})
