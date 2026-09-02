/**
 * Scrollbar stylesheet contract, asserted against the CSS text on disk: every
 * --dsw-alias-scrollbar-* token design-platform.css defines has a consumer,
 * scrollbar.css binds the base-surface pair through the rebindable
 * indirection, the width variable mirrors the ::-webkit-scrollbar rule for
 * consumers that align beside the bar, and elevated surfaces rebind that
 * indirection in complete pairs. The expected token set is scanned out of
 * design-platform.css, so adding, renaming, or dropping a scrollbar token
 * moves these assertions with it.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { atRuleBlock, type CssRule, packageStylesheets, parseRules, varReferences } from './stylesheet-scan.ts'

const STYLES = new URL('../src/styles/', import.meta.url)
const read = (name: string): string => readFileSync(fileURLToPath(new URL(name, STYLES)), 'utf8')

const platformCss = read('design-platform.css')
const scrollbarCss = read('scrollbar.css')

/** Body attribute selecting the dark palette; ui-layout's ThemePresenter sets it. */
const DARK_ATTRIBUTE = '[data-ds-dark-theme]'
/** Alias tokens under test: the prefix the elevation pairs share. */
const TOKEN_PREFIX = '--dsw-alias-scrollbar-'
/** Prefix of the rebindable indirection scrollbar.css owns. */
const INDIRECTION_PREFIX = '--dsh-scrollbar-'
/** The one non-token rebind value: a surface that draws no thumb at all. */
const HIDDEN_THUMB = 'transparent'
/** The elevation rebind, spelled per property: value-wholeness, not token shape. */
const ELEVATED_REBIND = new Map([
  ['--dsh-scrollbar-thumb', '--dsw-alias-scrollbar-bg-l2'],
  ['--dsh-scrollbar-thumb-hover', '--dsw-alias-scrollbar-hover-l2'],
].map(([property, token]) => [property!, `var(${token!})`]))

/**
 * Tokens a stylesheet reads through its rendering declarations, following its
 * own custom-property definitions transitively so a token reached only through
 * an indirection counts. The walk starts from the standard-property
 * declarations, so a defined-but-unread indirection contributes nothing.
 * @param rules - parsed rules of one stylesheet.
 * @returns every `--dsw-*` token the sheet's rendering declarations depend on.
 */
function tokensRendered(rules: CssRule[]): Set<string> {
  const definitions = new Map<string, string>()
  const pending: string[] = []
  for (const rule of rules) {
    for (const [property, value] of rule.declarations) {
      if (property.startsWith('--')) definitions.set(property, value)
      else pending.push(value)
    }
  }
  const reached = new Set<string>()
  const visited = new Set<string>()
  while (pending.length > 0) {
    for (const name of varReferences(pending.pop()!)) {
      if (name.startsWith('--dsw-')) reached.add(name)
      if (visited.has(name)) continue
      visited.add(name)
      const definition = definitions.get(name)
      if (definition !== undefined) pending.push(definition)
    }
  }
  return reached
}

const platformRules = parseRules(platformCss)
const scrollbarRules = parseRules(scrollbarCss)
const sorted = (names: Iterable<string>): string[] => [...names].sort()

/**
 * Scrollbar tokens defined by the rules whose selectors carry (or do not
 * carry) the dark palette attribute.
 * @param dark - true to scan the dark blocks, false to scan the light blocks.
 * @returns the scrollbar token names defined there.
 */
function definedTokens(dark: boolean): Set<string> {
  const names = new Set<string>()
  for (const rule of platformRules) {
    if (rule.selectors.every(selector => selector.includes(DARK_ATTRIBUTE)) !== dark) continue
    for (const [property] of rule.declarations) {
      if (property.startsWith(TOKEN_PREFIX)) names.add(property)
    }
  }
  return names
}

const lightTokens = definedTokens(false)
const darkTokens = definedTokens(true)
const allTokens = new Set([...lightTokens, ...darkTokens])

