import { SHIPPED_LOCALE_IDS } from '../../../scripts/shipped-locales.ts'
import { describe, expect, it } from 'vitest'
import { en, formatDesktopMessage, resolveDesktopLocale, resolveDesktopStartupLocale, ja, zh, es, fr, de, ru, pt } from '../src/locale.ts'

describe('desktop locale dictionaries', () => {
  it('ships baseline and Japanese keys and falls back for unsupported languages', () => {
    expect(Object.keys(zh)).toEqual(Object.keys(en))
    expect(Object.keys(ja)).toEqual(Object.keys(en))
    expect(resolveDesktopLocale('JA-jp')).toEqual({ id: 'ja', messages: ja })
    expect(resolveDesktopLocale('zh-Hans-CN').messages).toEqual(zh)
    expect(resolveDesktopLocale('en-US').messages).toEqual(en)
    expect(resolveDesktopLocale('it-IT').messages).toEqual(en)
  })

  it.each([
    ['es', 'es-MX', es], ['fr', 'fr-CA', fr], ['de', 'de-DE', de],
    ['ru', 'ru-RU', ru], ['pt', 'pt-BR', pt],
  ] as const)('resolves %s, preserves placeholders, and honors saved preferences', (id, tag, messages) => {
    expect(resolveDesktopLocale(tag.toUpperCase())).toEqual({ id, messages })
    expect(resolveDesktopStartupLocale(id, ['zh-CN']).id).toBe(id)
    expect(resolveDesktopStartupLocale(null, ['it-IT', tag, 'en-US']).id).toBe(id)
    expect(Object.keys(messages)).toEqual(Object.keys(en))
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      const placeholders = (text: string): string[] => (text.match(/\{\w+\}/gu) ?? []).sort()
      expect(placeholders(messages[key]), key).toEqual(placeholders(en[key]))
    }
  })

  it.each(SHIPPED_LOCALE_IDS)('resolves every shipped language %s without fallback', (id) => {
    expect(resolveDesktopLocale(id).id).toBe(id === 'zh' ? 'zh-CN' : id)
    expect(resolveDesktopStartupLocale(null, [id]).id).toBe(id === 'zh' ? 'zh-CN' : id)
  })

  it('formats named values without consuming unknown placeholders', () => {
    expect(formatDesktopMessage('{name}@{version} {missing}', { name: 'plugin', version: '1.2.3' }))
      .toBe('plugin@1.2.3 {missing}')
  })

  it('prefers an explicit supported choice, then the first supported system language', () => {
    expect(resolveDesktopStartupLocale('zh', ['en-US']).id).toBe('zh-CN')
    expect(resolveDesktopStartupLocale('EN', ['zh-CN']).id).toBe('en')
    expect(resolveDesktopStartupLocale(null, ['ja-JP', 'zh-Hant', 'en-US']).id).toBe('ja')
    expect(resolveDesktopStartupLocale(null, ['en-US', 'zh-CN']).id).toBe('en')
    expect(resolveDesktopStartupLocale(null, ['ja-JP']).id).toBe('ja')
    expect(resolveDesktopStartupLocale(null, []).id).toBe('en')
    expect(resolveDesktopStartupLocale('ja', ['zh-CN']).id).toBe('ja')
  })

})
