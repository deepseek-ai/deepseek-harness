/** Authorized Host PDFs remain binary through Client reuse and disposal. */
import type { OfficeToPdfGeneration } from '@deepseek-ai/dsh-office-to-pdf/types'
import { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-office-to-pdf/remote'
import { makeTranslate, RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { DocumentPreviewRegistry } from '../src/client/document/registry.ts'
import { apply } from '../src/client/office/index.ts'
import { officeFace } from '../src/client/office/face.ts'
import { Config } from '../src/config.ts'
import { OfficeBody, type OfficeBodyInjected } from '../src/client/office/OfficeBody.tsx'
import type { OfficeStore } from '../src/client/office/store.ts'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import { en, zh } from '../src/client/office/locales.ts'
import { en as documentEn } from '../src/client/locales.ts'

vi.mock('../src/client/office/face.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client/office/face.ts')>()
  return { ...actual, officeFace: vi.fn(actual.officeFace) }
})

const file = { sessionId: 's1' as SessionId, path: 'report.DOCX' }
const generation = ('renderer' as OfficeToPdfGeneration)
const pdf = new Uint8Array([37, 80, 68, 70])
const source = { absolutePath: '/report.docx', version: 'v1', offset: 0, eof: true, bytes: 4, data: pdf }
const converted = { ok: true as const, value: { ...source, generation, missingFonts: ['Missing Serif'] } }

it('retains Office view state across remounts and releases it on tab close or plugin disposal', async () => {
  const h = await harness()
  const first = 'first' as TabId
  const second = 'second' as TabId
  const closed = new AbortController()
  const retained = new AbortController()
  try {
    h.instance.actions.loading(first, 1)
    h.injected.retainTab(first, closed.signal)
    h.injected.retainTab(first, closed.signal)
    expect(h.instance.getSnapshot().byTab[first]).toBeDefined()
    closed.abort()
    expect(h.instance.getSnapshot().byTab[first]).toBeUndefined()
    h.instance.actions.loading(first, 2)
    h.injected.retainTab(first, closed.signal)
    expect(h.instance.getSnapshot().byTab[first]).toBeUndefined()
    h.instance.actions.loading(second, 1)
    h.injected.retainTab(second, retained.signal)
    const message = documentEn['error.unavailable'].replace('{message}', 'conversion stopped')
    expect(h.describeFailure(new RemoteError('gateway/internal', 'conversion stopped', {}))).toBe(message)
    expect(h.describeFailure({ message: 'conversion stopped' })).toBe(message)
    await h.close()
    expect(h.instance.getSnapshot().byTab[second]).toBeUndefined()
  } finally { closed.abort(); retained.abort(); await h.close() }
})

async function harness(config: Partial<Config['office']> = {}, missing?: 'remote' | 'render' | 'files') {
  const ctx = new Context()
  const registry = new DocumentPreviewRegistry()
  const removeLocale = vi.fn()
  const locale = { register: vi.fn(() => removeLocale), bind: (name: string) => name === 'sidebarDocumentPreview' ? makeTranslate(documentEn) : makeTranslate(en) }
  const render = vi.fn<ClientRemote['officeToPdf']['render']>().mockResolvedValue(converted)
  const rendererGeneration = vi.fn<ClientRemote['officeToPdf']['generation']>().mockResolvedValue({ ok: true, value: generation })
  const stat = vi.fn<ClientRemote['workspaceFiles']['stat']>().mockResolvedValue({ ok: true, value: source })
  const readBytes = vi.fn<ClientRemote['workspaceFiles']['readBytes']>().mockResolvedValue({ ok: true, value: { ...source, data: pdf.subarray(0, 1), eof: false } })
  const removeNotice = vi.fn()
  const recorded: { options: { name: string; store: OfficeStore; inject: (id: SessionId, actions: ReturnType<OfficeStore['create']>['actions']) => OfficeBodyInjected }; component: unknown }[] = []
  const register = vi.fn((options: typeof recorded[number]['options'], component: unknown) => { recorded.push({ options, component }); return removeNotice })
  ctx.provide('documentPreviews', registry)
  ctx.provide('slots', { inject: (_name: string, effect: () => () => void) => effect(), register } as never)
  ctx.provide('locale', locale as never)
  if (missing !== 'remote') {
    ctx.provide('remote', { workspaceFiles: { stat, readBytes }, officeToPdf: { render, generation: rendererGeneration } } as never)
    if (missing !== 'files') ctx.provide('remote.workspaceFiles', { stat, readBytes } as never)
    if (missing !== 'render') ctx.provide('remote.officeToPdf', { render, generation: rendererGeneration } as never)
  }
  const fiber = ctx.plugin({ apply: (scope: Context) => {
    apply(scope, Config({ office: config }).office)
  } })
  await fiber.await()
  const entry = recorded.find(entry => entry.component === OfficeBody)!.options
  const instance = entry.store.create()
  const injected = entry.inject(file.sessionId, instance.actions)
  const [read, describeFailure] = vi.mocked(officeFace).mock.calls.at(-1)!
  return { ctx, registry, instance, injected, describeFailure, recorded, locale, removeLocale, render, rendererGeneration,
    stat, readBytes, register, removeNotice,
    read: (signal = new AbortController().signal, path = file.path) => read({ ...file, path }, signal),
    close: () => fiber.dispose(),
  }
}

