import { Context } from '@deepseek-ai/cordis'
import type { BundleInfo } from '@deepseek-ai/dsh-api-remotes/client'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { expect, it, onTestFinished, vi } from 'vitest'
import { ConnectorsController } from '../src/client/connectors-store.ts'

type ListAnswer = { ok: true; value: BundleInfo[] } | { ok: false; error: { code: string; message: string } }

function bundle(name: string, installed: boolean, enabled: boolean): BundleInfo {
  return {
    name, official: false, availability: installed ? 'profile' : 'missing', enabled, installed,
    optional: false, removable: true, rows: [], overrides: [],
  }
}

function bench(...answers: Array<Promise<ListAnswer>>) {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const listBundles = vi.fn<() => Promise<ListAnswer>>()
  for (const answer of answers) listBundles.mockReturnValueOnce(answer)
  new TestRemote(ctx, { pluginManager: { listBundles } })
  const controller = new ConnectorsController(ctx)
  return { controller, face: controller.face('1.2.3'), listBundles }
}

const FAILED: ListAnswer = { ok: false, error: { code: 'plugin-manager/failed', message: 'failed' } }

it('reads each connector as missing, installed, or on, once, and only after the tab first asks', async () => {
  const { controller, face, listBundles } = bench(Promise.resolve({ ok: true, value: [
    bundle('@deepseek-ai/dsh-notion', true, true), bundle('@deepseek-ai/dsh-tencent-docs', true, false),
    bundle('dsh-unrelated', true, true),
  ] }))
  expect(face.version).toBe('1.2.3')
  controller.changed()
  expect(listBundles).not.toHaveBeenCalled()
  face.ensure()
  expect(face.hooks.connectors.getSnapshot().status).toBe('loading')
  face.ensure()
  await vi.waitFor(() => { expect(face.hooks.connectors.getSnapshot().status).toBe('ready') })
  expect(listBundles).toHaveBeenCalledOnce()
  expect(face.hooks.connectors.getSnapshot().connectors).toEqual({
    '@deepseek-ai/dsh-feishu': 'missing', '@deepseek-ai/dsh-wecom': 'missing', '@deepseek-ai/dsh-tencent-meeting': 'missing',
    '@deepseek-ai/dsh-notion': 'enabled', '@deepseek-ai/dsh-tencent-docs': 'installed', '@deepseek-ai/dsh-linear': 'missing',
  })
  face.ensure()
  expect(listBundles).toHaveBeenCalledOnce()
})

it('reports a failed read, keeps a ready list visible while it reads again, and recovers on retry', async () => {
  const { controller, face } = bench(Promise.resolve(FAILED), Promise.resolve({ ok: true, value: [] }), Promise.resolve(FAILED))
  face.ensure()
  await vi.waitFor(() => { expect(face.hooks.connectors.getSnapshot().status).toBe('error') })
  face.retry()
  expect(face.hooks.connectors.getSnapshot().status).toBe('loading')
  await vi.waitFor(() => { expect(face.hooks.connectors.getSnapshot().status).toBe('ready') })
  controller.changed()
  expect(face.hooks.connectors.getSnapshot().status).toBe('ready')
  await vi.waitFor(() => { expect(face.hooks.connectors.getSnapshot().status).toBe('error') })
})

it('keeps only the latest read and publishes nothing after disposal', async () => {
  const first = Promise.withResolvers<ListAnswer>()
  const second = Promise.withResolvers<ListAnswer>()
  const third = Promise.withResolvers<ListAnswer>()
  const { controller, face } = bench(first.promise, second.promise, third.promise)
  face.ensure()
  face.retry()
  second.resolve({ ok: true, value: [bundle('@deepseek-ai/dsh-notion', true, false)] })
  await vi.waitFor(() => { expect(face.hooks.connectors.getSnapshot().status).toBe('ready') })
  first.resolve({ ok: true, value: [bundle('@deepseek-ai/dsh-notion', true, true)] })
  await first.promise
  expect(face.hooks.connectors.getSnapshot().connectors['@deepseek-ai/dsh-notion']).toBe('installed')
  face.retry()
  controller.dispose()
  third.resolve(FAILED)
  await third.promise
  expect(face.hooks.connectors.getSnapshot().status).toBe('ready')
})
