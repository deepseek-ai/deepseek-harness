// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { describe, expect, it } from 'vitest'
import { dictionaries, en } from '../src/client/locales.ts'

describe('Timeline labels', () => {
  it('registers all dictionaries without changing its language selector', async () => {
    const ctx = new Context()
    const locale = new LocaleRuntime(ctx, undefined, { languages: ['en'], preference: null })
    try {
      const before = locale.getSnapshot().locales.map(item => item.id)
      const off = locale.register('timeline', dictionaries)
      expect(locale.getSnapshot().locales.map(item => item.id)).toEqual(before)
      expect(before).toEqual(['zh', 'en'])
      expect(locale.bind('timeline')('title')).toBe(en.title)
      off()
      expect(locale.bind('timeline')('title')).toBe('title')
    } finally {
      await ctx.fiber.dispose()
    }
  })
  it('resolves all eight app languages, preserves placeholders, and follows external fallback chains', async () => {
    const ctx = new Context()
    const locale = new LocaleRuntime(ctx, undefined, { languages: ['en'], preference: null })
    try {
      const stop = locale.register('timeline', dictionaries)
      for (const id of ['ja', 'es', 'fr', 'de', 'ru', 'pt'])
        locale.addLanguage({ id, label: id, fallback: 'en' })
      for (const [id, dictionary] of Object.entries(dictionaries)) {
        expect(Object.keys(dictionary).sort()).toEqual(Object.keys(en).sort())
        locale.setLocale(id)
        expect(locale.bind('timeline')('title')).toBe(dictionary.title)
        expect(locale.bind('timeline')('levelSummary', { level: 2, period: '1h' })).not.toMatch(
          /\{(?:level|period)\}/u,
        )
        for (const key of ['completedWork', 'activeWork', 'pendingWork', 'blockedWork'] as const) {
          const text = locale.bind('timeline')(key, { count: 2, percent: '29.48' })
          expect(text).toContain('2')
          expect(text).toContain('29.48')
          expect(text).not.toMatch(/\{(?:count|percent)\}/u)
        }
      }
      locale.addLanguage({ id: 'it', label: 'Italiano', fallback: 'fr' })
      locale.setLocale('it')
      expect(locale.bind('timeline')('title')).toBe(dictionaries.fr.title)
      stop()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
