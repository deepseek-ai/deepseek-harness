/** Per-language JSON resources shared by NSIS packaging, native UI tests and the i18n check. */
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const defaultDirectory = fileURLToPath(new URL('../installer/locales/', import.meta.url))

/**
 * Read and validate installer translations before generating compiler input.
 * @param {string} directory - Directory containing one JSON file per installer language.
 * @returns {{id: string, nsisLanguage: string, strings: Record<string, string>, uninstaller: Record<string, string>}[]} Complete language resources.
 */
export function readInstallerLocales(directory = defaultDirectory) {
  const locales = readdirSync(directory).filter(name => name.endsWith('.json')).sort((a, b) =>
    a === 'en_US.json' ? -1 : b === 'en_US.json' ? 1 : a.localeCompare(b)).map(name => {
    if (!/^[a-z]{2}_[A-Z]{2}\.json$/u.test(name)) throw new Error(`${name}: invalid installer language filename`)
    /** @type {unknown} */
    const resource = JSON.parse(readFileSync(`${directory}/${name}`, 'utf8'))
    if (typeof resource !== 'object' || resource === null || !('nsisLanguage' in resource)
      || typeof resource.nsisLanguage !== 'string' || !/^[A-Z]+$/u.test(resource.nsisLanguage)) {
      throw new Error(`${name}: invalid NSIS language identifier`)
    }
    /** @param {unknown} value - Parsed JSON dictionary. @returns {Record<string, string>} Nonempty text values. */
    const dictionary = (value) => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${name}: expected text dictionary`)
      /** @type {Record<string, string>} */
      const result = {}
      for (const [key, text] of Object.entries(value)) {
        if (typeof text !== 'string' || text.trim() === '') throw new Error(`${name}: ${key} must be nonempty text`)
        if (/[\u200b\ufeff]/u.test(text)) throw new Error(`${name}: ${key} contains an invisible locale character`)
        result[key] = text
      }
      return result
    }
    const strings = dictionary('strings' in resource ? resource.strings : undefined)
    if (Object.keys(strings).some(key => !/^INSTALLER_[A-Z_]+$/u.test(key))) throw new Error(`${name}: invalid installer string key`)
    return { id: name.slice(0, -5), nsisLanguage: resource.nsisLanguage, strings,
      uninstaller: dictionary('uninstaller' in resource ? resource.uninstaller : undefined) }
  })
  for (const id of ['en_US', 'zh_CN', 'ja_JP', 'es_ES', 'fr_FR', 'de_DE', 'ru_RU', 'pt_BR']) {
    if (!locales.some(locale => locale.id === id)) throw new Error(`installer locales: missing ${id}.json`)
  }
  const english = locales.find(locale => locale.id === 'en_US')
  if (!english || Object.keys(english.strings).length === 0) throw new Error('installer locales: missing English strings')
  if (Object.keys(english.uninstaller).sort().join(',') !== 'finished,welcome') throw new Error('installer locales: expected uninstaller welcome and finished text')
  const languages = new Set()
  for (const locale of locales) {
    if (languages.has(locale.nsisLanguage)) throw new Error(`${locale.id}: duplicate NSIS language ${locale.nsisLanguage}`)
    languages.add(locale.nsisLanguage)
    for (const field of ['strings', 'uninstaller']) {
      const expected = english[field]
      const actual = locale[field]
      if (Object.keys(expected).sort().join(',') !== Object.keys(actual).sort().join(',')) throw new Error(`${locale.id}: ${field} keys differ from English`)
      for (const [key, text] of Object.entries(expected)) {
        const placeholders = (/** @type {string} */ value) => (value.match(/%.?|(?<![A-Za-z0-9/])\/[A-Z][A-Z_]*(?:=[\w-]+)?/gu) ?? []).join(',')
        if (placeholders(text) !== placeholders(actual[key])) throw new Error(`${locale.id}: ${key} changes format placeholders or commands`)
      }
    }
  }
  return locales
}

/**
 * Generate guarded NSIS LangString declarations from validated JSON resources.
 * @param {ReturnType<typeof readInstallerLocales>} locales - Resources for all languages or one isolated native-test build.
 * @returns {string} UTF-8 NSIS source, with literal dollar signs, quotes and line breaks escaped.
 */
export function renderInstallerStrings(locales) {
  const escape = (/** @type {string} */ text) => text.replace(/\$|"|\r|\n/gu, character => ({ '$': '$$', '"': '$\\"', '\r': '$\\r', '\n': '$\\n' })[character])
  return '; Generated from installer/locales/*.json.\n' + locales.map(locale =>
    `!ifdef LANG_${locale.nsisLanguage}\n` + Object.entries(locale.strings).map(([key, text]) =>
      `LangString ${key} \${LANG_${locale.nsisLanguage}} "${escape(text)}"\n`).join('') + '!endif\n').join('')
}

if (import.meta.main) {
  const locales = readInstallerLocales()
  console.log(`verify-installer-locales: ${locales.length} languages have matching keys and format placeholders.`)
}
