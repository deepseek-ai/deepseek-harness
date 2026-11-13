/**
 * The Session panel's docking geometry as CSS text. jsdom has no layout, so
 * the component suite cannot show that the dock probe is 1px wide exactly
 * from the gutter that holds the docked panel; this reads the declarations
 * and evaluates them for gutters around that boundary.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/SessionPanel.module.css', import.meta.url)), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')

/** Declarations of the rule with exactly this selector list, with whitespace collapsed. */
function declarationsOf(selector: string): Record<string, string> {
  const pattern = selector.split(',').map(part => part.trim().replace(/[.[\]():*+^$\\'=]/g, '\\$&')).join('\\s*,\\s*')
  const rule = new RegExp(`(?:^|[{}])\\s*${pattern}\\s*\\{([^{}]*)\\}`).exec(css)
  if (rule === null) throw new Error(`SessionPanel.module.css has no \`${selector}\` rule`)
  const entries = (rule[1] ?? '').split(';').map(part => part.trim()).filter(Boolean).map((part): [string, string] => {
    const colon = part.indexOf(':')
    return [part.slice(0, colon).trim(), part.slice(colon + 1).replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')').trim()]
  })
  return Object.fromEntries(entries)
}

const px = (value: string | undefined): number => {
  const match = /^(-?\d+(?:\.\d+)?)px$/.exec(value ?? '')
  if (match === null) throw new Error(`not a px length: ${String(value)}`)
  return Number(match[1])
}

describe('SessionPanel.module.css docking geometry', () => {
  const metrics = declarationsOf('.panel, .dockProbe')
  const clear = px(metrics['--panel-clear'])
  const edge = px(metrics['--panel-edge'])
  const minWidth = px(metrics['--panel-min-width'])

  it('derives the docked width and the dock probe from one set of metrics', () => {
    expect([clear, edge, minWidth]).toEqual([40, 8, 300])
    const panel = declarationsOf('.panel')
    expect(panel['right']).toBe('var(--panel-edge)')
    expect(panel['width']).toBe(
      'clamp(var(--panel-min-width), calc(var(--dsh-chat-aside-gutter, 0px) - var(--panel-clear) - var(--panel-edge)), 360px)',
    )
    const probe = declarationsOf('.dockProbe')
    expect(probe['width']).toBe(
      'calc(var(--dsh-chat-aside-gutter, 0px) - var(--panel-clear) - var(--panel-edge) - var(--panel-min-width) + 1px)',
    )
    expect(probe['max-width']).toBe('1px')
  })

  it('makes the probe 1px wide exactly from the gutter that holds the panel at its minimum width', () => {
    // The declarations above, evaluated: a width below 0 is used as 0, and max-width caps the probe at 1px.
    const probeWidth = (gutter: number): number => Math.min(1, Math.max(0, gutter - clear - edge - minWidth + 1))
    const dockedWidth = (gutter: number): number => Math.min(360, Math.max(minWidth, gutter - clear - edge))
    expect([probeWidth(0), probeWidth(347), probeWidth(347.5), probeWidth(348), probeWidth(900)]).toEqual([0, 0, 0.5, 1, 1])
    // At the first gutter that docks, the panel is at its minimum width and keeps both clearances.
    expect(dockedWidth(348)).toBe(minWidth)
    expect(348 - dockedWidth(348) - edge).toBe(clear)
    expect([dockedWidth(377), dockedWidth(500)]).toEqual([329, 360])
  })

  it('keeps the probe out of sight, out of the layout flow, and away from the pointer', () => {
    expect(declarationsOf('.dockProbe')).toMatchObject({
      'position': 'absolute', 'height': '0', 'visibility': 'hidden', 'pointer-events': 'none',
    })
  })

  it('floats the overlay narrower than the docked panel, at the same edge inset', () => {
    expect(declarationsOf(".panel[data-session-panel='overlay']")['width']).toBe('min(280px, calc(100% - 2 * var(--panel-edge)))')
  })
})
