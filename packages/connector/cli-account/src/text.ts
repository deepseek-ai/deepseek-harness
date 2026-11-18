/** The text a plugin's Plugins page presenter returns, built from the plugin's dictionaries in every language they hold. */
import type { CliAccountDictionaries, CliAccountText } from './types.ts'

/**
 * Bind a plugin's dictionaries into the function its presenter writes text with; the browser resolves the result in its
 * active language.
 * @param dictionaries - the plugin's dictionaries by language, English included.
 * @returns a function that renders one key in every language, replacing each `{name}` with `params[name]` and leaving a
 *   placeholder without a value as written.
 */
export function accountText<Key extends string>(dictionaries: CliAccountDictionaries<Key>): CliAccountText<Key> {
  return (key, params = {}) => {
    const fill = (template: string): string => template.replace(/\{(\w+)\}/g, (placeholder, name: string) => params[name] ?? placeholder)
    const text: Record<string, string> = {}
    for (const [language, dictionary] of Object.entries(dictionaries)) text[language] = fill(dictionary[key])
    return { ...text, en: fill(dictionaries.en[key]) }
  }
}