it.each(['remote', 'render', 'files'] as const)('keeps Word and PowerPoint registration and guidance when %s is absent', async (missing) => {
  const h = await harness(undefined, missing)
  try {
    expect(h.locale.register).toHaveBeenCalledWith('sidebarOffice', { zh, en })
    for (const path of ['a.DOC', 'b.DOCX', 'c.PPT', 'd.pptx']) {
      expect(h.registry.candidates(path)[0]!.binaryExtensions).toEqual(['doc', 'docx', 'ppt', 'pptx'])
      expect(h.registry.candidates(path)[0]!.title()).toBe(en.title)
      expect(h.registry.candidates(path)[0]!.loading).toBe('renderer')
      expect(h.registry.candidates(path)[0]).not.toHaveProperty('read')
      await expect(h.read(undefined, path)).rejects.toThrow(en.unavailable)
    }
    for (const path of ['sheet.XLS', 'sheet.xlsx']) expect(h.registry.candidates(path)).toEqual([])
    expect(h.render).not.toHaveBeenCalled()
  } finally { await h.close() }
  expect(h.registry.getSnapshot()).toEqual([])
  expect(h.removeLocale).toHaveBeenCalledOnce()
  expect(h.register).toHaveBeenCalledWith(expect.objectContaining({
    name: 'sidebar.right.tab.document', key: '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/office', locale: 'sidebarOffice',
  }), OfficeBody)
  expect(h.removeNotice).toHaveBeenCalledTimes(3)
})

it('requests a Host PDF with source identity and borrows the same binary cache result', async () => {
  const h = await harness({ maxCachedBytes: pdf.byteLength })
  try {
    const result = await h.read()
    expect(h.render).toHaveBeenCalledExactlyOnceWith(file.sessionId, file.path, 'foreground', expect.any(AbortSignal))
    expect(result).toEqual({ ok: true, value: { ...source, data: pdf, generation, missingFonts: ['Missing Serif'] } })
    expect(await h.read()).toBe(result)
    expect(h.stat).toHaveBeenCalledTimes(2)
    expect(h.readBytes).toHaveBeenCalledTimes(2)
    expect(h.readBytes).toHaveBeenCalledWith(file.sessionId, file.path, { range: { offset: 0, length: 1 } }, expect.any(AbortSignal))
    expect(h.render).toHaveBeenCalledOnce()
  } finally { await h.close() }
})

it.each([
  ['rendererGeneration', 'gateway/invocation-unavailable'], ['rendererGeneration', 'gateway/service-unavailable'],
  ['render', 'gateway/invocation-unavailable'], ['render', 'gateway/service-unavailable'],
] as const)('shows configuration guidance when %s returns %s', async (method, code) => {
  const h = await harness()
  try {
    const endpoint = method === 'render' ? 'officeToPdf/render' : 'officeToPdf/generation'
    const failure = new RemoteError(code, 'Office provider is unavailable.', { endpoint })
    h[method].mockResolvedValueOnce({ ok: false, error: failure })
    await expect(h.read()).rejects.toMatchObject({ message: en.unavailable, cause: failure })
    expect((await h.read()).ok).toBe(true)
  } finally { await h.close() }
})

it('shows configuration guidance when the Host exposes no Office HTTP endpoint', async () => {
  const h = await harness()
  try {
    const failure = new RemoteError('gateway/internal', 'transport failure for /api/officeToPdf/generation: HTTP 404', {})
    h.rendererGeneration.mockResolvedValueOnce({ ok: false, error: failure })
    await expect(h.read()).rejects.toMatchObject({ message: en.unavailable, cause: failure })
    expect(h.readBytes).not.toHaveBeenCalled()
    expect(h.render).not.toHaveBeenCalled()
  } finally { await h.close() }
})

it('refuses Client cached bytes when metadata still succeeds but the read probe fails', async () => {
  const h = await harness()
  try {
    await h.read()
    const failure = new Error('read denied')
    h.readBytes.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', failure.message, {}) })
    expect(await h.read()).toMatchObject({ ok: false, error: { code: 'gateway/internal', message: failure.message } })
    expect(h.render).toHaveBeenCalledOnce()
    expect(h.stat).toHaveBeenCalledOnce()
  } finally { await h.close() }
})

