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
  const metrics = declarationsOf(':global([data-conversation-content]), .panel, .dockProbe')
  const clear = px(metrics['--panel-clear'])
  const edge = px(metrics['--panel-edge'])
  const minWidth = px(metrics['--panel-min-width'])
  /** The body's reserve step, evaluated: clamped to 0..1px. */
  const reserveRoom = (reserveMax: number): number => Math.min(1, Math.max(0, (reserveMax - clear - edge - minWidth) * 10000000 + 1))

  it('derives the docked width and the dock probe from one set of metrics', () => {
    expect([clear, edge, minWidth]).toEqual([40, 8, 300])
    const panel = declarationsOf('.panel')
    expect(panel['right']).toBe('var(--panel-edge)')
    expect(panel['width']).toBe(
      'clamp(var(--panel-min-width), calc(var(--dsh-chat-aside-gutter, 0px) - var(--panel-clear) - var(--panel-edge)), 360px)',
    )
    const probe = declarationsOf('.dockProbe')
    expect(probe['width']).toBe(
      'max(calc(var(--dsh-chat-aside-gutter, 0px) - var(--panel-clear) - var(--panel-edge) - var(--panel-min-width) + 1px),'
      + ' var(--dsh-session-panel-reserve-room))',
    )
    expect(probe['max-width']).toBe('1px')
  })

  it('derives the reserve step on the Conversation body, where the non-inherited maximum is readable', () => {
    expect(declarationsOf(':global([data-conversation-content])')).toEqual({
      '--dsh-session-panel-reserve-room': 'clamp(0px,'
        + ' calc((var(--dsh-chat-end-reserve-max, 0px) - var(--panel-clear) - var(--panel-edge) - var(--panel-min-width)) * 10000000 + 1px),'
        + ' 1px)',
    })
    expect(declarationsOf(":global([data-slot='conversation.chat.flow'])")['--dsh-session-panel-reserve-room']).toBe('initial')
    // The aside inherits the computed step when it flips; the message rows keep the initial value.
    expect(css.replace(/\s+/g, ' ')).toContain(
      "@property --dsh-session-panel-reserve-room { syntax: '<length>'; inherits: true; initial-value: 0px; }",
    )
  })

  it('makes the probe 1px wide exactly from the gutter that holds the panel at its minimum width', () => {
    // The declarations above, evaluated: a width below 0 is used as 0, and max-width caps the probe at 1px.
    const probeWidth = (gutter: number, reserveMax = 0): number =>
      Math.min(1, Math.max(0, gutter - clear - edge - minWidth + 1, reserveRoom(reserveMax)))
    const dockedWidth = (gutter: number): number => Math.min(360, Math.max(minWidth, gutter - clear - edge))
    expect([probeWidth(0), probeWidth(347), probeWidth(347.5), probeWidth(348), probeWidth(900)]).toEqual([0, 0, 0.5, 1, 1])
    // At the first gutter that docks, the panel is at its minimum width and keeps both clearances.
    expect(dockedWidth(348)).toBe(minWidth)
    expect(348 - dockedWidth(348) - edge).toBe(clear)
    expect([dockedWidth(377), dockedWidth(500)]).toEqual([329, 360])
  })

  it('gives the probe room as well from the largest end reserve that covers the gutter, whatever the gutter is', () => {
    const probeWidth = (gutter: number, reserveMax: number): number =>
      Math.min(1, Math.max(0, gutter - clear - edge - minWidth + 1, reserveRoom(reserveMax)))
    // A 260px gutter holds no panel, and the transcript can leave 348px: room. This term is a step at 348px, as the
    // body's end inset is, so the probe has room exactly where the body makes it.
    expect([probeWidth(260, 347), probeWidth(260, 347.96), probeWidth(260, 348), probeWidth(260, 900)]).toEqual([0, 0, 1, 1])
    // The same answer once the transcript has made the 348px gutter, so making room does not change the decision.
    expect(probeWidth(348, 348)).toBe(1)
    // An embedded Chat View's body gives no reserve: only its gutter counts.
    expect([probeWidth(347, 0), probeWidth(348, 0)]).toEqual([0, 1])
  })

  it('asks the Conversation body for exactly the gutter that docks the panel while the probe carries the mark', () => {
    const request = declarationsOf(':global([data-conversation-content]):has(.dockProbe[data-session-panel-reserve])')
    expect(request).toEqual({ '--dsh-chat-end-reserve': 'calc(var(--panel-clear) + var(--panel-edge) + var(--panel-min-width))' })
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

describe('SessionPanel.module.css section reordering', () => {
  it('gives a draggable title row the grab cursor and lays the handle over its end, on the More column, without taking room', () => {
    expect(declarationsOf('.head')).toMatchObject({ position: 'relative', cursor: 'var(--section-head-cursor)' })
    // Out of the row's flow: 2px in and 24px wide puts its center 14px from the row's end, the rows' More column.
    expect(declarationsOf('.grip')).toMatchObject({
      'position': 'absolute', 'top': '0', 'right': '2px', 'width': '24px', 'height': '24px',
      'color': 'var(--dsw-alias-label-tertiary)', 'opacity': '0',
    })
    // A mark over the row's end: presses reach the title row, and at rest the trailing content, through it.
    expect(declarationsOf('.grip')['pointer-events']).toBe('none')
  })

  it('shows the handle in place of the trailing content on title-row hover and during a drag', () => {
    expect(declarationsOf('.section[data-dragging] .grip')).toEqual({ opacity: '1' })
    // Hidden, not removed: the trailing content keeps its box, so the title beside it does not move.
    expect(declarationsOf('.section[data-dragging] > .head > .actions')).toEqual({ visibility: 'hidden' })
    // The pointer rules stay inside the hover media query, so a touch that latches hover shows no handle.
    // A title row without a handle, Environment's, keeps its trailing content on hover.
    const hover = [...css.matchAll(/@media \(hover: hover\) \{([\s\S]*?)\n\}/g)].map(block => block[1]).join('\n')
    expect(hover).toMatch(/\.head:hover > \.grip \{\s*opacity: var\(--section-grip-opacity\);/)
    expect(hover).toMatch(/\.head:hover:has\(> \.grip\) > \.actions \{\s*visibility: var\(--section-trailing-visibility\);/)
  })

  it('offers the drag only on a shown section with a handle that has another such section before or after it', () => {
    expect(declarationsOf('.section')).toMatchObject({
      '--section-head-cursor': 'auto', '--section-grip-opacity': '0', '--section-trailing-visibility': 'visible',
    })
    const movable = '.section:has(> .head > .grip)'
      + ':not(:has(> .body > [data-slot]:empty), :has(> .body > [data-slot] > [data-slot]:only-child:empty))'
    // The selector list holds commas of its own, so the rule is read from the stylesheet with its whitespace collapsed.
    const flat = css.replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')')
    expect(flat).toContain(
      `.section:nth-child(n + 2 of ${movable}), .section:nth-last-child(n + 2 of ${movable}) {`
      + ' --section-head-cursor: grab; --section-grip-opacity: 1; --section-trailing-visibility: hidden; }',
    )
  })

  it('plays the entrance and the exit only on a panel that carries the mark, and moves the transcript over the same time and curve', () => {
    const motion = '160ms cubic-bezier(0.4, 0, 0.2, 1)'
    expect(declarationsOf('.panel')['animation']).toBeUndefined()
    expect(declarationsOf(".panel[data-session-panel-motion='enter']")).toEqual({ animation: `dsh-session-panel-enter ${motion}` })
    // The exit holds its last frame until the panel is removed, and a leaving panel takes no presses.
    expect(declarationsOf(".panel[data-session-panel-motion='exit']")).toEqual({
      'animation': `dsh-session-panel-exit ${motion} forwards`, 'pointer-events': 'none',
    })
    expect(declarationsOf(':global([data-conversation-content]):has(.dockProbe[data-session-panel-moving])'))
      .toEqual({ '--dsh-chat-end-reserve-transition': motion })
    // The two keyframes mirror each other: transparent at the scrollport's end edge, the panel's own edge inset away,
    // so the slide never puts the panel past that edge.
    const frames = (name: string): string => (new RegExp(`@keyframes ${name} \\{([\\s\\S]*?)\\n\\}`).exec(css)?.[1] ?? '').replace(/\s+/g, ' ').trim()
    expect(frames('dsh-session-panel-enter'))
      .toBe('from { opacity: 0; transform: translateX(var(--panel-edge)); } to { opacity: 1; transform: translateX(0); }')
    expect(frames('dsh-session-panel-exit'))
      .toBe('from { opacity: 1; transform: translateX(0); } to { opacity: 0; transform: translateX(var(--panel-edge)); }')
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
