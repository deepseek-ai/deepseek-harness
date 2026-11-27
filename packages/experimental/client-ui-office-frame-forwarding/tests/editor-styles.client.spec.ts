/** Native Office layout fills the pane around the transparent content rectangle. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/Editor.module.css', import.meta.url)), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)}/g)].map(match => ({
  selector: match[1]!.trim(),
  declarations: match[2]!.trim().replace(/\s+/g, ' '),
}))
function declarations(selector: string): string {
  return rules.find(rule => rule.selector === selector)?.declarations ?? ''
}

describe('Editor.module.css native layout', () => {
  it('fills the document area with a flush sheet and only internal header dividers', () => {
    expect(declarations('.editor')).toContain('height: 100%;')
    expect(declarations('.editor')).toContain('flex-direction: column;')
    expect(declarations('.documentArea')).toContain('flex: 1;')
    expect(declarations('.documentArea')).toContain('min-height: 0;')
    expect(declarations('.sheet')).toContain('display: grid;')
    expect(declarations('.sheet')).toContain('grid-template-columns: 42px minmax(0, 1fr);')
    expect(declarations('.sheet')).toContain('grid-template-rows: 22px minmax(0, 1fr);')
    for (const selector of ['.editor', '.viewMount', '.documentArea', '.sheet']) {
      expect(declarations(selector), selector).not.toMatch(/(?:^|; )(?:margin[^:]*|padding[^:]*|border[^:]*|(?:row-|column-)?gap):/)
    }
    expect(declarations('.headerCorner, .columnHeaders button, .rowHeaders button')).toContain('border-radius: 0;')
    expect(declarations('.headerCorner, .columnHeaders')).toBe('border-bottom: 0.5px solid var(--dsw-alias-border-l3);')
    expect(declarations('.headerCorner, .rowHeaders')).toBe('border-right: 0.5px solid var(--dsw-alias-border-l3);')
  })

  it('retains document overlay levels and sheet header colors', () => {
    expect(declarations('.surface')).toContain('z-index: 1;')
    expect(declarations('.canvas')).toContain('z-index: 1;')
    expect(declarations('.pageGaps')).toContain('z-index: 1;')
    expect(declarations('.pagePreviews')).toContain('z-index: 2;')
    expect(declarations('.pageLoading')).toContain('z-index: 3;')
    expect(declarations('.painting')).toContain('z-index: 3;')
    expect(declarations('.playbackControls')).toContain('z-index: 2;')
    expect(declarations('.headerCorner, .columnHeaders, .rowHeaders')).toContain('background: var(--dsw-alias-bg-layer-1);')
    expect(declarations('.viewport')).toContain('overflow: auto;')
  })

})
