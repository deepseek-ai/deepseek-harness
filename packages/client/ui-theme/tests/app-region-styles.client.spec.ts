/**
 * Window drag-region ownership, asserted against the CSS and the markup on disk.
 * The shell declares `-webkit-app-region: drag` exactly once — ui-web base.css,
 * for any element that marks itself `data-window-drag` — so a chrome row's own box
 * is the window's draggable geometry and no fixed band has to match any row's
 * height. CHROME_ROWS pairs every row's mark with its sheet and its pinned
 * geometry, so a row that stops marking itself, an unmarked row added to the
 * composition, and a mark on a container that owns no chrome row all fail here.
 * Electron composes app-regions from window geometry in DOM order, ignoring
 * stacking: a drag rule on a content container overrides the no-drag of any
 * overlay mounted earlier, so its text and labels drag the window instead of
 * receiving clicks. Everything interactive opts out through ui-web base.css; a
 * box that selector cannot cover subtracts itself in its own sheet. Composed
 * geometry itself is the browser lane's claim — ui-theme cannot see layout.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { packageFiles, packageStylesheets, parseRules, type CssRule } from './stylesheet-scan.ts'

/** The one stylesheet allowed to declare a darwin window drag region, relative to packages/. */
const SHELL_SHEET = 'client/web/src/base.css'

/** The mark that stylesheet's rule selects, as authored. */
const SHELL_DRAG_SELECTOR = "html[data-platform='darwin'] [data-window-drag]"

/** The frame's Windows caption row, relative to packages/; the other platform's chrome. */
const WINDOWS_CAPTION = 'client/ui-layout/src/client/AppFrame.module.css'

/** That caption row's selector, as authored. */
const WINDOWS_CAPTION_SELECTOR = ':global([data-windows-titlebar]) .frame::before'

/** The mark a chrome row puts on the element that owns its drag. */
const DRAG_MARK = 'data-window-drag'

/** The mark attribute, without swallowing the recall mark that starts the same way. */
const DRAG_MARK_PATTERN = /data-window-drag(?![\w-])/

/** Workspace root of the package tree, so the manifest can name files outside this package. */
const PACKAGES_DIR = fileURLToPath(new URL('../../../', import.meta.url))

const SIDEBAR = 'client/ui-sidebar/src/client/SidebarRoot.module.css'
const CONVERSATION = 'client/ui-conversation/src/client/skeleton/ConversationRoot.module.css'
const DOCKKIT = 'client/ui-dockkit/src/components/dockkit.module.css'
const PLUGIN_MANAGER = 'client/ui-plugin-manager/src/client/PluginManagerPage.module.css'
const PLATFORM_OVERLAY = 'client/ui-settings-account/src/client/PlatformOverlay.module.css'

/**
 * One chrome row: the sheet that lays it out, the markup that marks it, and the
 * geometry this manifest pins. A row whose pinned declaration changes fails on
 * the change; a row added to the composition without a mark or a manifest entry
 * fails in the markup scan below.
 */
interface ChromeRow {
  /** Stylesheet declaring the row's geometry, relative to packages/. */
  readonly file: string
  /** Class selector of the row's rule, in the sheet's source form. */
  readonly selector: string
  /** TSX file marking the row's element `data-window-drag`, relative to packages/. */
  readonly markup: string
  /** Height declaration to read, as `[property, value]` exactly as authored; omitted for content-sized rows. */
  readonly height?: readonly [property: string, value: string]
  /** Top inset that belongs to the row's own box, as `[property, value]`. */
  readonly inset?: readonly [property: string, value: string]
}