/** Every scrollbar token any package stylesheet references, mapped to the files referencing it. */
const referencedTokens = new Map<string, string[]>()
/** Every indirection property any package stylesheet outside ui-theme declares, mapped to its declaring rules. */
const rebindRules: { file: string; rule: CssRule }[] = []
/**
 * What one stylesheet contributes to the elevated-surface question: which
 * elevated surfaces it paints, whether any rule scrolls, and whether it
 * rebinds. Kept per file rather than per rule because the elevated card and the
 * descendant that actually scrolls are separate rules in the same sheet, and
 * CSS text does not express which contains which.
 */
interface SheetSurfaces {
  /** Elevated surface tokens this sheet paints anywhere. */
  elevated: Set<string>
  /** True when some rule declares `overflow*: auto|scroll`. */
  scrolls: boolean
  /**
   * True when some rule rebinds the indirection to an ELEVATION. A rule that
   * only hides the bar (`transparent`) does not count: it states no elevation,
   * so a sheet that hides its bars and also scrolls on an elevated surface
   * still owes the l2 pair for whatever draws a thumb there.
   */
  rebindsElevation: boolean
}
const sheetSurfaces = new Map<string, SheetSurfaces>()

/** Properties whose `auto`/`scroll` value makes a rule a scroll container. */
const OVERFLOW_PROPERTIES = ['overflow', 'overflow-x', 'overflow-y']
/** Properties that paint a surface, and so identify the elevation a rule sits on. */
const SURFACE_PROPERTIES = ['background', 'background-color']
/**
 * Token families that name a SURFACE — a background an element is drawn on, and
 * so something a scrollbar can sit against. `--dsw-alias-button-*`,
 * `--dsw-alias-interactive-*`, and `--dsw-alias-markdown-*` reach the same dark
 * elevation rungs while naming a control or an inline span, which no scroll
 * container renders its bar against (ChatView's floating `.toBottom` pill,
 * CodeBlock's banner). Family, not geometry: a floating button legitimately
 * carries a radius, a shadow, and a fixed size, so shape cannot separate them.
 */
const SURFACE_TOKEN_PATTERN = /^--dsw-(?:alias-bg-|specific-)/

/**
 * The palette's own dark elevation ladder, resolved from `design-platform.css`:
 * `bg-layer-2` and `bg-layer-3` are the rungs above the base surfaces, and the
 * l1/l2 scrollbar split encodes exactly that step. Reading it from the palette
 * rather than from the sheets that happen to rebind is what lets the check flag
 * a surface NOBODY has rebound yet.
 * @returns surface tokens whose dark value sits on an elevated rung.
 */
function elevatedRungs(): Set<string> {
  const definitions = new Map<string, string>()
  for (const rule of platformRules) {
    // Dark declarations come later in the sheet and overwrite the light ones,
    // which is the palette this distinction exists in.
    for (const [property, value] of rule.declarations) definitions.set(property, value)
  }
  const resolve = (name: string): string => {
    const seen = new Set<string>()
    let current = name
    while (definitions.has(current) && !seen.has(current)) {
      seen.add(current)
      const value = definitions.get(current)!
      const [reference] = varReferences(value)
      if (reference === undefined) return value
      current = reference
    }
    return current
  }
  const rungs = new Set([resolve('--dsw-alias-bg-layer-2'), resolve('--dsw-alias-bg-layer-3')])
  const tokens = new Set<string>()
  for (const name of definitions.keys()) {
    if (SURFACE_TOKEN_PATTERN.test(name) && rungs.has(resolve(name))) tokens.add(name)
  }
  return tokens
}

const elevatedSurfaces = elevatedRungs()

for (const file of packageStylesheets()) {
  const rules = parseRules(readFileSync(file, 'utf8'))
  const surfaces: SheetSurfaces = { elevated: new Set(), scrolls: false, rebindsElevation: false }
  for (const rule of rules) {
    let rebinds = false
    let rebindsElevation = false
    const ruleSurfaces: string[] = []
    for (const [property, value] of rule.declarations) {
      if (property.startsWith(INDIRECTION_PREFIX) && file !== fileURLToPath(new URL('scrollbar.css', STYLES))) {
        rebinds = true
        if (value !== HIDDEN_THUMB) rebindsElevation = true
      }
      if (OVERFLOW_PROPERTIES.includes(property) && /\b(?:auto|scroll)\b/.test(value)) surfaces.scrolls = true
      if (SURFACE_PROPERTIES.includes(property)) ruleSurfaces.push(...varReferences(value))
      for (const token of varReferences(value)) {
        if (!token.startsWith(TOKEN_PREFIX)) continue
        referencedTokens.set(token, [...referencedTokens.get(token) ?? [], file])
      }
    }
    for (const token of ruleSurfaces) {
      if (elevatedSurfaces.has(token)) surfaces.elevated.add(token)
    }
    if (rebinds) rebindRules.push({ file, rule })
    if (rebindsElevation) surfaces.rebindsElevation = true
  }
  sheetSurfaces.set(file, surfaces)
}

