// @vitest-environment jsdom
/** Dynamic ui-theme entry owns the global styles in dependency order. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installThemeStyles } from '../src/client/styles.ts'

const PLUGIN_ID = '@deepseek-ai/dsh-client-ui-theme'
const HAIRLINE_WIDTH = '--dsh-hairline-width'
const contexts = new Set<Context>()
let previousWidth: string
let previousPriority: string

beforeEach(() => {
  previousWidth = document.documentElement.style.getPropertyValue(HAIRLINE_WIDTH)
  previousPriority = document.documentElement.style.getPropertyPriority(HAIRLINE_WIDTH)
})

afterEach(async () => {
  for (const ctx of contexts) await ctx.fiber.dispose()
  contexts.clear()
  document.head.querySelectorAll(`style[data-plugin="${PLUGIN_ID}"]`).forEach((node) => { node.remove() })
  if (previousWidth === '') document.documentElement.style.removeProperty(HAIRLINE_WIDTH)
  else document.documentElement.style.setProperty(HAIRLINE_WIDTH, previousWidth, previousPriority)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function mountStyles() {
  const ctx = new Context()
  contexts.add(ctx)
  const fiber = ctx.plugin({ apply(scope) { installThemeStyles(scope) } })
  await fiber.await()
  return fiber
}

describe('ui-theme client styles', () => {
  it('mounts every global sheet in dependency order and removes them on dispose', async () => {
    const fiber = await mountStyles()

    const styles = [...document.head.querySelectorAll<HTMLStyleElement>(`style[data-plugin="${PLUGIN_ID}"]`)]
    expect(styles.map(style => style.dataset.pluginCss)).toEqual([
      `${PLUGIN_ID}/base.css`,
      `${PLUGIN_ID}/corner-shape.css`,
      `${PLUGIN_ID}/design-platform.css`,
      `${PLUGIN_ID}/focus.css`,
      `${PLUGIN_ID}/onboarding.css`,
      `${PLUGIN_ID}/scrollbar.css`,
      `${PLUGIN_ID}/gradient-shadow-text.css`,
      `${PLUGIN_ID}/shiki.css`,
    ])
    await fiber.dispose()
    expect(document.head.querySelectorAll(`style[data-plugin="${PLUGIN_ID}"]`)).toHaveLength(0)
    expect(document.documentElement.style.getPropertyValue(HAIRLINE_WIDTH)).toBe(previousWidth)
  })

  it('calculates the stroke when resolution notifications are unavailable', async () => {
    vi.stubGlobal('matchMedia', undefined)
    vi.stubGlobal('devicePixelRatio', 2)
    await mountStyles()
    expect(document.documentElement.style.getPropertyValue(HAIRLINE_WIDTH)).toBe('0.5px')
  })

  it('mounts and releases styles without publishing a DPR width for a detached document', async () => {
    const detached = document.implementation.createHTMLDocument('')
    vi.stubGlobal('document', detached)
    try {
      const fiber = await mountStyles()
      expect(detached.defaultView).toBeNull()
      expect(detached.head.querySelectorAll(`style[data-plugin="${PLUGIN_ID}"]`)).toHaveLength(8)
      expect(detached.documentElement.style.getPropertyValue(HAIRLINE_WIDTH)).toBe('')
      await fiber.dispose()
      expect(detached.head.querySelectorAll(`style[data-plugin="${PLUGIN_ID}"]`)).toHaveLength(0)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('acquires nothing without a browser document', () => {
    const ctx = new Context()
    contexts.add(ctx)
    vi.stubGlobal('document', undefined)
    try {
      installThemeStyles(ctx)
    } finally {
      vi.unstubAllGlobals()
    }
    expect(document.head.querySelectorAll(`style[data-plugin="${PLUGIN_ID}"]`)).toHaveLength(0)
    expect(document.documentElement.style.getPropertyValue(HAIRLINE_WIDTH)).toBe(previousWidth)
  })

  describe('DPR-aware hairline width', () => {
    let queries: MediaQueryList[]

    beforeEach(() => {
      queries = []
      vi.stubGlobal('devicePixelRatio', 3)
      vi.stubGlobal('matchMedia', (media: string): MediaQueryList => {
        const events = new EventTarget()
        const query: MediaQueryList = {
          media, matches: true, onchange: null,
          // oxlint-disable-next-line typescript/no-deprecated -- The platform interface requires both legacy members.
          addListener: vi.fn(), removeListener: vi.fn(),
          addEventListener: events.addEventListener.bind(events),
          removeEventListener: events.removeEventListener.bind(events),
          dispatchEvent: events.dispatchEvent.bind(events),
        }
        queries.push(query)
        return query
      })
    })

    it.each([
      { dpr: 1, width: 1 },
      { dpr: 1.25, width: 0.8 },
      { dpr: 2, width: 0.5 },
      { dpr: 3, width: 1 / 3 },
      { dpr: 4, width: 0.5 },
    ])('matches a 0.5px border at DPR $dpr', async ({ dpr, width }) => {
      vi.stubGlobal('devicePixelRatio', dpr)
      await mountStyles()
      expect(document.documentElement.style.getPropertyValue(HAIRLINE_WIDTH)).toBe(`${width}px`)
      expect(queries.map(query => query.media)).toEqual([`(resolution: ${dpr}dppx)`])
    })

    it('updates one document value through successive DPR changes and detaches old queries', async () => {
      await mountStyles()
      vi.stubGlobal('devicePixelRatio', 2)
      queries[0]!.dispatchEvent(new Event('change'))
      expect(document.documentElement.style.getPropertyValue(HAIRLINE_WIDTH)).toBe('0.5px')
      vi.stubGlobal('devicePixelRatio', 1)
      queries[1]!.dispatchEvent(new Event('change'))
      expect(document.documentElement.style.getPropertyValue(HAIRLINE_WIDTH)).toBe('1px')
      expect(queries.map(query => query.media)).toEqual(['(resolution: 3dppx)', '(resolution: 2dppx)', '(resolution: 1dppx)'])
      queries[0]!.dispatchEvent(new Event('change'))
      expect(queries).toHaveLength(3)
    })

    it('restores the prior declaration and releases its listener before reinstalling', async () => {
      const root = document.documentElement
      root.style.setProperty(HAIRLINE_WIDTH, '0.75px', 'important')
      const first = await mountStyles()
      expect(root.style.getPropertyPriority(HAIRLINE_WIDTH)).toBe('')
      await first.dispose()
      expect(root.style.getPropertyValue(HAIRLINE_WIDTH)).toBe('0.75px')
      expect(root.style.getPropertyPriority(HAIRLINE_WIDTH)).toBe('important')
      queries[0]!.dispatchEvent(new Event('change'))
      expect(queries).toHaveLength(1)
      vi.stubGlobal('devicePixelRatio', 2)
      const second = await mountStyles()
      expect(root.style.getPropertyValue(HAIRLINE_WIDTH)).toBe('0.5px')
      await second.dispose()
      queries[1]!.dispatchEvent(new Event('change'))
      expect(queries).toHaveLength(2)
      expect(root.style.getPropertyValue(HAIRLINE_WIDTH)).toBe('0.75px')
    })
  })
})
