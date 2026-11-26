/** Sidebar shell style contracts shared with its slot-owned controls. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { transform } from 'lightningcss'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/SidebarRoot.module.css', import.meta.url)), 'utf8')

/**
 * Split a selector list at its top-level commas, keeping commas inside `:is()`, `:where()` and `:not()`.
 * @param list - selector list text.
 * @returns the trimmed complex selectors.
 */
function selectorsOf(list: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = 0
  for (let index = 0; index < list.length; index++) {
    const char = list[index]
    if (char === '(') depth++
    else if (char === ')') depth--
    else if (char === ',' && depth === 0) {
      out.push(list.slice(start, index).trim())
      start = index + 1
    }
  }
  out.push(list.slice(start).trim())
  return out
}

/**
 * Declarations of one exact selector, keyed by property.
 * @param selector - exact selector text.
 * @returns the normalized declarations, or undefined when absent.
 */
function declarations(selector: string): Map<string, string> | undefined {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, ' ')
  for (const [, selectorList = '', body = ''] of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selectorsOf(selectorList).includes(selector)) continue
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

/** Declarations of the reduced-motion block, which disables every sidebar transition. */
function reducedMotion(): string {
  return css.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*)\n\}/u)?.[1] ?? ''
}

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
    expect(declarations('.newSessionRow')?.get('margin')).toBe('0 calc(var(--dsh-sidebar-paint-inset) + 1px) 6px')
    expect(declarations('.newSession')?.get('margin')).toBe('0')
    expect(declarations('.newSessionContent')?.get('justify-content')).toBe('center')
    expect(declarations(":global(html[data-platform='darwin']:not([data-fullscreen])) .root:not(.collapsed) > .topStrip > .toggle")?.get('transform')).toBe('translateX(4px)')
    expect(css).not.toContain(':not(.fading)')
    expect(declarations(':global([data-windows-titlebar]) .root:not(.collapsed) .newSessionRow')?.get('margin-top')).toBe('6px')
    expect(declarations(':global([data-windows-titlebar]) .root:not(.collapsed) .newSessionRow')?.has('margin-left')).toBe(false)
    expect(declarations('.topStrip')?.get('height')).toBe('52px')
    expect(declarations('.root.collapsed')?.get('padding')).toBe('18px 10px 6px')
  })

  it('fades macOS control colors and the scroll fade between windowed and fullscreen materials', () => {
    const darwin = ":global([data-platform='darwin'])"
    const windowed = ":global([data-platform='darwin']:not([data-fullscreen]))"
    const root = ":where(.root:not([role='dialog']))"
    expect(declarations(`${windowed} ${root} .newSession`)?.get('background')).toBe('var(--dsw-specific-sidebar-glass-fill)')
    expect(declarations(`${windowed} ${root}.collapsed .newSession`)?.get('background')).toBe('var(--dsw-specific-sidebar-glass-collapsed-fill)')
    expect(declarations(`${darwin} ${root} .newSession`)?.get('transition')).toBe(
      'background-color var(--ds-transition-duration) var(--ds-ease-in-out)',
    )
    expect(declarations(`${darwin} .scrollFade`)?.get('transition')).toBe(
      'opacity var(--ds-transition-duration) var(--ds-ease-in-out)',
    )
    expect(declarations(`${darwin} .scrollFade`)?.get('opacity')).toBe('1')
    expect(declarations(`${windowed} .scrollFade`)?.get('opacity')).toBe('0')
    expect(declarations(`${windowed} .scrollFade`)?.has('display')).toBe(false)
    expect(declarations('.collapsed .scrollFade')?.get('display')).toBe('none')
    expect(reducedMotion()).toContain(`${darwin} ${root} .newSession`)
    expect(reducedMotion()).toContain(`${darwin} .scrollFade`)
    expect(reducedMotion()).toContain('transition: none;')
  })

  it('moves the upper controls while the settings seat only fades', () => {
    const animation = 'rail-in 150ms var(--ds-ease-in-out) backwards'
    for (const selector of ['.railIn .iconButton', '.railIn .regionArea']) {
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

  it('animates the session action outputs through HOC outlets but not their contents, except where motion is disabled', () => {
    const sheet = transform({ filename: 'SidebarRoot.module.css', code: Buffer.from(css), cssModules: { pattern: '[local]' } }).code.toString()
    const slot = 'sidebar.session.action'
    const row = (content: string) => `<div class="newSessionRow"><div data-slot="${slot}" style="display:contents">${content}</div></div>`
    const outlet = (content: string) => `<div data-slot-children="${slot}" style="display:contents">${content}</div>`
    const owner = `<button class="newSession"><span class="newSessionLabelMask"><span class="newSessionContent"><svg></svg></span></span>
      <span class="newSessionShortcut"></span></button>`
    const trigger = '<button class="import"><svg></svg></button><span class="tooltip" role="tooltip">Import</span>'
    const link = '<a class="link" href="/"><span>Action</span></a>'
    const nested = outlet(outlet(owner) + trigger) + link
    const wrapped = `<div class="customControl">${outlet(nested)}<label><input type="checkbox">Filter</label></div>`
    const { document, getComputedStyle } = new JSDOM(`<style>${sheet}</style><div class="railIn" style="--ds-ease-in-out:ease-in-out">
      ${row(owner)}${row(outlet(owner))}${row(outlet(owner) + trigger)}${row(nested)}${row(wrapped)}</div>`).window
    const animated = () => [...document.querySelectorAll('.newSessionRow')].map(el => [el, ...el.querySelectorAll('*')]
      .filter(child => getComputedStyle(child).animation.includes('rail-in')).map(child => child.getAttribute('class')))

    expect(animated()).toEqual([
      ['newSession'], ['newSession'], ['newSession', 'import', 'tooltip'], ['newSession', 'import', 'tooltip', 'link'], ['customControl'],
    ])
    document.documentElement.setAttribute('data-windows-titlebar', '')
    const [plain, ...layered] = animated()
    expect(layered).toEqual([plain, [...plain!, 'import', 'tooltip'], [...plain!, 'import', 'tooltip', 'link'], ['customControl']])
    document.documentElement.removeAttribute('data-windows-titlebar')
    // jsdom has no reduced-motion preference; enable that media block in the same stylesheet cascade.
    document.querySelector('style')!.textContent = sheet.replace('@media (prefers-reduced-motion: reduce)', '@media all')
    expect(animated()).toEqual([[], [], [], [], []])
  })

  it('gives shell rail controls the same base anchor for their shared translation', () => {
    expect(declarations('.collapsed .logoRow')?.get('justify-content')).toBe('flex-start')
    expect(declarations('.collapsed .newSessionRow')?.get('align-items')).toBe('flex-start')
    // The button sits in the session-action slot's children outlet, so the rule names `:scope` to reach `.collapsed`.
    expect(declarations('.collapsed :where(:scope, *) .newSession')?.get('width')).toBe('36px')
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

  it('lays panel trailing content out after the title like a Session row, reserving no room without content', () => {
    const trailing = declarations('.panelTrailing')
    expect(trailing?.get('flex')).toBe('none')
    expect(trailing?.get('margin-left')).toBe('auto')
    expect(trailing?.has('position')).toBe(false)
    expect(declarations('.panelEntryWide .panelRow')?.get('padding-right')).toBe('38px')
    expect(css).not.toMatch(/\.panelTrailing:(?:not\()?:?empty/)
    expect(css).not.toMatch(/\.panelRow\s*\{[^}]*padding-right:\s*72px/)
  })

  it('rests panel trailing content in the unpin action\'s place where the pointer hovers, and swaps the two on hover or keyboard focus', () => {
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, ' ')
    // The block that also reveals the unpin action on hover.
    const hover = /@media \(hover: hover\) \{((?:[^{}]*\{[^{}]*\})*[^{}]*\.panelUnpin \{ opacity: 0; \}(?:[^{}]*\{[^{}]*\})*)\s*\}/.exec(withoutComments)?.[1] ?? ''
    const rule = (selector: string): string => new RegExp(`${selector.replace(/[.()[\]:]/g, '\\$&')}\\s*\\{([^{}]*)\\}`).exec(hover)?.[1]?.replace(/\s+/g, ' ').trim() ?? ''
    // 7px to the unpin glyph's trailing edge and 31px of content box fill the 38px a row keeps for the action elsewhere.
    expect(rule('.panelEntryWide .panelRow')).toBe('padding-right: 7px;')
    expect(rule('.panelEntryWide .panelTrailing')).toBe('justify-content: flex-end; min-width: 31px;')
    // Only a row that has the action hides its content, on hover and on keyboard focus alike.
    expect(hover.replace(/\s+/g, ' ')).toContain(
      '.panelEntry:has(.panelUnpin):hover .panelTrailing, .panelEntry:has(.panelUnpin):has(:focus-visible) .panelTrailing { opacity: 0; }',
    )
    // Outside that block, where the action always shows, the content stays before the 38px.
    expect(withoutComments.replace(hover, '')).not.toMatch(/\.panelTrailing[^{}]*\{[^{}]*(?:opacity|min-width)/)
  })

  it('pins panel trailing content over the collapsed rail icon\'s top trailing corner', () => {
    const collapsed = declarations('.collapsed .panelTrailing')
    expect(collapsed?.get('position')).toBe('absolute')
    expect(collapsed?.get('right')).toBe('5px')
    expect(collapsed?.get('top')).toBe('5px')
  })
})
