/**
 * PanelRow's two-line geometry as CSS text: the component suite sees CSS
 * Modules as class-name maps, so only the stylesheet proves that a detail line
 * grows the row while the icon stays level with the first line.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/PanelRow.module.css', import.meta.url)), 'utf8')

function declarations(selector: string): Map<string, string> {
  const found = new Map<string, string>()
  for (const [, selectorList = '', body = ''] of css.replace(/\/\*[\s\S]*?\*\//g, ' ').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selectorList.split(',').map(value => value.trim()).includes(selector)) continue
    for (const part of body.split(';')) {
      const colon = part.indexOf(':')
      if (colon !== -1) found.set(part.slice(0, colon).trim(), part.slice(colon + 1).trim().replace(/\s+/g, ' '))
    }
  }
  return found
}

describe('PanelRow.module.css', () => {
  it('grows a row with a detail line and keeps the icon in the first line', () => {
    const body = declarations('.tall .body')
    expect([body.get('height'), body.get('align-items'), body.get('padding')]).toEqual(['auto', 'flex-start', '4px 0'])
    expect(declarations('.tall .icon').get('height')).toBe('20px')
  })

  it('sets the detail line in clipped tertiary 12px type', () => {
    const detail = declarations('.detail')
    expect([detail.get('color'), detail.get('font-size'), detail.get('line-height'), detail.get('text-overflow'), detail.get('white-space')])
      .toEqual(['var(--dsw-alias-label-tertiary)', '12px', '17px', 'ellipsis', 'nowrap'])
  })
})
