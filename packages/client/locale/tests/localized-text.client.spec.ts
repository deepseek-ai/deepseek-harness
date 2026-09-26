import { describe, expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '../src/client/index.ts'

function make() {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  return { ctx, locale: new LocaleRuntime(ctx) }
}

describe('package text resolution', () => {
  it('keeps strings verbatim without common lookup or interpolation', () => {
    const { ctx, locale } = make()
    ctx.effect(() => locale.register('common', 'zh', { retry: '重试' }), 'test: common dictionary')
    locale.setLocale('zh')

    expect(locale.resolveText('retry')).toBe('retry')
    expect(locale.resolveText('Hello, {name}')).toBe('Hello, {name}')
    expect(locale.resolveText('')).toBe('')
    expect(locale.resolveText({ en: 'retry' })).toBe('retry')
  })

  it('resolves each field in the current locale without registering map languages', () => {
    const { locale } = make()
    const title = { en: 'Tools', zh: '工具', ja: 'ツール' }
    locale.setLocale('zh')
    const snapshot = locale.getSnapshot()

    expect(locale.resolveText(title)).toBe('工具')
    expect(locale.resolveText({ en: 'English description' })).toBe('English description')
    expect(locale.resolveText({ en: 'Fallback', zh: '' })).toBe('')
    expect(locale.getSnapshot()).toBe(snapshot)
    expect(snapshot.locales.map(item => item.id)).toEqual(['zh', 'en'])

    locale.setLocale('en')
    expect(locale.resolveText(title)).toBe('Tools')
  })

  it('walks registered regional fallbacks using lowercase map keys', () => {
    const { ctx, locale } = make()
    ctx.effect(() => locale.addLanguage({ id: 'fr', label: 'Français', fallback: 'en' }), 'test: French')
    ctx.effect(() => locale.addLanguage({ id: 'fr-CA', label: 'Français (Canada)', fallback: 'fr' }), 'test: Canadian French')
    locale.setLocale('FR-ca')

    expect(locale.resolveText({ en: 'Tools', fr: 'Outils', 'fr-ca': 'Outils Québec' })).toBe('Outils Québec')
    expect(locale.resolveText({ en: 'Tools', fr: 'Outils' })).toBe('Outils')
    expect(locale.resolveText({ en: 'Tools', zh: '工具' })).toBe('Tools')
  })

  it('uses English across an unloaded fallback and follows its replacement', () => {
    const { ctx, locale } = make()
    const removeFrench = locale.addLanguage({ id: 'fr', label: 'Français', fallback: 'en' })
    ctx.effect(() => removeFrench, 'test: French')
    ctx.effect(() => locale.addLanguage({ id: 'fr-CA', label: 'Français (Canada)', fallback: 'fr' }), 'test: Canadian French')
    locale.setLocale('fr-CA')
    const text = { en: 'Tools', fr: 'Outils' }

    expect(locale.resolveText(text)).toBe('Outils')
    removeFrench()
    expect(locale.resolveText(text)).toBe('Tools')
    ctx.effect(() => locale.addLanguage({ id: 'fr', label: 'Français', fallback: 'en' }), 'test: replacement French')
    expect(locale.resolveText(text)).toBe('Outils')
  })
})
