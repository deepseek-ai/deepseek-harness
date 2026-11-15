/**
 * The Session panel's stylesheet as CSS text. jsdom has no layout, so the
 * component suite cannot show that the dock probe is 1px wide exactly from
 * the gutter that holds the docked panel, or that marked rows get one
 * geometry; this reads the declarations and evaluates the docking ones for
 * gutters around that boundary.
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

describe('SessionPanel.module.css row rules', () => {
  /** A rule for marked row markup: `.panel :where(<row selector>)<tail>`. */
  const row = (inner: string, tail = ''): Record<string, string> => declarationsOf(`.panel :where(${inner})${tail}`)

  it('lays a marked row out as one 28px line with the icon and the menu on fixed columns', () => {
    expect(row('[data-session-panel-row]')).toMatchObject({
      'display': 'flex', 'align-items': 'center', 'gap': '8px', 'min-height': '28px', 'padding': '0 6px',
    })
    expect(row("[data-session-panel-row] > [data-row-part='body']")).toMatchObject({ flex: '1 1 auto', height: '28px', gap: '8px' })
    // 6px of padding and half of the 16px box put the icon's center 14px from the row's start, and the menu's from its end.
    expect(row("[data-session-panel-row] [data-row-part='icon']")).toMatchObject({ width: '16px', height: '16px', flex: 'none' })
    expect(row("[data-session-panel-row] > [data-row-part='menu']")).toMatchObject({ 'width': '16px', 'justify-content': 'center' })
    expect(row("[data-session-panel-row] [data-row-part='content']")).toMatchObject({
      'overflow': 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap',
    })
  })

  it('grows a row with a detail line and keeps the icon level with the first line', () => {
    const tall = "[data-session-panel-row] > [data-row-part='body']:has([data-row-part='detail'])"
    expect(row(tall)).toEqual({ 'align-items': 'flex-start', 'height': 'auto', 'padding': '4px 0' })
    expect(row(`${tall} > [data-row-part='icon']`)).toEqual({ height: '20px' })
    expect(row("[data-session-panel-row] [data-row-part='lines']")).toMatchObject({ 'display': 'flex', 'flex-direction': 'column', 'min-width': '0' })
    expect(row("[data-session-panel-row] [data-row-part='detail']")).toMatchObject({
      'color': 'var(--dsw-alias-label-tertiary)', 'font-size': '12px', 'line-height': '17px', 'text-overflow': 'ellipsis', 'white-space': 'nowrap',
    })
    // The two-line rules follow the one-line ones they adjust, since every rule for a part has the same specificity.
    const order = (selector: string): number => {
      const at = css.indexOf(`.panel :where(${selector}) {`)
      expect(at).toBeGreaterThan(-1)
      return at
    }
    expect(order(tall)).toBeGreaterThan(order("[data-session-panel-row] > button[data-row-part='body']"))
    expect(order(`${tall} > [data-row-part='icon']`)).toBeGreaterThan(order("[data-session-panel-row] [data-row-part='icon']"))
  })

  it('makes a button body the action of the whole row and rings the row when it has keyboard focus', () => {
    expect(row("[data-session-panel-row] > button[data-row-part='body']", '::after')).toMatchObject({ position: 'absolute', inset: '0' })
    expect(row("[data-session-panel-row] > [data-row-part='trailing'], [data-session-panel-row] > [data-row-part='menu']"))
      .toMatchObject({ 'position': 'relative', 'z-index': '1' })
    expect(row("[data-session-panel-row]:has(> button[data-row-part='body']:focus-visible)")['outline-offset']).toBe('-2px')
  })

  it('gives a plain button in the menu a 24px target and a tertiary glyph without a fill', () => {
    expect(row("[data-session-panel-row] > [data-row-part='menu']", ' button')).toMatchObject({
      width: '24px', height: '24px', margin: '-4px', background: 'transparent', color: 'var(--dsw-alias-label-tertiary)',
    })
  })

  it('highlights only a row with an action or a menu that renders something, and keeps an open menu and its row shown', () => {
    const interactive = "[data-session-panel-row]:has(> button[data-row-part='body'], > [data-row-part='menu']:not(:empty))"
    expect(row("[data-session-panel-row] > [data-row-part='menu']:empty")).toEqual({ display: 'none' })
    // Only an open control in the menu part keeps the row highlighted; an expanded body button does not.
    expect(row("[data-session-panel-row]:has(> [data-row-part='menu'] [aria-expanded='true'])"))
      .toEqual({ background: 'var(--dsw-alias-interactive-bg-hover)' })
    expect(css).not.toMatch(/:has\(\[aria-expanded='true'\]\)\)\s*\{\s*background/)
    expect(row("[data-session-panel-row] > [data-row-part='menu']:has([aria-expanded='true'])")['opacity']).toBe('1')
    // Hover rules stay inside the hover media query, where the menu hides until the row is hovered or focused.
    const hover = /@media \(hover: hover\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? ''
    expect(hover).toContain(`.panel :where(${interactive}:hover)`)
    expect(hover).toMatch(/\[data-row-part='menu'\]\) \{\s*opacity: 0;/)
    expect(css.replace(/@media \(hover: hover\) \{[\s\S]*?\n\}/g, '')).not.toContain(':hover')
  })

  it('sets a fold control in the quiet type of the section counts with a 14px chevron, darker on hover and keyboard focus', () => {
    const fold = "[data-session-panel-row='fold']"
    expect(row(fold)).toEqual({
      'color': 'var(--dsw-alias-label-tertiary)', 'font': 'var(--dsw-font-xxs-12)', 'font-variant-numeric': 'tabular-nums',
    })
    expect(row(`${fold} [data-row-part='icon']`, ' svg')).toEqual({ width: '14px', height: '14px' })
    expect(row(`${fold}:has(> button:focus-visible)`)).toEqual({ color: 'var(--dsw-alias-label-secondary)' })
    expect(row(`${fold}:hover`)).toEqual({ color: 'var(--dsw-alias-label-secondary)' })
    // The fold rules follow the row rules they adjust, since every rule for a part has the same specificity.
    const at = (selector: string, tail = ''): number => {
      const index = css.indexOf(`.panel :where(${selector})${tail} {`)
      expect(index).toBeGreaterThan(-1)
      return index
    }
    expect(at(fold)).toBeGreaterThan(at('[data-session-panel-row]'))
    expect(at(`${fold} [data-row-part='icon']`, ' svg')).toBeGreaterThan(at("[data-session-panel-row] [data-row-part='icon']", ' svg'))
  })
})
