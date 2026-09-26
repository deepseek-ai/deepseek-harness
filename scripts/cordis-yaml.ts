/**
 * Cordis YAML parsing and Loader-entry classification shared by repository checks.
 * @module scripts/cordis-yaml
 */

import * as yaml from 'js-yaml'

/** A Loader `!!js` expression preserved as data instead of executed. */
export interface JsExpr {
  __jsExpr: string
}

const jsExprType = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: data => typeof data === 'string',
  construct: (data: unknown): JsExpr => {
    if (typeof data !== 'string') throw new TypeError('!!js requires a scalar string')
    return { __jsExpr: data }
  },
})
const schema = yaml.JSON_SCHEMA.extend(jsExprType)

/**
 * Parse a Cordis config while preserving Loader `!!js` expressions as data.
 * @param source - Cordis YAML source text.
 * @returns the parsed YAML value.
 */
export function loadCordisYaml(source: string): unknown {
  return yaml.load(source, { schema })
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
