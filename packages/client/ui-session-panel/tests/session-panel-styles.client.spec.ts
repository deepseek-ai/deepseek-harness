/**
 * The Session panel's stylesheet as CSS text. jsdom has no layout, so the
 * component suite cannot show that each probe is 1px wide exactly from the
 * room it reports, what a pinned panel asks of the Conversation body, or
 * that marked rows get one geometry; this reads the declarations and
 * evaluates the docking ones around their boundaries.
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
  const metrics = declarationsOf('.panel, .dockProbe, .reserveProbe')
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
    expect(declarationsOf('.dockProbe')['width']).toBe(
      'calc(var(--dsh-chat-aside-gutter, 0px) - var(--dsh-chat-end-inset, 0px) * 9999'
      + ' - var(--panel-clear) - var(--panel-edge) - var(--panel-min-width) + 1px)',
    )
    expect(declarationsOf('.reserveProbe')['width']).toBe(
      'calc(var(--dsh-chat-end-reserve-max, 0px) - var(--panel-clear) - var(--panel-edge) - var(--panel-min-width) + 1px)',
    )
    expect(declarationsOf('.dockProbe, .reserveProbe')['max-width']).toBe('1px')
  })

  it('makes the probe 1px wide exactly from the gutter that holds the panel at its minimum width', () => {
    // The declarations above, evaluated: a width below 0 is used as 0, and max-width caps the probe at 1px.
    const probeWidth = (gutter: number, inset = 0): number => Math.min(1, Math.max(0, gutter - inset * 9999 - clear - edge - minWidth + 1))
    const dockedWidth = (gutter: number): number => Math.min(360, Math.max(minWidth, gutter - clear - edge))
    expect([probeWidth(0), probeWidth(347), probeWidth(347.5), probeWidth(348), probeWidth(900)]).toEqual([0, 0, 0.5, 1, 1])
    // At the first gutter that docks, the panel is at its minimum width and keeps both clearances.
    expect(dockedWidth(348)).toBe(minWidth)
    expect(348 - dockedWidth(348) - edge).toBe(clear)
    expect([dockedWidth(377), dockedWidth(500)]).toEqual([329, 360])
  })

  it('leaves a gutter the transcript made to the reserve probe, which is 1px wide exactly from the reserve that docks the panel', () => {
    const probeWidth = (gutter: number, inset: number): number =>
      Math.min(1, Math.max(0, gutter - inset * 9999 - clear - edge - minWidth + 1))
    // The body's end inset made this 348px gutter, so the gutter probe stays at 0, whatever the inset's size.
    expect([probeWidth(348, 285), probeWidth(348, 0.5)]).toEqual([0, 0])
    const reserveWidth = (reserveMax: number): number => Math.min(1, Math.max(0, reserveMax - clear - edge - minWidth + 1))
    expect([reserveWidth(0), reserveWidth(347), reserveWidth(347.5), reserveWidth(348), reserveWidth(900)]).toEqual([0, 0, 0.5, 1, 1])
  })

  it('has a pinned panel ask the Conversation body for exactly the gutter that docks it', () => {
    const request = declarationsOf(':global([data-conversation-content]):has(.dockProbe[data-session-panel-reserve])')
    expect(request).toEqual({ '--dsh-chat-end-reserve': 'calc(40px + 8px + 300px)' })
    expect(40 + 8 + 300).toBe(clear + edge + minWidth)
  })

  it('keeps the probes out of sight, out of the layout flow, and away from the pointer', () => {
    expect(declarationsOf('.dockProbe, .reserveProbe')).toMatchObject({
      'position': 'absolute', 'height': '0', 'visibility': 'hidden', 'pointer-events': 'none',
    })
  })

  it('floats the pin at the panel end on the first title line, clear of the rows under it', () => {
    const pin = declarationsOf('.pin')
    expect(pin).toMatchObject({
      'float': 'inline-end', 'width': '24px', 'height': '24px', 'background': 'transparent', 'color': 'var(--dsw-alias-label-tertiary)',
    })
    // Above the positioned sections, which would otherwise cover a float and take its presses.
    expect(pin).toMatchObject({ 'position': 'relative', 'z-index': '1' })
    // 4px down to the first section's title row, 2px in so the glyph's center is 14px from the rows' end,
    // and a bottom margin that ends the float 4px above the title row's end.
    expect(pin['margin']).toBe('4px 2px -4px 0')
    expect(declarationsOf(".pin[aria-pressed='true']")).toEqual({ color: 'var(--dsw-alias-label-primary)' })
    // The pressed fill follows the hover fill, so a press on a hovered pin shows.
    expect(css.indexOf('.pin:active {')).toBeGreaterThan(css.indexOf('.pin:hover {'))
  })

  it('floats the overlay narrower than the docked panel, at the same edge inset', () => {
    expect(declarationsOf(".panel[data-session-panel='overlay']")['width']).toBe('min(280px, calc(100% - 2 * var(--panel-edge)))')
  })
})

describe('SessionPanel.module.css section reordering', () => {
  it('gives a draggable title row the grab cursor and lays the handle over its end, on the More column, without taking room', () => {
    expect(declarationsOf('.head')['position']).toBe('relative')
    expect(declarationsOf('.head')['cursor']).toBeUndefined()
    expect(declarationsOf(".head[draggable='true']")).toEqual({ cursor: 'grab' })
    // Out of the row's flow: 2px in and 24px wide puts its center 14px from the row's end, the rows' More column.
    expect(declarationsOf('.grip')).toMatchObject({
      'position': 'absolute', 'top': '0', 'right': '2px', 'width': '24px', 'height': '24px',
      'color': 'var(--dsw-alias-label-tertiary)', 'opacity': '0',
    })
  })

  it('shows the handle in place of the trailing content on title-row hover and during a drag', () => {
    expect(declarationsOf('.section[data-dragging] .grip')).toEqual({ opacity: '1' })
    // Hidden, not removed: the trailing content keeps its box, so the title beside it does not move.
    expect(declarationsOf('.section[data-dragging] > .head > .actions')).toEqual({ visibility: 'hidden' })
    // The pointer rules stay inside the hover media query, so a touch that latches hover shows no handle.
    // A title row without a handle, Environment's, keeps its trailing content on hover.
    const hover = [...css.matchAll(/@media \(hover: hover\) \{([\s\S]*?)\n\}/g)].map(block => block[1]).join('\n')
    expect(hover).toMatch(/\.head:hover > \.grip \{\s*opacity: 1;/)
    expect(hover).toMatch(/\.head:hover:has\(> \.grip\) > \.actions \{\s*visibility: hidden;/)
  })

  it('dims the dragged section and draws the landing line on the edge of the section under the pointer', () => {
    expect(declarationsOf('.section')['position']).toBe('relative')
    expect(declarationsOf('.section[data-dragging]')).toEqual({ opacity: '0.5' })
    expect(declarationsOf('.section[data-drop-target]::after')).toMatchObject({
      'position': 'absolute', 'height': '2px', 'background': 'var(--dsw-alias-state-business-primary)', 'pointer-events': 'none',
    })
    expect(declarationsOf(".section[data-drop-target='before']::after")).toEqual({ top: '-1px' })
    expect(declarationsOf(".section[data-drop-target='after']::after")).toEqual({ bottom: '-2px' })
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
    const hover = [...css.matchAll(/@media \(hover: hover\) \{([\s\S]*?)\n\}/g)].map(block => block[1]).join('\n')
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