describe('design-platform.css scrollbar tokens', () => {
  it('defines the same scrollbar token set in the light and the dark block', () => {
    // A token present only in the light block silently keeps its light value
    // under the dark palette, since the dark block only overrides.
    expect(allTokens.size).toBeGreaterThan(0)
    expect(sorted(lightTokens)).toEqual(sorted(allTokens))
    expect(sorted(darkTokens)).toEqual(sorted(allTokens))
  })

  it('resolves every scrollbar token to a static scale value, not to another alias', () => {
    // The alias layer is the only indirection in the token sheet: an alias
    // pointing at a second alias makes the dark override order-dependent.
    for (const rule of platformRules) {
      for (const [property, value] of rule.declarations) {
        if (!property.startsWith(TOKEN_PREFIX)) continue
        for (const reference of varReferences(value)) {
          expect(reference, `${property}: ${value}`).toMatch(/^--dsw-static-/)
        }
      }
    }
  })
})

describe('scrollbar token consumers', () => {
  it('every defined scrollbar token is referenced by some package stylesheet', () => {
    // Before scrollbar.css existed these tokens had no consumer at all and
    // every scroll container rendered the unthemed UA bar. A fifth token, or a
    // rename on one side only, leaves the new name unreferenced here.
    expect(sorted(referencedTokens.keys())).toEqual(sorted(allTokens))
  })

  it('every referenced scrollbar token is defined in design-platform.css', () => {
    // A dangling var() renders the UA default instead of failing loudly, so a
    // rename has to move the reference and the definition together.
    for (const [token, files] of referencedTokens) {
      expect(allTokens, files.join(', ')).toContain(token)
    }
  })
})

describe('scrollbar.css base-surface binding', () => {
  const rendered = tokensRendered(scrollbarRules)

  it('renders the l1 pair through the rebindable indirection', () => {
    // l1 is the base-surface default the indirection resolves to; the
    // indirection only counts as bound when a rendering declaration reads it.
    expect(rendered).toContain(`${TOKEN_PREFIX}bg-l1`)
    expect(rendered).toContain(`${TOKEN_PREFIX}hover-l1`)
  })

  it('routes the standard property and the WebKit thumb through the same indirection', () => {
    // A rebind on an elevated container has to move the Firefox and the WebKit
    // rendering together, which only holds while both read the same variable.
    const declaration = (property: string, selectorPart: string): string | undefined => scrollbarRules
      .filter(rule => rule.selectors.includes(selectorPart))
      .flatMap(rule => rule.declarations)
      .findLast(([name]) => name === property)?.[1]
    const thumbColor = declaration('scrollbar-color', 'body')
    expect(thumbColor).toBeDefined()
    const indirection = varReferences(thumbColor!)[0]
    expect(indirection).toBe(`${INDIRECTION_PREFIX}thumb`)
    expect(varReferences(declaration('background', '::-webkit-scrollbar-thumb')!)).toEqual([indirection])
  })
})