it('returns a declared authorization failure without consulting metadata or cached bytes', async () => {
  const h = await harness()
  try {
    await h.read()
    const denied = { ok: false as const, error: new RemoteError('workspace-file/not-found', 'File missing', { path: file.path }) }
    h.readBytes.mockResolvedValueOnce(denied)
    expect(await h.read()).toMatchObject(denied)
    expect(h.stat).toHaveBeenCalledOnce()
    expect(h.render).toHaveBeenCalledOnce()
  } finally { await h.close() }
})

it('localizes Client capacity rejection while another reader waits for source metadata', async () => {
  const h = await harness({ maxReaders: 1 })
  const entered = Promise.withResolvers<undefined>()
  const completed = Promise.withResolvers<Awaited<ReturnType<typeof h.stat>>>()
  h.stat.mockImplementationOnce(() => { entered.resolve(undefined); return completed.promise })
  const first = h.read()
  try {
    await entered.promise
    await expect(h.read()).rejects.toThrow(en.busy)
    expect(h.stat).toHaveBeenCalledOnce()
    expect(h.render).not.toHaveBeenCalled()
    completed.resolve({ ok: true, value: source })
    expect((await first).ok).toBe(true)
  } finally {
    completed.resolve({ ok: true, value: source })
    await first
    await h.close()
  }
})

it('refuses a source replaced during the Client authorization probe', async () => {
  const h = await harness()
  try {
    h.stat.mockResolvedValueOnce({ ok: true, value: { ...source, version: 'v2' } })
    await expect(h.read()).rejects.toThrow(en.changed)
    expect(h.render).not.toHaveBeenCalled()
  } finally { await h.close() }
})

it('passes source authorization failures through and rechecks permission before reuse', async () => {
  const h = await harness()
  try {
    const missing = { ok: false as const, error: new RemoteError('workspace-file/not-found', 'File missing', { path: file.path }) }
    h.render.mockResolvedValueOnce(missing)
    expect(await h.read()).toBe(missing)
    await h.read()
    h.stat.mockResolvedValueOnce(missing)
    expect(await h.read()).toBe(missing)
    expect(h.render).toHaveBeenCalledTimes(2)
  } finally { await h.close() }
})

it.each([
  ['input-too-large', 'tooLarge'], ['output-too-large', 'tooLarge'], ['invalid-document', 'invalid'],
  ['unsupported-format', 'invalid'], ['invalid-output', 'failed'], ['timeout', 'timeout'],
  ['unavailable', 'unavailable'], ['failed', 'failed'], ['busy', 'busy'], ['source-changed', 'changed'],
] as const)('localizes %s Host conversion failures and allows retry', async (code, key) => {
  const h = await harness()
  try {
    const failure = new RemoteError('document-render/failed', 'Office conversion failed.', { reason: code })
    h.render.mockResolvedValueOnce({ ok: false, error: failure })
    await expect(h.read()).rejects.toMatchObject({ message: en[key], cause: failure })
    expect((await h.read()).ok).toBe(true)
  } finally { await h.close() }
})

it('cancels the Host request on disposal and waits for its completion', async () => {
  const h = await harness()
  const completed = Promise.withResolvers<typeof converted>()
  const started = Promise.withResolvers<AbortSignal>()
  h.render.mockImplementation((_session, _path, _priority, signal) => { started.resolve(signal!); return completed.promise })
  const pending = h.read()
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  const signal = await started.promise
  let disposed = false
  const closing = h.close().then(() => { disposed = true })
  try {
    await rejected
    expect(signal.aborted).toBe(true)
    expect(disposed).toBe(false)
  } finally { completed.resolve(converted); await closing }
})

it('replaces cached PDFs on connection reset', async () => {
  const h = await harness()
  try {
    await h.read()
    await h.ctx.parallel('connection/reset')
    await h.read()
    expect(h.render).toHaveBeenCalledTimes(2)
  } finally { await h.close() }
})

it('joins a retired request during reset without retaining its late PDF in the new cache', async () => {
  const h = await harness()
  const completed = Promise.withResolvers<typeof converted>()
  const started = Promise.withResolvers<AbortSignal>()
  h.render.mockImplementationOnce((_session, _path, _priority, signal) => { started.resolve(signal!); return completed.promise })
  const pending = h.read()
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  const signal = await started.promise
  const resetting = h.ctx.parallel('connection/reset')
  try {
    await rejected
    expect(signal.aborted).toBe(true)
    await h.read()
    expect(h.render).toHaveBeenCalledTimes(2)
    let disposed = false
    const closing = h.close().then(() => { disposed = true })
    expect(disposed).toBe(false)
    completed.resolve(converted)
    await resetting
    await closing
  } finally { completed.resolve(converted); await resetting; await h.close() }
})
