// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { stubConfigForm, type StubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import type { LocaleSettings, LocaleSnapshot } from '@deepseek-ai/dsh-client-locale/client'
import { FALLBACK_LOCALE, LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
const make = (host?: StubConfigForm<LocaleSettings>): {
  ctx: Context
  svc: LocaleRuntime
  events: LocaleSnapshot[]
} => {
  const ctx = new Context()
  const events: LocaleSnapshot[] = []
  ctx.on('locale/change', (snapshot) => { events.push(snapshot) })
  return { ctx, svc: new LocaleRuntime(ctx, host?.scope), events }
}

/**
 * Pin the browser environment a fresh service reads its initial locale from.
 * This package's own specs stub the globals directly instead of using
 * `usePinnedBrowserLanguages` (dsh-client-test-runtime): they need the shapes
 * that helper deliberately cannot express — a missing `languages` list, a
 * list decoupled from `language`, and a non-browser run with no `window`.
 */
const stubLanguages = (...tags: string[]): void => {
  vi.stubGlobal('navigator', { languages: tags, language: tags[0] ?? '' })
}

describe('LocaleRuntime', () => {
  beforeEach(() => {
    // A Chinese browser is the baseline these specs assert their zh state on.
    stubLanguages('zh-CN')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('translates through the active-locale -> en -> key chain', () => {
    const { svc } = make()
    svc.register('ns', 'zh', { hello: '你好' })
    svc.register('ns', 'en', { hello: 'Hello', onlyEn: 'English only' })
    const t = svc.bind('ns')
    expect(svc.getLocale().active).toBe('zh')
    expect(t('hello')).toBe('你好')
    // The active locale misses this key; the en fallback supplies it.
    expect(t('onlyEn')).toBe('English only')
    svc.setLocale('en')
    expect(t('hello')).toBe('Hello')
    expect(t('missing.key')).toBe('missing.key')
  })

  it('falls through to the common vocabulary after the namespace misses (production keys)', () => {
    const { svc } = make()
    // The shipped common pair is registered by apply; the bench registers it
    // directly to pin the production chain: ns -> common -> en -> key.
    svc.register('common', 'zh', { retry: '重试' })
    svc.register('common', 'en', { retry: 'Retry' })
    svc.register('ns', 'en', { own: 'Own' })
    const t = svc.bind('ns')
    expect(t('retry')).toBe('重试')
    // zh is active and `ns` has no zh dictionary at all: the en fallback answers.
    expect(t('own')).toBe('Own')
    svc.setLocale('en')
    expect(t('retry')).toBe('Retry')
    expect(t('own')).toBe('Own')
    // common itself must not recurse: a miss inside common echoes the key.
    // (Wide-string ns hits the untyped bind overload — the typed one rejects
    // unknown keys at compile time, which is the point of the typed registry contract.)
    expect(svc.bind('common' as string)('nope')).toBe('nope')
  })

  it('interpolates {name} params and leaves unknown placeholders intact', () => {
    const { svc } = make()
    svc.register('ns', 'zh', { greet: '你好，{name}！第 {n} 次', partial: '{known} 与 {unknown}' })
    const t = svc.bind('ns')
    expect(t('greet', { name: '世界', n: 2 })).toBe('你好，世界！第 2 次')
    expect(t('partial', { known: 'A' })).toBe('A 与 {unknown}')
  })

  it('bind returns a stable per-namespace function identity', () => {
    const { svc } = make()
    expect(svc.bind('a')).toBe(svc.bind('a'))
    expect(svc.bind('a')).not.toBe(svc.bind('b'))
  })

  it('rejects duplicate (ns, locale) and disposer only removes its own dict', () => {
    const { svc } = make()
    const dispose = svc.register('ns', 'zh', { k: 'v1' })
    expect(() => svc.register('ns', 'ZH', { k: 'v2' })).toThrow('already has locale')
    dispose()
    const t = svc.bind('ns')
    expect(t('k')).toBe('k')
    svc.register('ns', 'zh', { k: 'v2' })
    expect(t('k')).toBe('v2')
    dispose()
    expect(t('k')).toBe('v2')
  })

  it('serves the LocaleFace: snapshot revision moves on switch and registration, subscribers fire, unsubscribe stops them', () => {
    const { svc } = make()
    const seen: number[] = []
    const off = svc.subscribe(() => { seen.push(svc.getSnapshot().revision) })
    expect(svc.getSnapshot()).toBe(svc.getLocale())
    const r0 = svc.getSnapshot().revision
    svc.register('ns', 'zh', { k: 'v' })
    expect(svc.getSnapshot().revision).toBe(r0 + 1)
    svc.setLocale('en')
    expect(seen).toEqual([r0 + 1, r0 + 2])
    off()
    svc.setLocale('zh')
    expect(seen).toHaveLength(2)
  })

  it('isolates a throwing subscriber: the rest still see the new revision', () => {
    const { svc } = make()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const seen: number[] = []
      svc.subscribe(() => { throw new Error('boom') })
      svc.subscribe(() => { seen.push(svc.getSnapshot().revision) })
      svc.setLocale('en')
      expect(seen).toEqual([1])
      expect(spy).toHaveBeenCalledOnce()
    } finally {
      spy.mockRestore()
    }
  })

  it('register disposer republishes (mounted outlets drop the dead dictionary)', () => {
    const { svc } = make()
    const dispose = svc.register('ns', 'zh', { k: 'v' })
    const before = svc.getSnapshot().revision
    dispose()
    expect(svc.getSnapshot().revision).toBe(before + 1)
    // Second run hits the idempotent arm: nothing removed, no republish.
    dispose()
    expect(svc.getSnapshot().revision).toBe(before + 1)
  })

  it('setLocale writes through the scope and republishes only on a real change', () => {
    const host = stubConfigForm<LocaleSettings>()
    const { svc, events } = make(host)
    svc.setLocale('en')
    expect(svc.getLocale().active).toBe('en')
    expect(host.set).toHaveBeenCalledWith('preference', 'en')
    expect(events).toHaveLength(1)
    expect(events[0]).toBe(svc.getLocale())
    expect(events[0]!.revision).toBe(1)
    // Re-selecting the active locale publishes nothing (no subscriber churn)
    // but still writes: the active value may be a provisional browser-derived
    // resolution nothing has stored, and picking it is an explicit choice that
    // must outlive this browser.
    svc.setLocale('en')
    expect(events).toHaveLength(1)
    expect(host.set).toHaveBeenCalledTimes(2)
    expect(host.set).toHaveBeenLastCalledWith('preference', 'en')
  })

  it('persists an explicit pick of the provisional locale, so a shared DSH home agrees', () => {
    // A browser naming no shipped language opens at FALLBACK_LOCALE with
    // nothing stored. Choosing that same language in the menu must become
    // durable, or a Chinese browser sharing the home still opens Chinese.
    stubLanguages('fr-FR')
    const host = stubConfigForm<LocaleSettings>()
    const { svc } = make(host)
    expect(svc.getLocale().active).toBe('en')
    expect(host.set).not.toHaveBeenCalled()
    svc.setLocale('en')
    expect(host.set).toHaveBeenCalledWith('preference', 'en')
  })

  it('setLocale without a host scope stays process-local', () => {
    const { svc, events } = make()
    svc.setLocale('en')
    expect(svc.getLocale().active).toBe('en')
    expect(events).toHaveLength(1)
  })

  it('throws on unknown locale ids', () => {
    const { svc } = make()
    expect(() => { svc.setLocale('fr') }).toThrow('not registered')
  })

  it('registers an external locale for selection, translation, persistence, and reversible disposal', () => {
    const host = stubConfigForm<LocaleSettings>()
    const { svc, events } = make(host)
    svc.register('ns', 'en', { hello: 'Hello' })
    svc.register('ns', 'JA', { hello: 'こんにちは' })
    const dispose = svc.addLanguage({ id: 'ja', label: '日本語', fallback: 'EN' })
    expect(svc.getLocale().locales).toContainEqual({ id: 'ja', label: '日本語', fallback: 'en' })

    svc.setLocale('JA')
    expect(svc.getLocale().active).toBe('ja')
    expect(svc.bind('ns')('hello')).toBe('こんにちは')
    expect(host.set).toHaveBeenCalledWith('preference', 'ja')

    dispose()
    expect(svc.getLocale().active).toBe('zh')
    expect(svc.getLocale().locales.map(locale => locale.id)).toEqual(['zh', 'en'])
    expect(svc.bind('ns')('hello')).toBe('Hello')
    const revision = svc.getLocale().revision
    dispose()
    expect(svc.getLocale().revision).toBe(revision)
    expect(events.map(snapshot => snapshot.active)).toEqual(['ja', 'zh'])
  })

  it('uses fallback copy until a language dictionary registers later', () => {
    const { svc } = make()
    svc.register('ns', 'en', { hello: 'Hello' })
    svc.addLanguage({ id: 'ja', label: '日本語', fallback: 'en' })
    svc.setLocale('ja')
    expect(svc.bind('ns')('hello')).toBe('Hello')

    const revision = svc.getLocale().revision
    svc.register('ns', 'ja', { hello: 'こんにちは' })
    expect(svc.getLocale().revision).toBe(revision + 1)
    expect(svc.bind('ns')('hello')).toBe('こんにちは')
  })

  it('rejects duplicate and malformed locale definitions', () => {
    const { svc } = make()
    expect(() => svc.addLanguage({ id: 'EN', label: 'Other English', fallback: 'en' }))
      .toThrow('already registered')
    expect(() => svc.addLanguage({ id: 'bad locale', label: 'Bad', fallback: 'en' }))
      .toThrow('not a BCP 47-style tag')
    expect(() => svc.addLanguage({ id: '123', label: 'Numeric', fallback: 'en' }))
      .toThrow('not a BCP 47-style tag')
    expect(() => svc.addLanguage({ id: 'fr', label: '   ', fallback: 'en' }))
      .toThrow('label must not be empty')
    expect(() => svc.addLanguage({ id: 'fr', label: 'Français', fallback: 'bad tag' }))
      .toThrow('locale fallback')
    expect(() => svc.addLanguage({ id: 'fr', label: 'Français', fallback: 'de' }))
      .toThrow('not registered')
  })

  it('rejects malformed locale ids before dictionary registration', () => {
    const { svc } = make()
    expect(() => svc.register('ns', 'bad locale', { hello: 'Bad' }))
      .toThrow('not a BCP 47-style tag')
    expect(() => svc.register('ns', '123', { hello: 'Numeric' }))
      .toThrow('not a BCP 47-style tag')
    expect(svc.bind('ns')('hello')).toBe('hello')
  })

  it('walks each language fallback recursively for every dictionary key', () => {
    const { svc } = make()
    svc.register('ns', 'en', { base: 'English', shared: 'English shared' })
    svc.register('ns', 'fr', { shared: 'Français' })
    svc.register('ns', 'fr-CA', { local: 'Québec' })
    svc.register('common', 'en', { commonBase: 'Common English' })
    svc.register('common', 'fr', { commonShared: 'Common French' })
    svc.addLanguage({ id: 'fr', label: 'Français', fallback: 'en' })
    svc.addLanguage({ id: 'fr-CA', label: 'Français (Canada)', fallback: 'fr' })
    svc.setLocale('fr-CA')
    const t = svc.bind('ns')
    expect(t('local')).toBe('Québec')
    expect(t('shared')).toBe('Français')
    expect(t('base')).toBe('English')
    expect(t('commonShared')).toBe('Common French')
    expect(t('commonBase')).toBe('Common English')
  })

  it('rejects a fallback cycle exposed by re-registering an unloaded language', () => {
    const { svc } = make()
    svc.register('ns', 'en', { base: 'English' })
    const removeFr = svc.addLanguage({ id: 'fr', label: 'Français', fallback: 'en' })
    svc.addLanguage({ id: 'fr-CA', label: 'Français (Canada)', fallback: 'fr' })
    svc.setLocale('fr-CA')
    removeFr()
    expect(svc.bind('ns')('base')).toBe('English')
    expect(() => svc.addLanguage({ id: 'de', label: 'Deutsch', fallback: 'fr-CA' }))
      .toThrow('locale fallback "fr" is not registered')
    expect(() => svc.addLanguage({ id: 'fr', label: 'Français', fallback: 'fr-CA' }))
      .toThrow('fallback cycle')
    expect(svc.getLocale().locales.map(locale => locale.id)).toEqual(['zh', 'en', 'fr-CA'])
  })

  it('adopts a saved external locale when its definition registers later', () => {
    const host = stubConfigForm<LocaleSettings>()
    const { svc, events } = make(host)
    host.publish({ status: 'ready', value: { preference: 'ja' }, revision: 1, writable: true })
    expect(svc.getLocale().active).toBe('zh')

    svc.addLanguage({ id: 'ja', label: '日本語', fallback: 'en' })
    expect(svc.getLocale().active).toBe('ja')
    expect(events.map(snapshot => snapshot.active)).toEqual(['ja'])
    expect(host.set).not.toHaveBeenCalled()
  })

  it('adopts a Host preference over the browser language without writing it back', () => {
    const host = stubConfigForm<LocaleSettings>()
    const { svc, events } = make(host)
    host.publish({ status: 'ready', value: { preference: 'en' }, revision: 1, writable: true })
    expect(svc.getLocale().active).toBe('en')
    expect(events).toHaveLength(1)
    expect(host.set).not.toHaveBeenCalled()
    host.publish({ value: { preference: 'en' }, revision: 2 })
    expect(events).toHaveLength(1)
  })

  it('an absent Host preference returns to the browser-derived locale', () => {
    const host = stubConfigForm<LocaleSettings>()
    const { svc } = make(host)
    host.publish({ status: 'ready', value: { preference: 'en' }, revision: 1, writable: true })
    expect(svc.getLocale().active).toBe('en')
    host.publish({ value: {}, revision: 2 })
    expect(svc.getLocale().active).toBe('zh')
  })

  it('adopts a section already standing at construction and releases its subscription on dispose', async () => {
    const host = stubConfigForm<LocaleSettings>()
    host.publish({ status: 'ready', value: { preference: 'en' }, revision: 1, writable: true })
    const { ctx, svc } = make(host)
    expect(svc.getLocale().active).toBe('en')
    expect(host.listenerCount()).toBe(1)
    await ctx.fiber.dispose()
    expect(host.listenerCount()).toBe(0)
  })

  it('opens provisionally in the browser language, matching regional variants on their primary subtag', () => {
    stubLanguages('en-GB', 'zh-CN')
    expect(make().svc.getLocale().active).toBe('en')
    stubLanguages('zh-Hant-TW')
    expect(make().svc.getLocale().active).toBe('zh')
    // An unshipped language walks the list to the first one this app ships.
    stubLanguages('fr-FR', 'en-US')
    expect(make().svc.getLocale().active).toBe('en')
    // Only `language` populated: an empty ordered list, and a host that
    // exposes no `languages` property at all.
    vi.stubGlobal('navigator', { languages: [], language: 'en-US' })
    expect(make().svc.getLocale().active).toBe('en')
    vi.stubGlobal('navigator', { language: 'en-US' })
    expect(make().svc.getLocale().active).toBe('en')
    // No shipped language anywhere in the browser's preferences: en is the
    // product default rather than an arbitrary near-match.
    stubLanguages('fr-FR', 'de')
    expect(make().svc.getLocale().active).toBe('en')
  })

  it('re-evaluates browser languages as external definitions register and unload', () => {
    stubLanguages('pt-BR', 'zh-CN')
    const { svc } = make()
    expect(svc.getLocale().active).toBe('zh')
    const dispose = svc.addLanguage({ id: 'pt-BR', label: 'Português (Brasil)', fallback: 'en' })
    expect(svc.getLocale().active).toBe('pt-BR')
    dispose()
    expect(svc.getLocale().active).toBe('zh')
  })

  it('runs outside a browser (node boots): the default decides and the machine language does not', () => {
    vi.stubGlobal('window', undefined)
    // Node exposes its own global navigator; without a window it must not
    // reach the resolution at all.
    stubLanguages('zh-CN')
    const { svc } = make()
    expect(svc.getLocale().active).toBe('en')
    svc.setLocale('zh')
    expect(svc.getLocale().active).toBe('zh')
  })

  it('lets an explicit in-process preference replace the browser-derived value', () => {
    stubLanguages('en-US')
    const { svc } = make()
    svc.setLocale('zh')
    expect(svc.getLocale().active).toBe('zh')
  })

  it('serves English as both the opening locale and the dictionary fallback', () => {
    // One constant covers both jobs: the locale the UI opens in with no usable
    // browser signal, and the dictionary backing a key the active locale
    // misses. Safe to share only because the shipped zh/en dictionaries carry
    // identical key sets (asserted below on a registered pair).
    expect(FALLBACK_LOCALE).toBe('en')
    vi.stubGlobal('window', undefined)
    const { svc } = make()
    // A key present only in en resolves for a zh reader through the fallback.
    svc.register('ns', 'zh', {})
    svc.register('ns', 'en', { onlyEn: 'English only' })
    svc.setLocale('zh')
    expect(svc.getLocale().active).toBe('zh')
    expect(svc.bind('ns')('onlyEn')).toBe('English only')
    // The reverse no longer resolves: a zh-only key is unreachable from en, so
    // the key itself surfaces (fail loud) rather than silently rendering zh.
    svc.register('ns2', 'zh', { onlyZh: '仅中文' })
    svc.register('ns2', 'en', {})
    svc.setLocale('en')
    expect(svc.bind('ns2')('onlyZh')).toBe('onlyZh')
  })

  it('starts with exactly the two shipped locales and their fallback relation', () => {
    const { svc } = make()
    expect(svc.getLocale().locales).toEqual([
      { id: 'zh', label: '中文', fallback: 'en' },
      { id: 'en', label: 'English' },
    ])
  })
})