describe('scrollbar.css width variable', () => {
  const WIDTH_VARIABLE = `${INDIRECTION_PREFIX}width`

  it('defines the width variable on body as a static length', () => {
    // The overlay seat compensation reads a fixed number, not a second
    // indirection: the mirror check below compares the WebKit rule against
    // this value, so a var()-to-var() chain would compare one indirection to
    // another instead of pinning the number.
    const value = scrollbarRules
      .filter(rule => rule.selectors.includes('body'))
      .flatMap(rule => rule.declarations)
      .findLast(([property]) => property === WIDTH_VARIABLE)?.[1]
    expect(value, WIDTH_VARIABLE).toBeDefined()
    expect(value, WIDTH_VARIABLE).toMatch(/^\d+(?:\.\d+)?px$/)
  })

  it('mirrors the ::-webkit-scrollbar width rule with the variable value', () => {
    // The compensation stays aligned with the WebKit bar only while both read
    // the same number. A change to one side without the other puts the overlay
    // seat a band off from Chat on WebKit engines.
    const variableValue = scrollbarRules
      .filter(rule => rule.selectors.includes('body'))
      .flatMap(rule => rule.declarations)
      .findLast(([property]) => property === WIDTH_VARIABLE)?.[1]
    const webkitWidth = scrollbarRules
      .filter(rule => rule.selectors.includes('::-webkit-scrollbar'))
      .flatMap(rule => rule.declarations)
      .findLast(([property]) => property === 'width')?.[1]
    expect(webkitWidth, '::-webkit-scrollbar width').toBeDefined()
    expect(webkitWidth).toBe(variableValue)
  })

  it('every reader of the width variable outside ui-theme references a defined variable', () => {
    // The consumer is ConversationRoot's overlay composer seat
    // (`right: var(--dsh-scrollbar-width)`); a rename in scrollbar.css without
    // the consumer, or a typo in the consumer, leaves the value
    // guaranteed-invalid and the seat loses the band. The equal-rectangle e2e
    // would catch it only on an engine that draws the bar, so the sheet
    // contract states it here.
    const defined = new Set(
      scrollbarRules
        .flatMap(rule => rule.declarations)
        .filter(([property]) => property.startsWith(INDIRECTION_PREFIX))
        .map(([property]) => property),
    )
    expect(defined).toContain(WIDTH_VARIABLE)
    const readers: string[] = []
    for (const file of packageStylesheets()) {
      if (file === fileURLToPath(new URL('scrollbar.css', STYLES))) continue
      for (const rule of parseRules(readFileSync(file, 'utf8'))) {
        for (const [property, value] of rule.declarations) {
          for (const name of varReferences(value)) {
            if (name === WIDTH_VARIABLE) readers.push(`${file} ${rule.selectors.join(', ')}: ${property}`)
          }
        }
      }
    }
    expect(readers.length, 'compensation consumer').toBeGreaterThan(0)
  })
})

describe('scrollbar.css selectors', () => {
  const scrollbarColorSelectors = scrollbarRules
    .filter(rule => rule.declarations.some(([property]) => property === 'scrollbar-color'))
    .flatMap(rule => rule.selectors)

  it('declares scrollbar-color only where the body-scoped tokens are visible', () => {
    // design-platform.css defines the alias tokens on `body`, and custom
    // properties inherit downward only: the same declaration on `html` or
    // `:root` resolves to the guaranteed-invalid value, which computes
    // scrollbar-color to `auto` and drops the theming entirely.
    expect(scrollbarColorSelectors.length).toBeGreaterThan(0)
    for (const selector of scrollbarColorSelectors) {
      expect(selector, selector).toMatch(/^body\b/)
    }
  })

  it('defines the indirection where the alias tokens are visible', () => {
    const definesIndirection = ([property, value]: [string, string]): boolean =>
      property.startsWith(INDIRECTION_PREFIX) && value.includes(TOKEN_PREFIX)
    const hosts = scrollbarRules
      .filter(rule => rule.declarations.some(definesIndirection))
      .flatMap(rule => rule.selectors)
    expect(hosts.length).toBeGreaterThan(0)
    for (const selector of hosts) expect(selector, selector).toMatch(/^body\b/)
  })

  it('re-declares the scrollbar properties per element rather than inheriting them', () => {
    // scrollbar-width is not an inherited property, and an inherited
    // scrollbar-color carries the colour already substituted at `body`, which
    // a descendant rebinding the indirection could no longer change.
    expect(scrollbarColorSelectors).toContain('body *')
    const widthSelectors = scrollbarRules
      .filter(rule => rule.declarations.some(([property]) => property === 'scrollbar-width'))
      .flatMap(rule => rule.selectors)
    expect(widthSelectors).toContain('body *')
  })
})

