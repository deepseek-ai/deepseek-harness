// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import {
  IconAlarmClockOutlineRegular, IconApiOutlineRegular, IconArchiveOutlineRegular, IconFolderCloseRegular,
  IconAppsAddOutlineMedium, IconGoalOutlineRegular, IconSendOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { ICON_ARTWORK, type IconGlyph, type IconWeight } from '../src/icons/artwork.ts'
import {
  BrowseOutlineArtwork, ChatLinesOutlineArtwork, CodeBracketsArtwork, FolderCloseArtwork, GlobeOutlineArtwork,
} from '../src/icons/shared-artwork.tsx'

afterEach(cleanup)

// Icon components all share the IconProps signature; the barrel also exports
// non-icon atoms (different props shapes), so filter by prefix BEFORE typing.
const icons = Object.fromEntries(
  Object.entries(primitives).filter(([name]) => name.startsWith('Icon')),
) as Record<string, (p: primitives.IconProps) => React.JSX.Element>
const iconNames = Object.keys(icons)
const glyphs = Object.keys(ICON_ARTWORK) as IconGlyph[]

function artwork(glyph: IconGlyph, weight: IconWeight): Document {
  const stroke = weight === 'regular' ? primitives.ICON_REGULAR_STROKE : primitives.ICON_MEDIUM_STROKE
  return new DOMParser().parseFromString(ICON_ARTWORK[glyph].svg(stroke), 'image/svg+xml')
}