const CHROME_ROWS: readonly ChromeRow[] = [
  {
    file: 'client/ui-settings-account/src/client/OnboardingSurface.module.css',
    selector: '.dragBand',
    markup: 'client/ui-settings-account/src/client/OnboardingSurface.tsx',
    inset: ['inset', '8px'],
  },
  {
    file: SIDEBAR,
    selector: '.topStrip',
    markup: 'client/ui-sidebar/src/client/SidebarRoot.tsx',
    height: ['height', '52px'],
  },
  {
    file: SIDEBAR,
    selector: '.logoRow',
    markup: 'client/ui-sidebar/src/client/SidebarRoot.tsx',
    height: ['height', '60px'],
  },
  {
    file: CONVERSATION,
    selector: '.header',
    markup: 'client/ui-conversation/src/client/skeleton/ConversationHeader.tsx',
    height: ['min-height', '76px'],
  },
  {
    file: DOCKKIT,
    selector: '.tabStrip',
    markup: 'client/ui-dockkit/src/components/TabPanel.tsx',
    height: ['height', '28px'],
    inset: ['padding', '10px 6px 0 var(--dsh-dockkit-strip-inline-start, 10px)'],
  },
  {
    file: PLUGIN_MANAGER,
    selector: '.pageHead',
    markup: 'client/ui-plugin-manager/src/client/PluginManagerPage.tsx',
  },
  {
    file: PLUGIN_MANAGER,
    selector: '.detailTop',
    markup: 'client/ui-plugin-manager/src/client/PluginManagerPage.tsx',
  },
  {
    file: PLATFORM_OVERLAY,
    selector: '.header',
    markup: 'client/ui-settings-account/src/client/PlatformOverlay.tsx',
    height: ['height', '48px'],
  },
]

/**
 * Whether a rule declares a window drag region. Matches the prefixed and
 * unprefixed property and tolerates `!important`, so a creative spelling cannot
 * slip a drag surface past this check.
 * @param rule - one flattened rule.
 * @returns true when the rule declares a drag region.
 */
function declaresDrag(rule: CssRule): boolean {
  return rule.declarations
    .some(([property, value]) => /^(-webkit-)?app-region$/.test(property) && /^drag(\s|!|$)/.test(value))
}

/**
 * Selectors of a sheet's drag rules.
 * @param css - stylesheet text.
 * @returns the declaring selectors, in source order.
 */
function dragSelectors(css: string): string[] {
  return parseRules(css)
    .filter(declaresDrag)
    .map(rule => rule.selectors.join(', '))
}

/**
 * Every sheet in the package tree that declares a window drag region.
 * @returns one entry per declaring sheet, sorted by path, selectors in source order.
 */
function dragOwners(): { file: string; selectors: string[] }[] {
  return packageStylesheets()
    .flatMap((file) => {
      const selectors = dragSelectors(readFileSync(file, 'utf8'))
      return selectors.length === 0 ? [] : [{ file: underPackages(file), selectors }]
    })
    .sort((left, right) => left.file.localeCompare(right.file))
}

/**
 * Opening tags of one TSX file. Braces and quoted strings are kept whole, so a
 * `>` inside a prop expression or an attribute value does not end the tag.
 * @param source - TSX file text.
 * @returns each opening tag's text, in source order.
 */
function openingTags(source: string): string[] {
  const tags: string[] = []
  let index = 0
  while (index < source.length) {
    const open = source.indexOf('<', index)
    if (open === -1) break
    if (!/[A-Za-z]/.test(source[open + 1] ?? '')) {
      index = open + 1
      continue
    }
    let depth = 0
    let quote: string | undefined
    let end = open + 1
    for (; end < source.length; end += 1) {
      const character = source[end]!
      if (quote !== undefined) {
        if (character === quote) quote = undefined
        continue
      }
      if (character === '"' || character === "'" || character === '`') {
        quote = character
        continue
      }
      if (character === '{') depth += 1
      else if (character === '}') depth -= 1
      else if (character === '>' && depth === 0) break
    }
    tags.push(source.slice(open, end + 1))
    index = end + 1
  }
  return tags
}

/**
 * Whether a JSX tag references a manifest row's class, as `css.<row>`.
 * @param tag - one opening tag's text.
 * @param row - the manifest row.
 * @returns true when the tag names the row's class through any local alias.
 */
function referencesRow(tag: string, row: ChromeRow): boolean {
  return new RegExp(`[\\w$]+\\.${row.selector.slice(1)}\\b`).test(tag)
}

