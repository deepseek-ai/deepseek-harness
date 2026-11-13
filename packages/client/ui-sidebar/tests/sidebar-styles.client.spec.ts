/** Sidebar shell style contracts shared with its slot-owned controls. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/SidebarRoot.module.css', import.meta.url)), 'utf8')

/**
 * Declarations of one exact selector, keyed by property.
 * @param selector - exact selector text.
 * @returns the normalized declarations, or undefined when absent.
 */
function declarations(selector: string): Map<string, string> | undefined {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, ' ')
  for (const [, selectorList = '', body = ''] of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selectorList.split(',').map(value => value.trim()).includes(selector)) continue
    const found = new Map<string, string>()
    for (const part of body.split(';')) {
      const colon = part.indexOf(':')
      if (colon === -1) continue
      found.set(part.slice(0, colon).trim(), part.slice(colon + 1).trim().replace(/\s+/g, ' '))
    }
    return found
  }
  return undefined
}

/**
 * Every declared selector, including those inside at-rule blocks.
 * @returns the selector text of each comma-separated part.
 */
function declaredSelectors(): string[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, ' ')
  return [...withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .flatMap(([, selectorList = '']) => selectorList.split(',').map(value => value.trim()))
}

/** Declarations of the reduced-motion block, which disables every rail animation. */
function reducedMotion(): string {
  return css.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*)\n\}/u)?.[1] ?? ''
}

/** The renderer's `display: contents` anchor for the sidebar session action HOC slot. */
const SLOT_ANCHOR = ":global([data-slot='sidebar.session.action'])"
/** The shell's New-session button and the occupant's controls: the anchor's children, each matched once. */
const ROW_CONTENT = `.railIn .newSessionRow > ${SLOT_ANCHOR} > *`
/** The rail rule as a plain selector a DOM can match, with the CSS-module escape removed. */
const ROW_CONTENT_SELECTOR = ROW_CONTENT.replace(SLOT_ANCHOR, "[data-slot='sidebar.session.action']")