describe('product icon set', () => {
  it('exports regular and medium variants for all 97 public glyphs', () => {
    expect(iconNames.length).toBe(194)
    expect(iconNames.some(name => /\d+$/.test(name))).toBe(false)
    const regular = iconNames.filter(name => name.endsWith('Regular')).map(name => name.slice(0, -'Regular'.length))
    const medium = iconNames.filter(name => name.endsWith('Medium')).map(name => name.slice(0, -'Medium'.length))
    expect(medium.sort()).toEqual(regular.sort())
    expect(iconNames).toEqual(expect.arrayContaining([
      'IconMicrophoneOutlineRegular',
      'IconPlanOutlineRegular', 'IconCompactOutlineRegular', 'IconShieldOutlineRegular', 'IconDeliverDocRegular',
      'IconWarningTriangleOutlineRegular', 'IconCompareSplitOutlineRegular', 'IconCloseCircleFillRegular',
    ]))
  })

  it('draws the circled close as one currentColor knockout path in both weights', () => {
    // A filled disc with the cross cut out of it (even-odd), so the cross shows
    // the surface behind the glyph on any background instead of a second color.
    for (const weight of ['regular', 'medium'] as const) {
      const paths = artwork('close-circle-fill', weight).querySelectorAll('path')
      expect(paths).toHaveLength(1)
      expect(paths[0]!.getAttribute('fill')).toBe('currentColor')
      expect(paths[0]!.getAttribute('fill-rule')).toBe('evenodd')
      expect(paths[0]!.getAttribute('stroke')).toBeNull()
    }
    expect(render(<primitives.IconCloseCircleFillRegular />).container.querySelector('svg')!.getAttribute('width')).toBe('16')
  })

  it('exports the shield contour and regular stroke for composite glyphs', () => {
    const shield = artwork('shield-outline', 'regular')
    expect(shield.querySelector('path')?.getAttribute('d')).toBe(primitives.SHIELD_OUTLINE_PATH)
    expect(shield.documentElement.getAttribute('stroke-width')).toBe(String(primitives.ICON_REGULAR_STROKE))
  })

  it.each(iconNames)('%s references its sprite symbol', (name) => {
    const Icon = icons[name]!
    const { container } = render(<Icon />)
    const svg = container.querySelector('svg')!
    expect(svg.getAttribute('aria-hidden')).toBe('true')
    const id = svg.getAttribute('data-icon')!
    expect([...svg.children].map(child => [child.localName, child.getAttribute('href')])).toEqual([['use', `#${id}`]])
    expect(Object.hasOwn(primitives.ICON_SYMBOLS, id)).toBe(true)
  })

  it.each(glyphs)('%s artwork is a standalone currentColor SVG without a hardcoded palette', (glyph) => {
    for (const weight of ['regular', 'medium'] as const) {
      const markup = ICON_ARTWORK[glyph].svg(weight === 'regular' ? primitives.ICON_REGULAR_STROKE : primitives.ICON_MEDIUM_STROKE)
      expect(markup).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" /)
      expect(markup).not.toMatch(/#[0-9a-fA-F]{3,8}"/)
      expect(markup).toContain('currentColor')
      expect(artwork(glyph, weight).querySelector('parsererror')).toBeNull()
    }
  })

  it('publishes one default symbol per glyph weight', () => {
    expect(Object.keys(primitives.ICON_SYMBOLS)).toHaveLength(2 * glyphs.length)
    expect(primitives.ICON_SYMBOLS['dsw-icon-search-outline-medium']).toBe(ICON_ARTWORK['search-outline'].svg(primitives.ICON_MEDIUM_STROKE))
  })

  it('keeps element ids unique across the default symbols', () => {
    const ids = Object.values(primitives.ICON_SYMBOLS).flatMap(markup => [...markup.matchAll(/\sid="([^"]+)"/g)].map(([, id]) => id))
    expect(new Set(ids).size).toBe(ids.length)
  })

  it.each(iconNames)('%s references the glyph and weight its name spells', (name) => {
    const weight = name.endsWith('Regular') ? 'regular' : 'medium'
    const glyph = name.slice('Icon'.length, -weight.length).replace(/(?<!^)(?=[A-Z])/g, '-').toLowerCase()
    const Icon = icons[name]!
    expect(render(<Icon />).container.querySelector('svg')!.getAttribute('data-icon')).toBe(`dsw-icon-${glyph}-${weight}`)
  })

  it.each([
    ['queue-outline', ChatLinesOutlineArtwork],
    ['globe-outline', GlobeOutlineArtwork],
    ['inspect-outline', CodeBracketsArtwork],
    ['browse-outline', BrowseOutlineArtwork],
    ['folder-close', FolderCloseArtwork],
  ] as const)('keeps the shared %s artwork identical to its product glyph', (glyph, Artwork) => {
    for (const weight of ['regular', 'medium'] as const) {
      const stroke = weight === 'regular' ? primitives.ICON_REGULAR_STROKE : primitives.ICON_MEDIUM_STROKE
      const inline = render(<Artwork strokeWidth={stroke} />).container.querySelector('svg')!
      const product = artwork(glyph, weight).documentElement
      expect(inline.getAttribute('viewBox')).toBe(product.getAttribute('viewBox'))
      expect(inline.children.length).toBe(product.children.length)
      expect([...inline.children].every((child, index) => child.isEqualNode(product.children[index]!))).toBe(true)
      cleanup()
    }
  })

  it('size and className props land on the root svg', () => {
    const { container } = render(<IconSendOutlineRegular size={20} className="x" />)
    const svg = container.querySelector('svg')!
    expect(svg.getAttribute('width')).toBe('20')
    expect(svg.getAttribute('height')).toBe('20')
    expect(svg.classList.contains('x')).toBe(true)
  })

  it('keeps a non-square glyph at its drawn ratio', () => {
    const svg = render(<primitives.IconTreeCornerRegular size={20} />).container.querySelector('svg')!
    expect([svg.getAttribute('width'), svg.getAttribute('height')]).toEqual(['16', '20'])
  })

  it('uses 1px regular and 1.3px medium strokes', () => {
    expect(artwork('search-outline', 'regular').documentElement.getAttribute('stroke-width')).toBe('1')
    expect(artwork('search-outline', 'medium').documentElement.getAttribute('stroke-width')).toBe('1.3')
  })

  it('exports regular and medium permission glyphs', () => {
    const pairs = [
      [primitives.PermissionIconReadOnlyRegular, primitives.PermissionIconReadOnlyMedium],
      [primitives.PermissionIconWorkspaceWriteRegular, primitives.PermissionIconWorkspaceWriteMedium],
      [primitives.PermissionIconFullAccessRegular, primitives.PermissionIconFullAccessMedium],
      [primitives.PermissionIconAutoReviewRegular, primitives.PermissionIconAutoReviewMedium],
    ] as const
    for (const [Regular, Medium] of pairs) {
      const regular = render(<Regular />)
      expect(regular.container.querySelector('svg')?.getAttribute('stroke-width')).toBe('1')
      regular.unmount()
      const medium = render(<Medium />)
      expect(medium.container.querySelector('svg')?.getAttribute('stroke-width')).toBe('1.3')
      medium.unmount()
    }
  })

  it('exports both weights for every reference kind', () => {
    for (const kind of ['session', 'file', 'folder'] as const) {
      const regular = render(<primitives.ReferenceIconRegular kind={kind} />)
      expect(regular.container.querySelector('svg')?.getAttribute('stroke-width')).toBe('1')
      regular.unmount()
      const medium = render(<primitives.ReferenceIconMedium kind={kind} />)
      expect(medium.container.querySelector('svg')?.getAttribute('stroke-width')).toBe('1.3')
      medium.unmount()
    }
  })

  it('each glyph defaults to its own drawn size, not one set-wide default', () => {
    const api = render(<IconApiOutlineRegular />)
    expect(api.container.querySelector('svg')!.getAttribute('width')).toBe('14')
    const folder = render(<IconFolderCloseRegular />)
    expect(folder.container.querySelector('svg')!.getAttribute('width')).toBe('16')
    const archive = render(<IconArchiveOutlineRegular />)
    expect(archive.container.querySelector('svg')!.getAttribute('width')).toBe('20')
    const alarm = render(<IconAlarmClockOutlineRegular />)
    expect(alarm.container.querySelector('svg')!.getAttribute('width')).toBe('16')
  })

  it('renders reusable goal glyphs without document-global ids', () => {
    const { container } = render(<><IconGoalOutlineRegular /><IconGoalOutlineRegular /></>)
    expect(container.querySelector('[id]')).toBeNull()
    expect(container.querySelector('[clip-path]')).toBeNull()
  })

  it('draws the apps-add tiles closer together in the compact variant', () => {
    const tiles = (glyph: IconGlyph) => {
      const doc = artwork(glyph, 'regular')
      const result = [...doc.querySelectorAll('rect')].map(rect => `${rect.getAttribute('x')},${rect.getAttribute('y')}`)
      return { result, plus: doc.querySelector('path')?.getAttribute('d') }
    }
    expect(tiles('apps-add-outline')).toEqual({ result: ['2.25,2.25', '2.25,9.75', '9.75,9.75'], plus: 'M11.75 1.75v5M9.25 4.25h5' })
    expect(tiles('apps-add-compact-outline')).toEqual({ result: ['2.75,2.75', '2.75,9.25', '9.25,9.25'], plus: 'M11.25 2.25v5M8.75 4.75h5' })
    const glyphOf = (compact: boolean) => render(<IconAppsAddOutlineMedium compact={compact} />).container.querySelector('svg')!.getAttribute('data-icon')
    expect([glyphOf(false), glyphOf(true)]).toEqual(['dsw-icon-apps-add-outline-medium', 'dsw-icon-apps-add-compact-outline-medium'])
  })
})

describe('FishLogo', () => {
  it('renders the fish path in currentColor at the native ratio', () => {
    const { container } = render(<primitives.FishLogo />)
    const svg = container.querySelector('svg')!
    expect(svg.getAttribute('width')).toBe('24')
    expect(Number(svg.getAttribute('height'))).toBeCloseTo(17.66, 1)
    expect(svg.getAttribute('viewBox')).toBe('0 0 23.16 17.04')
    expect(container.querySelectorAll('path')).toHaveLength(1)
    expect(container.innerHTML).toContain('currentColor')
    expect(container.innerHTML).not.toContain('M0 0L23.16')
  })
})

describe('BrandWordmark', () => {
  it('can render the name artwork with or without its leading mark', () => {
    const view = render(<primitives.BrandWordmark />)
    const svg = view.container.querySelector('svg')!
    expect(svg.getAttribute('width')).toBe('182')
    expect(svg.getAttribute('viewBox')).toBe('0 0 182 24')

    view.rerender(<primitives.BrandWordmark includeMark={false} />)
    expect(svg.getAttribute('width')).toBe('156')
    expect(svg.getAttribute('viewBox')).toBe('26 0 156 24')
  })
})
