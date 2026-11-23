import { Context } from '@deepseek-ai/cordis'
import type { BundleInfo, ChangeResult } from '@deepseek-ai/dsh-api-remotes/client'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { expect, it, onTestFinished, vi } from 'vitest'
import { ConnectorsController } from '../src/client/connectors-store.ts'

type Refused = { ok: false; error: { code: string; message: string } }
type ListAnswer = { ok: true; value: BundleInfo[] } | Refused
type SwitchAnswer = { ok: true; value: ChangeResult } | Refused

const NOTION = '@deepseek-ai/dsh-notion'
const TENCENT_DOCS = '@deepseek-ai/dsh-tencent-docs'

function bundle(name: string, installed: boolean, enabled: boolean): BundleInfo {
  return {
    name, official: false, availability: installed ? 'profile' : 'missing', enabled, installed,
    optional: false, removable: true, rows: [], overrides: [],
  }
}

function switched(target: string, application: ChangeResult['application']): SwitchAnswer {
  return { ok: true, value: { changed: application === 'applied', application, stage: 'enable', target } }
}

function bench(...answers: Array<Promise<ListAnswer>>) {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const listBundles = vi.fn<() => Promise<ListAnswer>>()
  for (const answer of answers) listBundles.mockReturnValueOnce(answer)
  const setBundleEnabled = vi.fn<(name: string, enabled: boolean) => Promise<SwitchAnswer>>()
  new TestRemote(ctx, { pluginManager: { listBundles, setBundleEnabled } })
  const controller = new ConnectorsController(ctx)
  return { controller, face: controller.face('1.2.3'), listBundles, setBundleEnabled }
}

const FAILED: Refused = { ok: false, error: { code: 'plugin-manager/failed', message: 'failed' } }

/** Resolves after every promise reaction queued so far has run. */
const settled = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve) })

it('reads each connector as missing, installed, or on, once, and only after the tab first asks', async () => {
  const { controller, face, listBundles } = bench(Promise.resolve({ ok: true, value: [
    bundle(NOTION, true, true), bundle(TENCENT_DOCS, true, false), bundle('dsh-unrelated', true, true),
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
    '@deepseek-ai/dsh-feishu': 'missing', '@deepseek-ai/dsh-wecom': 'missing', '@deepseek-ai/dsh-dingtalk': 'missing',
    '@deepseek-ai/dsh-tencent-meeting': 'missing', [NOTION]: 'enabled', [TENCENT_DOCS]: 'installed',
    '@deepseek-ai/dsh-linear': 'missing',
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
  second.resolve({ ok: true, value: [bundle(NOTION, true, false)] })
  await vi.waitFor(() => { expect(face.hooks.connectors.getSnapshot().status).toBe('ready') })
  first.resolve({ ok: true, value: [bundle(NOTION, true, true)] })
  await first.promise
  expect(face.hooks.connectors.getSnapshot().connectors[NOTION]).toBe('installed')
  face.retry()
  controller.dispose()
  third.resolve(FAILED)
  await third.promise
  expect(face.hooks.connectors.getSnapshot().status).toBe('ready')
})

it('switches a connector through the Host and keeps it busy until its state is read back', async () => {
  const write = Promise.withResolvers<SwitchAnswer>()
  const readBack = Promise.withResolvers<ListAnswer>()
  const first: ListAnswer = { ok: true, value: [bundle(NOTION, true, false)] }
  const { face, listBundles, setBundleEnabled } = bench(Promise.resolve(first), readBack.promise)
  setBundleEnabled.mockReturnValueOnce(write.promise)
  face.ensure()
  await vi.waitFor(() => { expect(face.hooks.connectors.getSnapshot().status).toBe('ready') })
  face.setEnabled(NOTION, true)
  expect(setBundleEnabled).toHaveBeenCalledExactlyOnceWith(NOTION, true)
  expect(face.hooks.connectors.getSnapshot().busy).toEqual([NOTION])
  write.resolve(switched(NOTION, 'applied'))
  await vi.waitFor(() => { expect(listBundles).toHaveBeenCalledTimes(2) })
  expect(face.hooks.connectors.getSnapshot()).toMatchObject({ status: 'ready', busy: [NOTION], connectors: { [NOTION]: 'installed' } })
  readBack.resolve({ ok: true, value: [bundle(NOTION, true, true)] })
  await vi.waitFor(() => { expect(face.hooks.connectors.getSnapshot().busy).toEqual([]) })
  expect(face.hooks.connectors.getSnapshot()).toMatchObject({ failed: null, connectors: { [NOTION]: 'enabled' } })
})

it('names the connector whose switch the Host refused or could not apply, until another switch starts', async () => {
  const bundles = [bundle(NOTION, true, true), bundle(TENCENT_DOCS, true, false)]
  const installed = (): Promise<ListAnswer> => Promise.resolve({ ok: true, value: bundles })
  const later = Promise.withResolvers<SwitchAnswer>()
  const { face, setBundleEnabled } = bench(installed(), installed(), installed())
  setBundleEnabled.mockReturnValueOnce(Promise.resolve(FAILED)).mockReturnValueOnce(later.promise)
  face.ensure()
  await vi.waitFor(() => { expect(face.hooks.connectors.getSnapshot().status).toBe('ready') })
  face.setEnabled(NOTION, false)
  await vi.waitFor(() => { expect(face.hooks.connectors.getSnapshot()).toMatchObject({ busy: [], failed: NOTION }) })
  expect(face.hooks.connectors.getSnapshot().connectors[NOTION]).toBe('enabled')
  face.setEnabled(TENCENT_DOCS, true)
  expect(face.hooks.connectors.getSnapshot()).toMatchObject({ busy: [TENCENT_DOCS], failed: null })
  later.resolve(switched(TENCENT_DOCS, 'failed'))
  await vi.waitFor(() => { expect(face.hooks.connectors.getSnapshot()).toMatchObject({ busy: [], failed: TENCENT_DOCS }) })
})

it('publishes nothing once disposed during a switch\'s write or its read back', async () => {
  const write = Promise.withResolvers<SwitchAnswer>()
  const writing = bench()
  writing.setBundleEnabled.mockReturnValueOnce(write.promise)
  writing.face.setEnabled(NOTION, true)
  writing.controller.dispose()
  write.resolve(FAILED)
  await settled()
  expect(writing.face.hooks.connectors.getSnapshot()).toMatchObject({ busy: [NOTION], failed: null })
  expect(writing.listBundles).not.toHaveBeenCalled()

  const readBack = Promise.withResolvers<ListAnswer>()
  const reading = bench(readBack.promise)
  reading.setBundleEnabled.mockReturnValueOnce(Promise.resolve(switched(NOTION, 'restart-required')))
  reading.face.setEnabled(NOTION, true)
  await vi.waitFor(() => { expect(reading.listBundles).toHaveBeenCalledOnce() })
  reading.controller.dispose()
  readBack.resolve({ ok: true, value: [bundle(NOTION, true, true)] })
  await settled()
  expect(reading.face.hooks.connectors.getSnapshot()).toMatchObject({ status: 'loading', busy: [NOTION], failed: null, connectors: {} })
})