describe('scrollbar.css rendering paths', () => {
  /** The gate prelude, spelled exactly as the sheet must spell it for the split to exist. */
  const GATE = '@supports not selector(::-webkit-scrollbar)'
  const withoutComments = scrollbarCss.replace(/\/\*[\s\S]*?\*\//g, ' ')
  const gate = atRuleBlock(withoutComments, GATE)
  /** Standard scrollbar properties, the ones whose non-`auto` values suppress the pseudo-elements. */
  const STANDARD_PROPERTIES = ['scrollbar-width', 'scrollbar-color']

  it('gates the standard properties behind the absence of the WebKit pseudo-element', () => {
    // A non-`auto` scrollbar-width or scrollbar-color makes Chromium and
    // Safari discard every ::-webkit-scrollbar* rule for that element,
    // ::-webkit-scrollbar-thumb:hover included. Declaring both paths
    // unconditionally therefore renders the hover token nowhere: the engines
    // implementing the hover pseudo-element are exactly the ones the standard
    // properties silence, and Firefox has no hover pseudo-element at all.
    expect(gate, GATE).toBeDefined()
    for (const property of STANDARD_PROPERTIES) {
      const offsets = [...withoutComments.matchAll(new RegExp(String.raw`(^|[;{\s])${property}\s*:`, 'g'))]
        .map(match => match.index)
      expect(offsets.length, property).toBeGreaterThan(0)
      for (const offset of offsets) {
        expect(offset, `${property} outside ${GATE}`).toBeGreaterThan(gate!.start)
        expect(offset, `${property} outside ${GATE}`).toBeLessThan(gate!.end)
      }
    }
  })

  it('leaves the WebKit pseudo-element rules outside the gate', () => {
    // Gating these in turn would only restate selector matching: an engine
    // without the pseudo-elements drops the rules as unknown selectors. Inside
    // the gate they would be dropped by the engines that do implement them,
    // which is every engine that can render them.
    const offsets = [...withoutComments.matchAll(/::-webkit-scrollbar/g)]
      .map(match => match.index)
      .filter(offset => withoutComments.slice(offset).search(/^[\w:-]*\s*[,{]/) === 0)
    expect(offsets.length).toBeGreaterThan(0)
    for (const offset of offsets) {
      expect(offset > gate!.start && offset < gate!.end, `::-webkit-scrollbar rule inside ${GATE}`).toBe(false)
    }
  })

  it('renders the hover token only through the pseudo-element path', () => {
    // The standard path has no hover counterpart — scrollbar-color states one
    // thumb colour and the engine derives its own hover treatment — so the
    // hover indirection has to be read outside the gate or it renders nowhere.
    const hoverOffsets = [...withoutComments.matchAll(new RegExp(String.raw`var\(\s*${INDIRECTION_PREFIX}thumb-hover`, 'g'))]
      .map(match => match.index)
    expect(hoverOffsets.length).toBeGreaterThan(0)
    for (const offset of hoverOffsets) {
      expect(offset > gate!.start && offset < gate!.end, 'hover indirection read inside the gate').toBe(false)
    }
  })
})

describe('elevated surface rebinds', () => {
  it('at least one surface rebinds the indirection', () => {
    expect(rebindRules.length).toBeGreaterThan(0)
  })

  it('each rebinding rule sets the thumb and the hover variable together', () => {
    // A surface rebinding only the resting colour keeps the l1 hover colour,
    // so the elevation is wrong only while the pointer is over the thumb.
    for (const { file, rule } of rebindRules) {
      const properties = rule.declarations.map(([property]) => property).filter(property => property.startsWith(INDIRECTION_PREFIX))
      expect(sorted(properties), `${file} ${rule.selectors.join(', ')}`).toEqual([
        `${INDIRECTION_PREFIX}thumb-hover`, `${INDIRECTION_PREFIX}thumb`,
      ].sort())
    }
  })

  it('each rebinding rule binds the indirection names scrollbar.css renders', () => {
    // A misspelled property name declares an unused variable, and the surface
    // silently keeps the base-surface colour.
    const rendered = new Set(
      scrollbarRules
        .flatMap(rule => rule.declarations)
        .filter(([property]) => !property.startsWith('--'))
        .flatMap(([, value]) => varReferences(value))
        .filter(name => name.startsWith(INDIRECTION_PREFIX)),
    )
    for (const { file, rule } of rebindRules) {
      for (const [property] of rule.declarations) {
        if (property.startsWith(INDIRECTION_PREFIX)) expect(rendered, `${file}: ${property}`).toContain(property)
      }
    }
  })

  it('rebinds the pair to one target: the l2 elevation pair, or transparent', () => {
    // The rule as a whole, not each declaration on its own. Per-declaration
    // checking accepts a MIXED rule — `thumb: transparent` beside
    // `thumb-hover: var(--dsw-alias-scrollbar-hover-l2)` — which repaints the
    // bar the moment the pointer reaches it while passing a gate that claims
    // the two targets are exclusive.
    //
    // The elevation half compares the whole value against the pair's canonical
    // spelling rather than checking that every token it mentions ends in `-l2`.
    // A shape check admits `color-mix(…, var(--dsw-alias-scrollbar-bg-l2) 85%,
    // white)` and a crossed pair (the hover token bound to the resting
    // property); neither is what the contract says.
    for (const { file, rule } of rebindRules) {
      const rebinds = rule.declarations.filter(([property]) => property.startsWith(INDIRECTION_PREFIX))
      const where = `${file} ${rule.selectors.join(', ')}`
      if (rebinds.every(([, value]) => value === HIDDEN_THUMB)) continue
      expect(rebinds.some(([, value]) => value === HIDDEN_THUMB), `${where}: mixes ${HIDDEN_THUMB} with an elevation`).toBe(false)
      for (const [property, value] of rebinds) {
        expect(value, `${where}: ${property}`).toBe(ELEVATED_REBIND.get(property))
      }
    }
  })

  it('resolves the elevated surface set from the palette ladder', () => {
    // The set has to come from the palette, not from the sheets that happen to
    // rebind: derived from rebinds it can only confirm what someone already
    // remembered, and a surface nobody has rebound yet — the case the check
    // exists for — would define itself as unelevated. Anchoring it here means a
    // new palette token on an elevated rung is in scope the moment it is
    // defined. `--dsw-specific-tip` is the regression that proved the point: it
    // resolves to the same dark rung as the menu surface, and the Todo panel
    // scrolled on it unrebound while a rebind-derived set stayed green.
    expect(elevatedSurfaces).toContain('--dsw-alias-bg-layer-2')
    expect(elevatedSurfaces).toContain('--dsw-alias-bg-layer-3')
    expect(elevatedSurfaces).toContain('--dsw-specific-menu')
    expect(elevatedSurfaces).toContain('--dsw-specific-input-major')
    expect(elevatedSurfaces).toContain('--dsw-specific-tip')
    // Base surfaces stay out, or every scroll container would be in scope and
    // the check would say nothing.
    expect(elevatedSurfaces).not.toContain('--dsw-alias-bg-base')
    expect(elevatedSurfaces).not.toContain('--dsw-alias-bg-layer-1')
  })

  it('every sheet that scrolls on an elevated surface rebinds', () => {
    // The failure this closes: a scroll container on an elevated surface that
    // nobody remembered to rebind renders the l1 thumb, which differs from l2
    // only in the dark palette and only for that one surface — invisible both in
    // review and in a light-palette screenshot. Four sheets shipped that way
    // (ui-primitives Menu, InputBar, QuestionComposer, TodoPanel) and review
    // caught them by hand, which is what this replaces.
    //
    // Surface-level, not element-level: the elevated card and the descendant
    // that scrolls are separate rules, and CSS text does not say which contains
    // which. What keeps that from over-reporting is the token FAMILY: only
    // `--dsw-alias-bg-*` and `--dsw-specific-*` name a surface, so a floating
    // button or an inline code span reaching the same rung is out of scope
    // (ChatView's `.toBottom`, CodeBlock's banner). Geometry cannot make that
    // call — a floating button carries a radius, a shadow, and a fixed size.
    for (const [file, surfaces] of sheetSurfaces) {
      if (!surfaces.scrolls || surfaces.rebindsElevation) continue
      expect([...surfaces.elevated], `${file} scrolls on an elevated surface without rebinding`).toEqual([])
    }
  })
})
