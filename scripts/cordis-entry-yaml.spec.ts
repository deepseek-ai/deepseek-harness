/** Include's YAML dialect exports used by DSH configuration tools. */
import { entryYamlErrorPosition, parseEntryYaml, stringifyEntryYaml } from '@deepseek-ai/cordis-plugin-include'
import { describe, expect, it } from 'vitest'

describe('Include YAML dialect', () => {
  it('reads and writes !!js scalars as expression nodes', () => {
    const source = '- id: a\n  name: example\n  disabled: !!js process.env.OFF\n'
    const parsed = parseEntryYaml(source)
    expect(parsed).toEqual([{ id: 'a', name: 'example', disabled: { __jsExpr: 'process.env.OFF' } }])
    expect(stringifyEntryYaml(parsed)).toBe(source)
  })

  it('reads binary integers as numbers and dates as strings', () => {
    expect(parseEntryYaml('- 0b101\n- 2001-01-01\n- ~\n')).toEqual([5, '2001-01-01', null])
    expect(parseEntryYaml('')).toBeUndefined()
  })

  it('writes repeated references in full', () => {
    const shared = { value: 1 }
    expect(stringifyEntryYaml([{ config: shared }, { config: shared }])).toBe('- config:\n    value: 1\n- config:\n    value: 1\n')
  })

  it('folds long scalars at the requested line width', () => {
    const value = [{ text: Array.from({ length: 20 }, (_, index) => `word${String(index)}`).join(' ') }]
    expect(stringifyEntryYaml(value).split('\n').length).toBeGreaterThan(2)
    expect(stringifyEntryYaml(value, { lineWidth: -1 }).split('\n')).toHaveLength(2)
  })

  it('locates parse errors', () => {
    let error: unknown
    try {
      parseEntryYaml('- id: a\n  name: [\n')
    } catch (caught) {
      error = caught
    }
    expect(entryYamlErrorPosition(error)).toEqual({ line: 3, column: 1 })
    expect(entryYamlErrorPosition(new Error('other'))).toBeUndefined()
  })
})
