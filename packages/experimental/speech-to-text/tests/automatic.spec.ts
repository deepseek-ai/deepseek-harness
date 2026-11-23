/** Automatic provider preference, readiness-driven routing, and the language rules. */
import { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import SpeechToText from '../src/index.ts'
import type { SpeechPreparationState, SpeechProvider, SpeechProviderId, Transcript } from '../src/types.ts'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'

const result: Transcript = { text: 'hello', audioSeconds: 1, inferenceSeconds: 0.1 }
const audio = new Uint8Array([1, 2])

/** A provider whose availability the test changes through its preparation listener. */
function provider(id: string, languages: string[], initial: SpeechPreparationState = { phase: 'ready' }) {
  let state = initial
  const listeners = new Set<() => void>()
  const transcribe = vi.fn(async () => result)
  const value: SpeechProvider = {
    info: { id: id as SpeechProviderId, name: id, location: 'cloud', languages },
    preparation: {
      snapshot: () => state,
      subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      prepare: () => {},
      cancel: async () => {},
    },
    transcribe,
  }
  return { value, transcribe, set(next: SpeechPreparationState) { state = next; for (const listener of listeners) listener() } }
}

async function mounted(ctx: Context, config: object) {
  const live = await liveConfig(ctx, SpeechToText, config)
  const writes: object[] = []
  ctx.provide('settings', { update: async (_entry: string, patch: Record<string, unknown>) => { writes.push(patch); await live.update(patch) } } as never)
  return { speech: ctx.get('speechToText')!, writes, live }
}

it('rejects an automatic preference without an order and reserves the automatic id', async () => {
  expect(() => new SpeechToText(new Context(), SpeechToText.Config({ defaultProvider: 'auto', language: 'auto' })))
    .toThrow('non-empty autoOrder')
  expect(() => new SpeechToText(new Context(), SpeechToText.Config({ defaultProvider: 'local', autoOrder: ['auto'] })))
    .toThrow('reserved')
  const ctx = new Context()
  try {
    await ctx.plugin(SpeechToText, { defaultProvider: 'local', autoOrder: ['local'] })
    expect(() => ctx.get('speechToText')!.register(provider('auto', ['auto']).value)).toThrow('reserved')
  } finally { await ctx.fiber.dispose() }
})

it('routes automatic selection to the first available provider and follows availability changes', async () => {
  const ctx = new Context()
  try {
    const { speech } = await mounted(ctx, { defaultProvider: 'auto', autoOrder: ['cloud', 'local'], language: 'zh' })
    // No registered provider lists the saved hint yet, so it is reported as automatic detection.
    expect(speech.snapshot().selection).toEqual({ mode: 'auto', providerId: 'cloud', language: 'auto' })
    const cloud = provider('cloud', ['auto'], { phase: 'unavailable', reason: 'sign-in-required' })
    const local = provider('local', ['auto', 'zh'], { phase: 'unprepared' })
    speech.register(cloud.value)
    expect(speech.snapshot().selection.providerId).toBe('cloud')
    speech.register(local.value)
    const stream = speech.follow(new AbortController().signal)[Symbol.asyncIterator]()
    expect((await stream.next()).value).toMatchObject({ selection: { mode: 'auto', providerId: 'local' } })
    expect(speech.resolve({ audio })).toMatchObject({ provider: local.value, language: 'zh' })
    const next = stream.next()
    cloud.set({ phase: 'ready' })
    expect((await next).value).toMatchObject({ selection: { mode: 'auto', providerId: 'cloud', language: 'zh' } })
    expect(speech.resolve({ audio })).toEqual({ provider: cloud.value, audio, language: 'auto' })
    expect(speech.resolve({ audio, providerId: local.value.info.id })).toMatchObject({ provider: local.value, language: 'zh' })
    local.set({ phase: 'unavailable', reason: 'sign-in-required' })
    cloud.set({ phase: 'unavailable', reason: 'sign-in-required' })
    expect(speech.snapshot().selection.providerId).toBe('cloud')
  } finally { await ctx.fiber.dispose() }
})

it('prefers a provider that records now over an earlier one that needs preparation, and skips failed ones', async () => {
  const ctx = new Context()
  try {
    const { speech } = await mounted(ctx, { defaultProvider: 'auto', autoOrder: ['local', 'cloud'], language: 'auto' })
    const local = provider('local', ['auto'], { phase: 'unprepared' }), cloud = provider('cloud', ['auto'], { phase: 'ready' })
    speech.register(local.value); speech.register(cloud.value)
    expect(speech.snapshot().selection.providerId).toBe('cloud')
    cloud.set({ phase: 'failed', message: 'settings do not resolve' })
    expect(speech.snapshot().selection.providerId).toBe('local')
    local.set({ phase: 'failed', message: 'download failed' })
    expect(speech.snapshot().selection.providerId).toBe('local')
    for (const phase of ['standby', 'waking'] as const) {
      cloud.set(phase === 'standby' ? { phase } : { phase, startedAt: 0 })
      expect(speech.snapshot().selection.providerId).toBe('cloud')
    }
  } finally { await ctx.fiber.dispose() }
})

it('saves any language some provider lists and gives each provider auto for hints it does not list', async () => {
  const ctx = new Context()
  try {
    const { speech, writes } = await mounted(ctx, { defaultProvider: 'local', autoOrder: ['cloud', 'local'], language: 'auto' })
    const cloud = provider('cloud', ['auto', 'zh', 'es']), local = provider('local', ['auto', 'zh'])
    speech.register(cloud.value); speech.register(local.value)
    await expect(speech.configure({ providerId: 'auto', language: 'fr' })).rejects.toThrow('No registered speech provider supports language: fr')
    await speech.configure({ providerId: 'auto', language: 'es' })
    expect(speech.snapshot().selection).toEqual({ mode: 'auto', providerId: 'cloud', language: 'es' })
    expect(speech.resolve({ audio })).toEqual({ provider: cloud.value, audio, language: 'es' })
    expect(speech.resolve({ audio, providerId: local.value.info.id })).toEqual({ provider: local.value, audio, language: 'auto' })
    expect(() => speech.resolve({ audio, language: 'fr' })).toThrow('No registered speech provider supports language: fr')
    await speech.transcribe(speech.resolve({ audio }), new AbortController().signal)
    expect(cloud.transcribe).toHaveBeenLastCalledWith({ audio, language: 'es' }, expect.any(AbortSignal))
    await speech.transcribe(speech.resolve({ audio, providerId: local.value.info.id }), new AbortController().signal)
    expect(local.transcribe).toHaveBeenLastCalledWith({ audio, language: 'auto' }, expect.any(AbortSignal))
    await speech.configure({ providerId: 'local' as SpeechProviderId })
    expect(speech.snapshot().selection).toEqual({ mode: 'explicit', providerId: 'local', language: 'es' })
    expect(writes).toEqual([{ defaultProvider: 'auto', language: 'es' }, { defaultProvider: 'local' }])
  } finally { await ctx.fiber.dispose() }
})

it('treats a provider without preparation as ready to record', async () => {
  const ctx = new Context()
  try {
    const { speech } = await mounted(ctx, { defaultProvider: 'auto', autoOrder: ['local', 'plain'], language: 'auto' })
    speech.register(provider('local', ['auto'], { phase: 'unprepared' }).value)
    speech.register({ info: { id: 'plain' as SpeechProviderId, name: 'plain', location: 'host-local', languages: ['auto'] }, transcribe: async () => result })
    expect(speech.snapshot().selection.providerId).toBe('plain')
  } finally { await ctx.fiber.dispose() }
})

it('falls back to automatic detection for a saved hint no registered provider lists', async () => {
  const ctx = new Context()
  try {
    const { speech } = await mounted(ctx, { defaultProvider: 'local', autoOrder: ['local'], language: 'es' })
    const cloud = provider('cloud', ['auto', 'es']), local = provider('local', ['auto', 'zh'])
    const removeCloud = speech.register(cloud.value)
    speech.register(local.value)
    expect(speech.snapshot().selection.language).toBe('es')
    await removeCloud()
    expect(speech.snapshot().selection).toEqual({ mode: 'explicit', providerId: 'local', language: 'auto' })
    expect(speech.resolve({ audio })).toEqual({ provider: local.value, audio, language: 'auto' })
  } finally { await ctx.fiber.dispose() }
})

it('requires every provider to accept automatic language detection', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SpeechToText, { defaultProvider: 'local', autoOrder: ['local'] })
    expect(() => ctx.get('speechToText')!.register(provider('local', ['zh']).value)).toThrow('must accept the language hint `auto`')
  } finally { await ctx.fiber.dispose() }
})

