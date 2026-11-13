/**
 * Cordis YAML parsing and Loader-entry classification shared by repository checks.
 * @module scripts/cordis-yaml
 */

import { parseEntryYaml } from '@deepseek-ai/cordis-plugin-include'

/** A Loader `!!js` expression preserved as data instead of executed. */
export interface JsExpr {
  __jsExpr: string
}

/**
 * Parse a Cordis config while preserving Loader `!!js` expressions as data.
 * @param source - Cordis YAML source text.
 * @returns the parsed YAML value.
 */
export function loadCordisYaml(source: string): unknown {
  return parseEntryYaml(source)
}

/**
 * Test whether a value is a preserved Loader `!!js` expression.
 * @param value - parsed YAML value.
 * @returns whether the value contains one preserved expression.
 */
export function isJsExpr(value: unknown): value is JsExpr {
  return typeof value === 'object'
    && value !== null
    && typeof (value as Record<string, unknown>).__jsExpr === 'string'
}

/**
 * Test whether a Loader entry owns nested entries in its `config` array.
 * @param value - parsed Loader entry.
 * @returns whether the entry is an explicit or package-named Cordis group.
 */
export function isCordisGroupEntry(value: unknown): value is Record<string, unknown> & { config: unknown[] } {
  return typeof value === 'object'
    && value !== null
    && Array.isArray((value as Record<string, unknown>).config)
    && ((value as Record<string, unknown>).group === true
      || (value as Record<string, unknown>).name === '@deepseek-ai/cordis-plugin-group')
}

/** Test whether an entry declares an Agent preset with a child plugin list.
 * @param value Parsed Loader entry.
 * @returns Whether config.plugins contains nested entries owned by a preset.
 */
export function isAgentPresetEntry(value: unknown): value is Record<string, unknown> & { config: { id: string; plugins: unknown[] } } {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>
  if (row.name !== '@deepseek-ai/dsh-agent-preset' || typeof row.config !== 'object' || row.config === null) return false
  const config = row.config as Record<string, unknown>
  return typeof config.id === 'string' && Array.isArray(config.plugins)
}

/** Read preset definitions nested in ordinary groups and patch insertions.
 * @param value Parsed Cordis YAML.
 * @returns Declared identities and child configurations in document order.
 */
export function presetDefinitions(value: unknown): { id: string; plugins: unknown[] }[] {
  if (Array.isArray(value)) return value.flatMap(presetDefinitions)
  if (isAgentPresetEntry(value)) return [value.config]
  if (typeof value !== 'object' || value === null) return []
  const row = value as Record<string, unknown>
  return [...presetDefinitions(row.insert), ...(isCordisGroupEntry(row) ? presetDefinitions(row.config) : [])]
}
