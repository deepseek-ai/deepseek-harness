/** The optional namespace and both UI contributions leave with the plugin. */
import assert from 'node:assert/strict'
import { Context, Service } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { InjectParams, StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { RemoteError, type RemoteResult, type TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type { CotTranslationPreferences, CotTranslationSnapshot } from '../src/preferences.ts'
import type { TranslationBodyInjected } from '../src/client/TranslationBody.tsx'
import type { TranslationFormInjected } from '../src/client/preferences-form.ts'
import { inject, mountTranslation } from '../src/client/mount.ts'

const contribution: TypertRemoteContribution = { package: '@deepseek-ai/dsh-experimental-client-ui-cot-translation', descriptors: [] }
const sourceSessionId = SessionId('reasoning-source')

async function fixture(failure = false, preferences: CotTranslationPreferences = { provider: 'bing', targetLanguage: 'auto' }) {
  const ctx = new Context(), unmount = vi.fn(async () => {})
  const listeners = new Map<string, Set<() => void>>()
  let catalog: CotTranslationSnapshot = { maxTextChars: 12, availableProviders: ['bing', 'google'], preferences }
  class TestRemote extends Service {
    constructor() { super(ctx, 'remote') }
    $on(event: string, listener: () => void) {
      expect(['settings/document-updated', 'llm/adapters-updated', 'deepseek-account/session-expired',
        'deepseek-account/model-sign-in-required', 'credentials/record-updated', 'credentials/reference-updated']).toContain(event)
      let group = listeners.get(event)
      if (group === undefined) { group = new Set(); listeners.set(event, group) }
      group.add(listener)
      return () => { group.delete(listener); if (group.size === 0) listeners.delete(event) }
    }
    async $mount(value: TypertRemoteContribution) { expect(value).toBe(contribution); return unmount }
  }
  new TestRemote()
  const limits = vi.fn<(signal: AbortSignal) => Promise<RemoteResult<CotTranslationSnapshot>>>(async () => failure ? { ok: false, error: new RemoteError('cotTranslation/failed', 'limits unavailable', {}) }
    : { ok: true, value: catalog })
  const translate = vi.fn(async () => ({ ok: true, value: 'translated' }))
  ctx.provide('remote.cotTranslation', { limits, translate } as never)
  ctx.provide('locale', new LocaleRuntime(ctx))
  const scope = stubConfigForm<CotTranslationPreferences>()
  ctx.provide('configForms', { get: (name: string) => { expect(name).toBe('cot-translation'); return scope.scope } } as never)
  await ctx.plugin(SlotRegistry)
  ctx.slots.register({ name: 'root', children: {
    'conversation.chat.reasoning.body': { kind: 'single', scope: 'session' },
    'plugins.bundle.config': { kind: 'keyed', scope: 'root' },
  } } as never, () => null)
  return { ctx, limits, translate, unmount, scope, listeners,
    setCatalog: (value: CotTranslationSnapshot) => { catalog = value },
    invalidate: () => { for (const listener of listeners.get('settings/document-updated') ?? []) listener() },
    emitEvent: (event: string) => { for (const listener of listeners.get(event) ?? []) listener() } }
}

function bodyFace(value: Record<string, unknown>): asserts value is Record<string, unknown> & TranslationBodyInjected {
  assert(typeof value.translate === 'function')
  assert(typeof value.hooks === 'object' && value.hooks !== null)
}

function formFace(value: Record<string, unknown>): asserts value is Record<string, unknown> & Pick<TranslationFormInjected, 'edit'> {
  assert(typeof value.edit === 'function')
}

/** Invoke the owned reasoning contribution with its declared Session parameters. */
function injectReasoning(entry: StoredEntry, sessionId: SessionId): Record<string, unknown> {
  assert(typeof entry.inject === 'function')
  const inject = entry.inject as (...args: InjectParams<'conversation.chat.reasoning.body', undefined>) => Record<string, unknown>
  return inject(sessionId)
}

it.each(['bing', 'google'] as const)('binds %s requests to each reasoning Session and overrides a supplied source id', async (provider) => {
  const b = await fixture(false, { provider, targetLanguage: 'ja' })
  try {
    const dispose = await mountTranslation(b.ctx, contribution)
    const entry = b.ctx.slots.entries('conversation.chat.reasoning.body')[0]!
    const first = injectReasoning(entry, sourceSessionId), otherSessionId = SessionId('other-reasoning-source')
    const second = injectReasoning(entry, otherSessionId)
    bodyFace(first); bodyFace(second)
    const request = { text: 'original', provider, targetLanguage: 'ja', sessionId: SessionId('forged-source') }
    const signal = new AbortController().signal
    expect(await first.translate(request, signal)).toBe('translated')
    expect(await second.translate(request, signal)).toBe('translated')
    expect(b.translate.mock.calls).toEqual([
      [{ ...request, sessionId: sourceSessionId }, signal],
      [{ ...request, sessionId: otherSessionId }, signal],
    ])
    await dispose()
  } finally { await b.ctx.fiber.dispose() }
})

it('registers translated reasoning and preferences, adopts accepted choices, and disposes both before the Remote', async () => {
  const b = await fixture()
  try {
    const fiber = b.ctx.plugin({ inject: [...inject], apply: ctx => mountTranslation(ctx, contribution) })
    await fiber
    const entry = b.ctx.slots.entries('conversation.chat.reasoning.body')[0]!
    expect(entry.locale).toBe('cotTranslation')
    expect(entry.select).toBeUndefined()
    expect(b.ctx.slots.spec('conversation.chat.reasoning.body')).toMatchObject({ kind: 'single', scope: 'session' })
    const body = injectReasoning(entry, sourceSessionId)
    bodyFace(body)
    expect(body.hooks.translationLimit.getSnapshot()).toBe(12)
    expect(body.hooks.preferences.getSnapshot()).toEqual({ provider: 'bing', targetLanguage: 'auto' })
    b.setCatalog({ maxTextChars: 12, availableProviders: ['bing', 'google'], preferences: { provider: 'bing', targetLanguage: 'ja' } })
    b.scope.publish({ value: { provider: 'bing', targetLanguage: 'ja' } })
    await vi.waitFor(() => { expect(body.hooks.preferences.getSnapshot()).toEqual({ provider: 'bing', targetLanguage: 'ja' }) })
    expect(b.ctx.slots.entries('plugins.bundle.config')[0]?.options).toMatchObject({ key: '@deepseek-ai/dsh-experimental-cot-translation-bundle' })
    expect(b.ctx.slots.entries('plugins.bundle.config')[0]!.inject!()).toHaveProperty('hooks.translationForm')
    const request = { text: 'original', provider: 'bing' as const, targetLanguage: 'ja' }, signal = new AbortController().signal
    expect(await body.translate(request, signal)).toBe('translated')
    b.translate.mockResolvedValueOnce({ ok: false, error: new RemoteError('cotTranslation/failed', 'request failed', {}) } as never)
    await expect(body.translate(request, signal)).rejects.toThrow('request failed')
    await fiber.dispose()
    expect(b.ctx.slots.entries('conversation.chat.reasoning.body')).toHaveLength(0)
    expect(b.ctx.slots.entries('plugins.bundle.config')).toHaveLength(0)
    expect(b.scope.listenerCount()).toBe(0)
    expect(b.listeners.size).toBe(0)
    expect(b.unmount).toHaveBeenCalledOnce()
  } finally { await b.ctx.fiber.dispose() }
})

it.each(['limits', 'registration'])('rolls back the Remote when %s fails', async (kind) => {
  const b = await fixture(kind === 'limits')
  if (kind === 'registration') vi.spyOn(b.ctx.slots, 'inject').mockImplementationOnce(() => { throw new Error('registration failed') })
  try {
    await expect(mountTranslation(b.ctx, contribution)).rejects.toThrow()
    expect(b.unmount).toHaveBeenCalledOnce()
    expect(b.scope.listenerCount()).toBe(0)
  } finally { await b.ctx.fiber.dispose() }
})

it('loads the browser entry through its generated optional Remote contribution', async () => {
  const b = await fixture()
  vi.doMock('@deepseek-ai/dsh-experimental-client-ui-cot-translation/remote', () => ({ default: contribution }))
  try {
    const browser = await import('../src/client/index.ts')
    expect(browser.inject).toEqual(inject)
    const fiber = b.ctx.plugin({ inject: [...browser.inject], apply: browser.apply })
    await fiber
    expect(b.ctx.slots.entries('conversation.chat.reasoning.body')).toHaveLength(1)
    await fiber.dispose()
    expect(b.unmount).toHaveBeenCalledOnce()
  } finally {
    await b.ctx.fiber.dispose()
    vi.doUnmock('@deepseek-ai/dsh-experimental-client-ui-cot-translation/remote')
  }
})


it.each(['loading', 'memory'] as const)('uses Host Google preferences while the settings form is %s', async (mode) => {
  const preferences: CotTranslationPreferences = { provider: 'google', targetLanguage: 'ja' }
  const b = await fixture(false, preferences)
  if (mode === 'memory') b.scope.publish({ status: 'unavailable', mode: 'memory', value: undefined })
  try {
    const fiber = b.ctx.plugin({ inject: [...inject], apply: ctx => mountTranslation(ctx, contribution) })
    await fiber
    const body = injectReasoning(b.ctx.slots.entries('conversation.chat.reasoning.body')[0]!, sourceSessionId)
    bodyFace(body)
    expect(body.hooks.preferences.getSnapshot()).toEqual(preferences)
    expect(b.scope.scope.getSnapshot().value).toBeUndefined()
    await body.translate({ text: 'original', ...body.hooks.preferences.getSnapshot() }, new AbortController().signal)
    expect(b.translate).toHaveBeenCalledWith({ text: 'original', provider: 'google', targetLanguage: 'ja', sessionId: sourceSessionId }, expect.any(AbortSignal))
  } finally { await b.ctx.fiber.dispose() }
})

it('does not install a reasoning renderer before authoritative metadata arrives, and invalidates stale initial reads', async () => {
  const b = await fixture(), pending = Promise.withResolvers<RemoteResult<CotTranslationSnapshot>>()
  b.limits.mockImplementationOnce(() => pending.promise)
  try {
    const task = mountTranslation(b.ctx, contribution)
    await vi.waitFor(() => { expect(b.limits).toHaveBeenCalledOnce() })
    expect(b.ctx.slots.entries('conversation.chat.reasoning.body')).toHaveLength(0)
    expect(b.translate).not.toHaveBeenCalled()
    b.setCatalog({ maxTextChars: 4, availableProviders: ['bing', 'google'], preferences: { provider: 'google', targetLanguage: 'ja' } })
    b.invalidate()
    pending.resolve({ ok: true, value: { maxTextChars: 12, availableProviders: ['bing', 'google'], preferences: { provider: 'bing', targetLanguage: 'auto' } } })
    const dispose = await task
    const body = injectReasoning(b.ctx.slots.entries('conversation.chat.reasoning.body')[0]!, sourceSessionId)
    bodyFace(body)
    expect(body.hooks.preferences.getSnapshot()).toEqual({ provider: 'google', targetLanguage: 'ja' })
    expect(body.hooks.translationLimit.getSnapshot()).toBe(4)
    expect(b.limits).toHaveBeenCalledTimes(2)
    await dispose()
  } finally { await b.ctx.fiber.dispose() }
})

it('refreshes accepted Host preferences and limits on invalidation and reconnect without adopting drafts', async () => {
  const b = await fixture(false, { provider: 'google', targetLanguage: 'ja' })
  try {
    const dispose = await mountTranslation(b.ctx, contribution)
    const body = injectReasoning(b.ctx.slots.entries('conversation.chat.reasoning.body')[0]!, sourceSessionId)
    bodyFace(body)
    const form = b.ctx.slots.entries('plugins.bundle.config')[0]!.inject!()
    formFace(form)
    form.edit('provider', 'bing')
    expect(body.hooks.preferences.getSnapshot()).toEqual({ provider: 'google', targetLanguage: 'ja' })
    b.setCatalog({ maxTextChars: 4, availableProviders: ['bing', 'google'], preferences: { provider: 'google', targetLanguage: 'ja' } })
    b.invalidate()
    await vi.waitFor(() => { expect(body.hooks.translationLimit.getSnapshot()).toBe(4) })
    b.setCatalog({ maxTextChars: 8, availableProviders: ['bing', 'google'], preferences: { provider: 'bing', targetLanguage: 'zh' } })
    b.ctx.emit('connection/reset')
    await vi.waitFor(() => { expect(body.hooks.preferences.getSnapshot()).toEqual({ provider: 'bing', targetLanguage: 'zh' }) })
    expect(body.hooks.translationLimit.getSnapshot()).toBe(8)
    await dispose()
  } finally { await b.ctx.fiber.dispose() }
})

it.each(['resolve', 'reject'] as const)('cancels setup, joins the pending read, and excludes a late %s after withdrawal', async (outcome) => {
  const b = await fixture(), pending = Promise.withResolvers<RemoteResult<CotTranslationSnapshot>>()
  b.limits.mockImplementationOnce(() => pending.promise)
  try {
    const fiber = b.ctx.plugin({ inject: [...inject], apply: ctx => mountTranslation(ctx, contribution) })
    await vi.waitFor(() => { expect(b.limits).toHaveBeenCalledOnce() })
    const querySignal = b.limits.mock.calls[0]![0]
    const disposing = fiber.dispose()
    await vi.waitFor(() => { expect(querySignal.aborted).toBe(true) })
    expect(b.unmount).not.toHaveBeenCalled()
    if (outcome === 'resolve') pending.resolve({ ok: true,
      value: { maxTextChars: 12, availableProviders: ['bing', 'google'], preferences: { provider: 'google', targetLanguage: 'ja' } } })
    else pending.reject(new Error('late metadata failure'))
    await disposing
    expect(b.ctx.slots.entries('conversation.chat.reasoning.body')).toHaveLength(0)
    expect(b.scope.listenerCount()).toBe(0)
    expect(b.listeners.size).toBe(0)
    expect(b.unmount).toHaveBeenCalledOnce()
  } finally {
    pending.resolve({ ok: true, value: { maxTextChars: 12, availableProviders: ['bing', 'google'], preferences: { provider: 'bing', targetLanguage: 'auto' } } })
    await b.ctx.fiber.dispose()
  }
})


it('holds new fragments during metadata refresh and rejects stale routing or limits before submission', async () => {
  const b = await fixture(), pending = Promise.withResolvers<RemoteResult<CotTranslationSnapshot>>()
  try {
    const dispose = await mountTranslation(b.ctx, contribution)
    const body = injectReasoning(b.ctx.slots.entries('conversation.chat.reasoning.body')[0]!, sourceSessionId)
    bodyFace(body)
    b.limits.mockImplementationOnce(() => pending.promise)
    b.invalidate()
    const stale = body.translate({ text: 'private', provider: 'bing', targetLanguage: 'zh' }, new AbortController().signal)
    expect(b.translate).not.toHaveBeenCalled()
    pending.resolve({ ok: true, value: { maxTextChars: 4, availableProviders: ['bing', 'google'], preferences: { provider: 'google', targetLanguage: 'ja' } } })
    await expect(stale).rejects.toThrow('changed')
    await expect(body.translate({ text: 'private', provider: 'google', targetLanguage: 'ja' }, new AbortController().signal))
      .rejects.toThrow('changed')
    await expect(body.translate({ text: 'word', provider: 'google', targetLanguage: 'zh' }, new AbortController().signal))
      .rejects.toThrow('changed')
    expect(b.translate).not.toHaveBeenCalled()
    expect(await body.translate({ text: 'word', provider: 'google', targetLanguage: 'ja' }, new AbortController().signal)).toBe('translated')
    await dispose()
  } finally {
    pending.resolve({ ok: true, value: { maxTextChars: 12, availableProviders: ['bing', 'google'], preferences: { provider: 'bing', targetLanguage: 'auto' } } })
    await b.ctx.fiber.dispose()
  }
})

it('rechecks the caller abort after a held metadata query completes', async () => {
  const b = await fixture(), pending = Promise.withResolvers<RemoteResult<CotTranslationSnapshot>>()
  try {
    const dispose = await mountTranslation(b.ctx, contribution)
    const body = injectReasoning(b.ctx.slots.entries('conversation.chat.reasoning.body')[0]!, sourceSessionId)
    bodyFace(body)
    b.limits.mockImplementationOnce(() => pending.promise)
    b.invalidate()
    const caller = new AbortController(), reason = new Error('cancelled before dispatch')
    const translated = body.translate({ text: 'private', provider: 'bing', targetLanguage: 'zh' }, caller.signal)
    caller.abort(reason)
    pending.resolve({ ok: true, value: { maxTextChars: 12, availableProviders: ['bing', 'google'], preferences: { provider: 'bing', targetLanguage: 'auto' } } })
    await expect(translated).rejects.toBe(reason)
    expect(b.translate).not.toHaveBeenCalled()
    await dispose()
  } finally {
    pending.resolve({ ok: true, value: { maxTextChars: 12, availableProviders: ['bing', 'google'], preferences: { provider: 'bing', targetLanguage: 'auto' } } })
    await b.ctx.fiber.dispose()
  }
})


it('rolls back a failed initial metadata transport read', async () => {
  const b = await fixture()
  b.limits.mockRejectedValueOnce(new Error('metadata transport failed'))
  try {
    await expect(mountTranslation(b.ctx, contribution)).rejects.toThrow('metadata transport failed')
    expect(b.ctx.slots.entries('conversation.chat.reasoning.body')).toHaveLength(0)
    expect(b.unmount).toHaveBeenCalledOnce()
  } finally { await b.ctx.fiber.dispose() }
})

it.each(['throw', 'refuse'] as const)('does not submit after a %s metadata refresh and retries metadata before the next fragment', async (outcome) => {
  const b = await fixture()
  try {
    const dispose = await mountTranslation(b.ctx, contribution)
    const body = injectReasoning(b.ctx.slots.entries('conversation.chat.reasoning.body')[0]!, sourceSessionId)
    bodyFace(body)
    if (outcome === 'throw') b.limits.mockRejectedValueOnce(new Error('metadata unavailable'))
    else b.limits.mockResolvedValueOnce({ ok: false, error: new RemoteError('cotTranslation/failed', 'metadata unavailable', {}) })
    b.invalidate()
    const request = { text: 'private', provider: 'bing' as const, targetLanguage: 'zh' }, signal = new AbortController().signal
    await expect(body.translate(request, signal)).rejects.toThrow('changed')
    expect(b.translate).not.toHaveBeenCalled()
    expect(await body.translate(request, signal)).toBe('translated')
    await dispose()
  } finally { await b.ctx.fiber.dispose() }
})

it.each(['resolve', 'reject'] as const)('joins an in-flight refresh and excludes a late %s during disposal', async (outcome) => {
  const b = await fixture(), pending = Promise.withResolvers<RemoteResult<CotTranslationSnapshot>>()
  try {
    const dispose = await mountTranslation(b.ctx, contribution)
    const body = injectReasoning(b.ctx.slots.entries('conversation.chat.reasoning.body')[0]!, sourceSessionId)
    bodyFace(body)
    b.limits.mockImplementationOnce(() => pending.promise)
    b.invalidate()
    const signal = b.limits.mock.calls[1]![0]
    const disposing = dispose()
    await vi.waitFor(() => { expect(signal.aborted).toBe(true) })
    expect(b.unmount).not.toHaveBeenCalled()
    if (outcome === 'resolve') pending.resolve({ ok: true,
      value: { maxTextChars: 4, availableProviders: ['bing', 'google'], preferences: { provider: 'google', targetLanguage: 'ja' } } })
    else pending.reject(new Error('late refresh failure'))
    await disposing
    expect(body.hooks.preferences.getSnapshot()).toEqual({ provider: 'bing', targetLanguage: 'auto' })
    expect(body.hooks.translationLimit.getSnapshot()).toBe(12)
    await expect(body.translate({ text: 'private', provider: 'bing', targetLanguage: 'zh' }, new AbortController().signal))
      .rejects.toThrow('changed')
    expect(b.unmount).toHaveBeenCalledOnce()
  } finally {
    pending.resolve({ ok: true, value: { maxTextChars: 12, availableProviders: ['bing', 'google'], preferences: { provider: 'bing', targetLanguage: 'auto' } } })
    await b.ctx.fiber.dispose()
  }
})


it('retains an invalidation raised synchronously while a refreshed snapshot is being published', async () => {
  const b = await fixture()
  let unsubscribe: (() => void) | undefined
  try {
    const dispose = await mountTranslation(b.ctx, contribution)
    const body = injectReasoning(b.ctx.slots.entries('conversation.chat.reasoning.body')[0]!, sourceSessionId)
    bodyFace(body)
    let invalidated = false
    unsubscribe = body.hooks.preferences.subscribe(() => {
      if (invalidated) return
      invalidated = true
      b.setCatalog({ maxTextChars: 4, availableProviders: ['bing', 'google'], preferences: { provider: 'bing', targetLanguage: 'ja' } })
      b.invalidate()
    })
    b.setCatalog({ maxTextChars: 8, availableProviders: ['bing', 'google'], preferences: { provider: 'google', targetLanguage: 'ja' } })
    b.invalidate()
    await vi.waitFor(() => { expect(body.hooks.preferences.getSnapshot()).toEqual({ provider: 'bing', targetLanguage: 'ja' }) })
    expect(body.hooks.translationLimit.getSnapshot()).toBe(4)
    expect(b.limits).toHaveBeenCalledTimes(3)
    await dispose()
  } finally { unsubscribe?.(); await b.ctx.fiber.dispose() }
})


it('advertises eligible paid routes without changing Bing selection or sending a translation', async () => {
  const b = await fixture()
  b.setCatalog({ maxTextChars: 12, availableProviders: ['bing', 'google', 'deepseek-account', 'deepseek-official'],
    preferences: { provider: 'bing', targetLanguage: 'auto' } })
  try {
    const dispose = await mountTranslation(b.ctx, contribution)
    const settings = b.ctx.slots.entries('plugins.bundle.config')[0]!.inject!()
    assert(typeof settings.refreshProviders === 'function')
    expect(settings.hooks).toBeTruthy()
    const body = injectReasoning(b.ctx.slots.entries('conversation.chat.reasoning.body')[0]!, SessionId('reasoning-session'))
    bodyFace(body)
    expect(body.hooks.preferences.getSnapshot()).toEqual({ provider: 'bing', targetLanguage: 'auto' })
    expect(b.translate).not.toHaveBeenCalled()
    await dispose()
  } finally { await b.ctx.fiber.dispose() }
})

it.each(['deepseek-account', 'deepseek-official'] as const)('binds selected paid route %s and delegates unavailable cache lookup to the Host', async (provider) => {
  const b = await fixture(false, { provider, targetLanguage: 'auto' })
  const catalog: CotTranslationSnapshot = { maxTextChars: 12,
    availableProviders: ['bing', 'google', 'deepseek-account', 'deepseek-official'], preferences: { provider, targetLanguage: 'auto' } }
  b.setCatalog(catalog)
  try {
    const dispose = await mountTranslation(b.ctx, contribution)
    const sessionId = SessionId('existing-viewed-session')
    const body = injectReasoning(b.ctx.slots.entries('conversation.chat.reasoning.body')[0]!, sessionId)
    bodyFace(body)
    expect(b.translate).not.toHaveBeenCalled()
    await body.translate({ text: 'original', provider, targetLanguage: 'zh', sessionId: SessionId('other-session') },
      new AbortController().signal)
    expect(b.translate).toHaveBeenCalledWith({ text: 'original', provider, targetLanguage: 'zh', sessionId }, expect.any(AbortSignal))
    await body.translate({ text: 'another', provider, targetLanguage: 'zh' }, new AbortController().signal)
    expect(b.limits).toHaveBeenCalledOnce()
    b.setCatalog({ ...catalog, availableProviders: ['bing', 'google'] })
    b.emitEvent('credentials/record-updated')
    expect(await body.translate({ text: 'original', provider, targetLanguage: 'zh' }, new AbortController().signal)).toBe('translated')
    expect(b.translate).toHaveBeenCalledTimes(3)
    expect(body.hooks.preferences.getSnapshot()).toEqual({ provider, targetLanguage: 'auto' })
    await dispose()
  } finally { await b.ctx.fiber.dispose() }
})

it.each(['llm/adapters-updated', 'deepseek-account/session-expired', 'deepseek-account/model-sign-in-required',
  'credentials/record-updated', 'credentials/reference-updated'])('refreshes eligibility when %s is forwarded', async (event) => {
  const b = await fixture()
  try {
    const dispose = await mountTranslation(b.ctx, contribution)
    const settings = b.ctx.slots.entries('plugins.bundle.config')[0]!.inject!()
    const hooks = settings.hooks as { availableProviders: { getSnapshot: () => readonly string[] } }
    expect(hooks.availableProviders.getSnapshot()).toEqual(['bing', 'google'])
    b.setCatalog({ maxTextChars: 12, availableProviders: ['bing', 'google', 'deepseek-official'],
      preferences: { provider: 'bing', targetLanguage: 'auto' } })
    b.emitEvent(event)
    await vi.waitFor(() => { expect(hooks.availableProviders.getSnapshot()).toContain('deepseek-official') })
    expect(b.translate).not.toHaveBeenCalled()
    await dispose()
  } finally { await b.ctx.fiber.dispose() }
})
