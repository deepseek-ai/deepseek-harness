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
  it('exports regular and medium variants for every public glyph', () => {
    const publicGlyphs = glyphs.filter(glyph => glyph !== 'apps-add-compact-outline')
    const expectedNames = publicGlyphs.flatMap((glyph) => {
      const name = glyph.split('-').map(part => part[0]!.toUpperCase() + part.slice(1)).join('')
      return [`Icon${name}Regular`, `Icon${name}Medium`]
    })
    expect([...iconNames].sort()).toEqual(expectedNames.sort())
    expect(iconNames.some(name => /\d+$/.test(name))).toBe(false)
    const regular = iconNames.filter(name => name.endsWith('Regular')).map(name => name.slice(0, -'Regular'.length))
    const medium = iconNames.filter(name => name.endsWith('Medium')).map(name => name.slice(0, -'Medium'.length))
    expect(medium.sort()).toEqual(regular.sort())
    expect(iconNames).toEqual(expect.arrayContaining([
      'IconMicrophoneOutlineRegular',
      'IconPlanOutlineRegular', 'IconCompactOutlineRegular', 'IconShieldOutlineRegular', 'IconDeliverDocRegular',
      'IconWarningTriangleOutlineRegular', 'IconCompareSplitOutlineRegular', 'IconCloseCircleFillRegular',
      'IconEyeOutlineRegular', 'IconEyeOffOutlineRegular',
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

  it('draws the open eye as an outline with a pupil and the closed eye with a slash through the same contour', () => {
    for (const weight of ['regular', 'medium'] as const) {
      const eye = artwork('eye-outline', weight)
      expect(eye.documentElement.getAttribute('viewBox')).toBe('0 0 16 16')
      expect(eye.querySelector('circle')?.getAttribute('r')).toBe('2.25')
      const off = artwork('eye-off-outline', weight)
      expect(off.querySelector('circle')).toBeNull()
      expect(off.querySelector('path')?.getAttribute('d')).toBe('M2.25 2.25L13.75 13.75')
      for (const doc of [eye, off]) expect([...doc.querySelectorAll('path, circle')].every(node => node.getAttribute('fill') === null)).toBe(true)
    }
  })

  it.each([
    ['regular', primitives.IconUsersOutlineRegular, 1],
    ['medium', primitives.IconUsersOutlineMedium, 1.3],
  ] as const)('keeps the inset Users contours and %s stroke at every caller size', (weight, Icon, stroke) => {
    const svg = artwork('users-outline', weight).documentElement
    const paths = [...svg.querySelectorAll('path')]
    const contours = paths.map(path => path.getAttribute('d')!)
    // A 0.91 coordinate scale about (8, 8) preserves the four cubic contours without scaling their strokes.
    expect(contours).toEqual([
      'M6.18 8.2275C7.5620898 8.2275 8.6825 7.1070898 8.6825 5.725C8.6825 4.3429102 7.5620898 3.2225 6.18 3.2225C4.7979102 3.2225 3.6775 4.3429102 3.6775 5.725C3.6775 7.1070898 4.7979102 8.2275 6.18 8.2275Z',
      'M1.63 13.915C1.63 11.185 3.905 10.0475 6.18 10.0475C8.455 10.0475 10.73 11.185 10.73 13.915',
      'M10.275 3.359C11.3215 3.7685 12.0495 4.6785 12.0495 5.725C12.0495 6.7715 11.3215 7.6815 10.275 8.091',
      'M12.004 10.366C13.369 11.003 14.37 12.186 14.37 13.915',
    ])
    // These contour extrema are endpoints; every Bezier control point stays inside the same bounds.
    const coordinates = contours.flatMap(path => path.match(/\d+(?:\.\d+)?/g)!.map(Number))
    const xs = coordinates.filter((_, index) => index % 2 === 0)
    const ys = coordinates.filter((_, index) => index % 2 === 1)
    expect([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)])
      .toEqual([1.63, 3.2225, 14.37, 13.915])
    expect(svg.getAttribute('viewBox')).toBe('0 0 16 16')
    expect(svg.getAttribute('fill')).toBe('none')
    expect(svg.getAttribute('stroke-width')).toBe(String(stroke))
    expect(svg.querySelector('[transform], [vector-effect], [stroke-width]')).toBeNull()
    expect(svg.hasAttribute('transform')).toBe(false)
    expect(svg.hasAttribute('vector-effect')).toBe(false)
    expect(paths.every(path => path.getAttribute('stroke') === 'currentColor')).toBe(true)
    expect(primitives.ICON_SYMBOLS[`dsw-icon-users-outline-${weight}`])
      .toBe(ICON_ARTWORK['users-outline'].svg(stroke))
    const view = render(<Icon />)
    const rendered = view.container.querySelector('svg')!
    expect([rendered.getAttribute('width'), rendered.getAttribute('height')]).toEqual(['16', '16'])
    view.rerender(<Icon size={14} />)
    expect([rendered.getAttribute('width'), rendered.getAttribute('height')]).toEqual(['14', '14'])
    expect(rendered.querySelector('use')?.getAttribute('href')).toBe(`#dsw-icon-users-outline-${weight}`)
  })

  it.each([
    ['regular', primitives.IconLayersOutlineRegular, 1],
    ['medium', primitives.IconLayersOutlineMedium, 1.3],
  ] as const)('draws the inset three rounded layers with the %s stroke', (weight, Icon, stroke) => {
    const svg = artwork('layers-outline', weight).documentElement
    const paths = [...svg.querySelectorAll('path')]
    // A 0.87 scale about (8, 8) insets coordinates and arc radii, retaining rotations, flags, and strokes.
    expect(paths.map(path => path.getAttribute('d'))).toEqual([
      'M8.481371 2.304371 a1.159971 1.159971 0 0 0-.962742 0 L2.547971 4.566371 a.580029 .580029 0 0 0 0 1.0614 l4.9764 2.267829 a1.159971 1.159971 0 0 0 .962829 0 l4.9764-2.262 a.580029 .580029 0 0 0 0-1.0614Z',
      'M2.199971 8 a.580029 .580029 0 0 0 .336429 .527829 l4.987971 2.267742 a1.159971 1.159971 0 0 0 .957 0 l4.9764-2.262 A.580029 .580029 0 0 0 13.800029 8',
      'M2.199971 10.899971 a.580029 .580029 0 0 0 .336429 .527829 l4.987971 2.267829 a1.159971 1.159971 0 0 0 .957 0 l4.9764-2.262 A.580029 .580029 0 0 0 13.800029 10.899971',
    ])
    expect(svg.children).toHaveLength(3)
    expect(svg.getAttribute('viewBox')).toBe('0 0 16 16')
    expect(svg.getAttribute('fill')).toBe('none')
    expect(svg.getAttribute('stroke-width')).toBe(String(stroke))
    expect(svg.getAttribute('stroke-linecap')).toBe('round')
    expect(svg.getAttribute('stroke-linejoin')).toBe('round')
    expect(svg.querySelector('[transform], [vector-effect], [stroke-width], [stroke-linecap], [stroke-linejoin]')).toBeNull()
    expect(svg.hasAttribute('transform')).toBe(false)
    expect(svg.hasAttribute('vector-effect')).toBe(false)
    expect(paths.every(path => path.getAttribute('stroke') === 'currentColor')).toBe(true)
    expect(primitives.ICON_SYMBOLS[`dsw-icon-layers-outline-${weight}`])
      .toBe(ICON_ARTWORK['layers-outline'].svg(stroke))
    const view = render(<Icon />)
    const rendered = view.container.querySelector('svg')!
    expect([rendered.getAttribute('width'), rendered.getAttribute('height')]).toEqual(['16', '16'])
    view.rerender(<Icon size={14} />)
    expect([rendered.getAttribute('width'), rendered.getAttribute('height')]).toEqual(['14', '14'])
    expect(rendered.querySelector('use')?.getAttribute('href')).toBe(`#dsw-icon-layers-outline-${weight}`)
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
