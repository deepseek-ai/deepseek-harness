/** Official plugin display metadata and artwork stay reviewable without native rendering. */
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

it('presents the preinstalled Desktop experiment with its document artwork', () => {
  const locales = Object.fromEntries(['en', 'zh', 'ja', 'es', 'fr', 'de', 'ru', 'pt'].map((locale) => {
    const metadata: unknown = JSON.parse(readFileSync(new URL(`../locale/${locale}.json`, import.meta.url), 'utf8'))
    return [locale, metadata]
  }))
  const icon = readFileSync(new URL('../icon.svg', import.meta.url), 'utf8')
  expect({ ...locales, icon }).toMatchSnapshot()
})
