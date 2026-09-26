// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import {
  IconAlarmClockOutlineRegular, IconApiOutlineRegular, IconArchiveOutlineRegular, IconFolderCloseRegular,
  IconGoalOutlineRegular, IconSendOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'

afterEach(cleanup)

// Icon components all share the IconProps signature; the barrel also exports
// non-icon atoms (different props shapes), so filter by prefix BEFORE typing.
const icons = Object.fromEntries(
  Object.entries(primitives).filter(([name]) => name.startsWith('Icon')),
) as Record<string, (p: primitives.IconProps) => React.JSX.Element>
const iconNames = Object.keys(icons)

describe('product icon set', () => {
  it('exports regular and medium variants for all 94 public glyphs', () => {
    expect(iconNames.length).toBe(188)
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
    for (const Icon of [primitives.IconCloseCircleFillRegular, primitives.IconCloseCircleFillMedium]) {
      const { container, unmount } = render(<Icon />)
      const paths = container.querySelectorAll('path')
      expect(paths).toHaveLength(1)
      expect(paths[0]!.getAttribute('fill')).toBe('currentColor')
      expect(paths[0]!.getAttribute('fill-rule')).toBe('evenodd')
      expect(paths[0]!.getAttribute('stroke')).toBeNull()
      expect(container.querySelector('svg')!.getAttribute('width')).toBe('16')
      unmount()
    }
  })

  it('exports the shield contour and regular stroke for composite glyphs', () => {
    const { container } = render(<primitives.IconShieldOutlineRegular />)
    expect(container.querySelector('path')?.getAttribute('d')).toBe(primitives.SHIELD_OUTLINE_PATH)
    expect(container.querySelector('svg')?.getAttribute('stroke-width')).toBe(String(primitives.ICON_REGULAR_STROKE))
  })

  it.each(iconNames)('%s renders an svg with currentColor fills and no hardcoded palette', (name) => {
    const Icon = icons[name]!
    const { container } = render(<Icon />)
    const svg = container.querySelector('svg')
    expect(svg).not.toBeNull()
    expect(svg?.getAttribute('aria-hidden')).toBe('true')
    const markup = container.innerHTML
    expect(markup).not.toMatch(/#[0-9a-fA-F]{3,8}"/)
    expect(markup).toContain('currentColor')
  })

  it('size and className props land on the root svg', () => {
    const { container } = render(<IconSendOutlineRegular size={20} className="x" />)
    const svg = container.querySelector('svg')!
    expect(svg.getAttribute('width')).toBe('20')
    expect(svg.getAttribute('height')).toBe('20')
    expect(svg.classList.contains('x')).toBe(true)
  })

  it('uses 1px regular and 1.3px medium strokes', () => {
    const regular = render(<primitives.IconSearchOutlineRegular />)
    expect(regular.container.querySelector('svg')?.getAttribute('stroke-width')).toBe('1')
    const medium = render(<primitives.IconSearchOutlineMedium />)
    expect(medium.container.querySelector('svg')?.getAttribute('stroke-width')).toBe('1.3')
  })

  it('exports regular and medium permission glyphs', () => {
    const pairs = [
      [primitives.PermissionIconReadOnlyRegular, primitives.PermissionIconReadOnlyMedium],
      [primitives.PermissionIconWorkspaceWriteRegular, primitives.PermissionIconWorkspaceWriteMedium],
      [primitives.PermissionIconFullAccessRegular, primitives.PermissionIconFullAccessMedium],
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