describe('SidebarRoot.module.css', () => {
  it('uses a compact expanded navigation gap without shrinking the collapsed rail spacing', () => {
    expect(declarations('.panelList')?.get('gap')).toBe('2px')
    expect(declarations('.collapsed .panelList')?.get('gap')).toBe('12px')
  })

  it('fits expanded navigation into 32px rows while retaining 36px rail controls', () => {
    const row = declarations('.panelRow')
    expect(row?.get('min-height')).toBe('32px')
    expect(row?.get('padding')).toBe('5px calc(var(--dsh-sidebar-row-padding) - var(--dsh-sidebar-paint-inset))')
    expect(row?.get('line-height')).toBe('22px')
    expect(row?.get('box-sizing')).toBe('border-box')
    expect(row?.get('border')).toBe('none')
    expect(declarations('.collapsed .panelRow')?.get('width')).toBe('36px')
    expect(declarations('.collapsed .panelRow')?.get('height')).toBe('36px')
    expect(declarations('.collapsed .panelRow')?.get('padding')).toBe('0')
  })

  it('owns a shared scrollport whose gaps scroll away', () => {
    const root = declarations('.root')
    const scrollport = declarations('.scrollArea')
    expect(root?.get('--dsh-sidebar-inline-padding')).toBe('8px')
    expect(root?.get('--dsh-sidebar-row-padding')).toBe('12px')
    expect(root?.get('--dsh-sidebar-label-gap')).toBe('6px')
    expect(root?.get('--dsh-sidebar-paint-inset')).toBe('3px')
    expect(root?.get('padding')).toBe('6px var(--dsh-sidebar-inline-padding)')
    expect(declarations('.scrollRegion')?.get('min-height')).toBe('0')
    expect(declarations('.root:not(.collapsed) .scrollRegion')?.get('container-type')).toBe('size')
    expect(declarations('.scrollRegion')?.get('container-type')).toBeUndefined()
    expect(scrollport?.get('display')).toBe('grid')
    expect(scrollport?.get('overflow-y')).toBe('auto')
    expect(scrollport?.get('overflow-x')).toBe('hidden')
    expect(scrollport?.get('grid-template-columns')).toBe('4px minmax(0, 1fr) calc(var(--dsh-sidebar-inline-padding) - 2px)')
    expect(scrollport?.get('grid-template-rows')).toBe('8px max-content 2px max-content')
    expect(declarations('.scrollRegion')?.get('margin-top')).toBe('4px')
    expect(declarations('.collapsed .scrollRegion')?.get('margin-top')).toBe('0')
    expect(scrollport?.get('margin-left')).toBe('-4px')
    expect(scrollport?.get('margin-right')).toBe('calc(2px - var(--dsh-sidebar-inline-padding))')
    expect(scrollport?.get('scroll-padding-block')).toBeUndefined()
    expect(declarations('.panelList')?.get('grid-row')).toBe('2')
    expect(declarations('.regionArea')?.get('grid-row')).toBe('4')
    expect(declarations('.regionArea')?.get('overflow')).toBeUndefined()
    expect(declarations('.regionArea')?.get('margin-right')).toBeUndefined()
    expect(declarations('.regionArea')?.get('flex')).toBeUndefined()
    expect(declarations('.collapsed .regionArea')?.get('flex')).toBe('1')
    expect(declarations('.collapsed .regionArea')?.get('margin-left')).toBeUndefined()
    expect(declarations('.collapsed .regionArea')?.get('margin-right')).toBeUndefined()
    expect(declarations('.collapsed .regionArea')?.get('padding-left')).toBeUndefined()
    expect(declarations('.scrollFade')?.get('height')).toBe('24px')
    expect(declarations('.collapsed .scrollArea')?.get('overflow')).toBe('visible')
    expect(declarations('.collapsed .scrollArea')?.get('margin')).toBe('0')
  })

  it('hides the expanded viewport scrollbar and publishes its scroll state to the section', () => {
    const expanded = declarations('.root:not(.collapsed) .scrollArea')
    expect(expanded?.get('container-type')).toBe('scroll-state')
    expect(expanded?.get('scrollbar-width')).toBe('none')
    expect(declarations('.root:not(.collapsed) .scrollArea::-webkit-scrollbar')?.get('display')).toBe('none')
  })

  it('keeps the reviewed expanded spacing separate from rail and caption controls', () => {
    expect(declarations('.logoRow')?.get('padding')).toBe('8px 0 8px 8px')
    expect(declarations('.logoRow')?.get('margin-bottom')).toBe('0')
    expect(declarations('.newSessionRow')?.get('margin')).toBe('0 calc(var(--dsh-sidebar-paint-inset) + 1px)')
    expect(declarations('.newSession')?.get('margin')).toBe('0')
    expect(declarations('.newSessionContent')?.get('justify-content')).toBe('center')
    expect(declarations(":global(html[data-platform='darwin']:not([data-fullscreen])) .root:not(.collapsed) > .topStrip > .toggle")?.get('transform')).toBe('translateX(4px)')
    expect(css).not.toContain(':not(.fading)')
    expect(declarations(':global([data-windows-titlebar]) .root:not(.collapsed) .newSessionRow')?.get('margin-top')).toBe('6px')
    expect(declarations(':global([data-windows-titlebar]) .root:not(.collapsed) .newSessionRow')?.has('margin-left')).toBe(false)
    expect(declarations('.topStrip')?.get('height')).toBe('52px')
    expect(declarations('.root.collapsed')?.get('padding')).toBe('18px 10px 6px')
  })

  it('moves the upper controls while the settings seat only fades', () => {
    const animation = 'rail-in 150ms var(--ds-ease-in-out) backwards'
    for (const selector of [
      '.railIn .iconButton',
      ROW_CONTENT,
      '.railIn .regionArea',
    ]) {
      expect(declarations(selector)?.get('animation')).toBe(animation)
    }
    expect(declarations('.railIn .footArea')?.get('animation')).toBe(
      'rail-fade-in 150ms var(--ds-ease-in-out) backwards',
    )
    expect(css).toMatch(
      /@keyframes rail-in\s*\{\s*from\s*\{\s*opacity: 0;\s*transform: translateX\(49px\);\s*}\s*}/,
    )
    expect(css).toMatch(/@keyframes rail-fade-in\s*\{\s*from\s*\{\s*opacity: 0;\s*}\s*}/)
  })

  it('fades the New Session row through its slot anchor without reaching into either button', () => {
    // The row renders its content through the HOC slot, so the renderer's
    // display:contents anchor is the row's only child; the shell's New-session
    // button and the occupant's own controls are the anchor's children.
    expect(declarations(ROW_CONTENT)?.get('animation')).toBe('rail-in 150ms var(--ds-ease-in-out) backwards')
    expect(reducedMotion()).toContain(ROW_CONTENT)
    for (const selector of declaredSelectors()) {
      if (!selector.includes('.newSessionRow')) continue
      // A bare star under the row matches the boxless anchor, so nothing animates.
      expect(selector).not.toMatch(/\.newSessionRow\s*>\s*\*/u)
      // A second bare star step also matches .newSessionLabelMask and
      // .newSessionShortcut inside the button, which would run rail-in twice on it.
      expect(selector).not.toMatch(/>\s*\*\s*>\s*\*/u)
      expect(selector).not.toContain('.newSessionLabelMask')
      expect(selector).not.toContain('.newSessionShortcut')
    }
  })

  it('matches exactly the two buttons the slot anchor holds', () => {
    // The renderer's outlet anchor is a display:contents div; the shell's
    // New-session button and the occupant's control are its element children.
    const { document } = new JSDOM(`
      <div class="railIn">
        <div class="newSessionRow">
          <div data-slot="sidebar.session.action" style="display: contents">
            <button class="newSession">
              <span class="newSessionLabelMask"><span class="newSessionContent"></span></span>
              <span class="newSessionShortcut"></span>
            </button>
            <button class="trigger"></button>
          </div>
        </div>
      </div>`).window
    const matched = [...document.querySelectorAll<HTMLElement>(ROW_CONTENT_SELECTOR)]
    expect(matched.map(element => element.className)).toEqual(['newSession', 'trigger'])
    // A bare child step matches only the boxless anchor, so nothing would animate.
    expect(document.querySelectorAll('.railIn .newSessionRow > *')).toHaveLength(1)
  })

  it('gives shell rail controls the same base anchor for their shared translation', () => {
    expect(declarations('.collapsed .logoRow')?.get('justify-content')).toBe('flex-start')
    expect(declarations('.collapsed .newSessionRow')?.get('align-items')).toBe('flex-start')
    expect(declarations('.collapsed .newSession')?.get('width')).toBe('36px')
  })

  it('keeps full-size brand artwork with a compact mark-to-name gap', () => {
    expect(declarations('.brandIdentity')?.get('gap')).toBe('5px')
    expect(declarations('.brandIdentity')?.get('height')).toBe('24px')
    expect(declarations('.brandName')?.get('height')).toBe('24px')
    expect(declarations('.brandName')?.get('line-height')).toBe('24px')
    expect(declarations('.brandName')?.get('font-size')).toBe('18px')
    expect(declarations('.fallbackBrandName')?.get('font-size')).toBe('17px')
    expect(declarations('.fallbackBrandName')?.get('white-space')).toBe('nowrap')
  })
})