it('checks only registered automatic providers when saving the automatic preference', async () => {
  const ctx = new Context()
  try {
    const { speech, writes } = await mounted(ctx, { defaultProvider: 'local', autoOrder: ['cloud', 'local'], language: 'zh' })
    speech.register(provider('local', ['auto', 'zh']).value)
    await speech.configure({ providerId: 'auto' })
    expect(speech.snapshot().selection).toEqual({ mode: 'auto', providerId: 'local', language: 'zh' })
    expect(writes).toEqual([{ defaultProvider: 'auto' }])
  } finally { await ctx.fiber.dispose() }
})

it('fails explicitly when the live preference becomes automatic without an order', async () => {
  const ctx = new Context()
  try {
    const { speech, live } = await mounted(ctx, { defaultProvider: 'local', language: 'auto' })
    speech.register(provider('local', ['auto']).value)
    await expect(speech.configure({ providerId: 'auto' })).rejects.toThrow('non-empty autoOrder')
    await live.update({ defaultProvider: 'auto' })
    expect(() => speech.resolve({ audio })).toThrow('non-empty autoOrder')
    expect(speech.resolve({ audio, providerId: 'local' as SpeechProviderId })).toMatchObject({ language: 'auto' })
  } finally { await ctx.fiber.dispose() }
})