/**
 * A package-relative path for a failure message.
 * @param file - absolute path under packages/.
 * @returns the path below packages/.
 */
function underPackages(file: string): string {
  return file.slice(file.lastIndexOf('/packages/') + '/packages/'.length)
}

/**
 * One declaration's authored value.
 * @param file - stylesheet path relative to packages/.
 * @param selector - selector of the declaring rule.
 * @param property - declaration name.
 * @returns the value text, or undefined when the rule or declaration is absent.
 */
function declaredValue(file: string, selector: string, property: string): string | undefined {
  const path = packageStylesheets().find(candidate => candidate.endsWith(`/${file}`))
  /* v8 ignore next -- the manifest names shipped stylesheets; a missing one is reported by the height assertion below. */
  if (path === undefined) return undefined
  const rule = parseRules(readFileSync(path, 'utf8')).find(candidate => candidate.selectors.includes(selector))
  return rule?.declarations.find(([name]) => name === property)?.[1]
}

describe('window drag-region ownership', () => {
  it('rejects a drag declaration and passes no-drag', () => {
    expect(dragSelectors('.a { -webkit-app-region: drag; }')).toEqual(['.a'])
    expect(dragSelectors('.a { -webkit-app-region: drag !important; }')).toEqual(['.a'])
    expect(dragSelectors('.a { app-region: drag; }')).toEqual(['.a'])
    expect(dragSelectors('.a { -webkit-app-region: no-drag; }')).toEqual([])
    expect(dragSelectors('.a { app-region: no-drag !important; }')).toEqual([])
  })

  it('declares the window drag surface in exactly two places', () => {
    // Rows mark themselves instead of each sheet declaring its own drag, so the
    // tree holds one darwin rule — the mark rule in the shell sheet — plus the
    // Windows caption row, which is that platform's own chrome. A third
    // declaration, a per-sheet row rule, or a darwin band on the frame fails here.
    expect(dragOwners()).toEqual([
      { file: WINDOWS_CAPTION, selectors: [WINDOWS_CAPTION_SELECTOR] },
      { file: SHELL_SHEET, selectors: [SHELL_DRAG_SELECTOR] },
    ])
  })

  it('declares every pinned chrome row at the height the manifest pins', () => {
    for (const row of CHROME_ROWS) {
      if (row.height === undefined) continue
      expect(declaredValue(row.file, row.selector, row.height[0]), `${row.selector} ${row.height[0]}`)
        .toBe(row.height[1])
      if (row.inset !== undefined) {
        expect(declaredValue(row.file, row.selector, row.inset[0]), `${row.selector} ${row.inset[0]}`)
          .toBe(row.inset[1])
      }
    }
  })

  it('marks its own window drag in every chrome row’s markup', () => {
    for (const row of CHROME_ROWS) {
      const marked = openingTags(readFileSync(join(PACKAGES_DIR, row.markup), 'utf8'))
        .filter(tag => DRAG_MARK_PATTERN.test(tag) && referencesRow(tag, row))
      expect(marked, `${row.markup} ${row.selector}`).toHaveLength(1)
    }
  })

  it('finds the drag mark on exactly the chrome rows the manifest names', () => {
    // A mark on any other element — a content container, a wrapper, a row that
    // has no manifest entry — would drag the window over something that is not
    // window chrome, so the two lists must match exactly.
    const found: string[] = []
    for (const file of packageFiles(name => name.endsWith('.tsx'))) {
      if (!file.includes('/src/')) continue
      for (const tag of openingTags(readFileSync(file, 'utf8'))) {
        if (!DRAG_MARK_PATTERN.test(tag)) continue
        const row = CHROME_ROWS.find(candidate => file.endsWith(`/${candidate.markup}`) && referencesRow(tag, candidate))
        found.push(row === undefined ? `${underPackages(file)} <unmatched ${DRAG_MARK} tag>` : `${row.markup} ${row.selector}`)
      }
    }
    expect(found.sort()).toEqual(CHROME_ROWS.map(row => `${row.markup} ${row.selector}`).sort())
  })
})
