// @vitest-environment jsdom
/** Icon sprite: default symbols, theme replacements, replacement validation, and disposal. */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { ICON_SYMBOLS } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ThemeSettings } from '@deepseek-ai/dsh-client-ui-theme/client'
import { ThemeRuntime } from '@deepseek-ai/dsh-client-ui-theme/client'
import { installIconSprite } from '../src/client/icon-sprite.ts'

const SEARCH = 'dsw-icon-search-outline-regular'
const TWO_TONE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" class="x"><circle cx="8" cy="8" r="6" fill="var(--dsw-alias-link)"/><path d="M4 8h8" stroke="currentColor"/></svg>'

async function mount() {
  const ctx = new Context()
  const theme = new ThemeRuntime(ctx, stubConfigForm<ThemeSettings>().scope)
  const fiber = ctx.plugin({ apply(scope) { installIconSprite(scope, theme.getTheme().active.icons) } })
  await fiber.await()
  const sprite = (): SVGSVGElement | null => document.querySelector('svg[data-dsh-icon-sprite]')
  const symbol = (id: string): Element | null => sprite()?.querySelector(`symbol[id="${id}"]`) ?? null
  return { ctx, theme, fiber, sprite, symbol }
}

describe('icon sprite', () => {
  it('renders one hidden symbol per default icon and removes the sprite on dispose', async () => {
    const { fiber, sprite, symbol } = await mount()
    expect(sprite()?.getAttribute('aria-hidden')).toBe('true')
    expect(sprite()?.querySelectorAll('symbol')).toHaveLength(Object.keys(ICON_SYMBOLS).length)
    expect(symbol(SEARCH)?.getAttribute('viewBox')).toBe('0 0 16 16')
    expect(symbol(SEARCH)?.getAttribute('stroke-width')).toBe('1')
    expect(symbol(SEARCH)?.querySelectorAll('path')).toHaveLength(2)
    await fiber.dispose()
    expect(sprite()).toBeNull()
  })

  it('swaps in the active theme replacement and restores the default when the theme leaves', async () => {
    const { theme, fiber, symbol } = await mount()
    const dispose = theme.register({ id: 'skin', colorScheme: 'dark', tokens: {}, icons: { [SEARCH]: TWO_TONE } })
    theme.setTheme('skin')
    const replaced = symbol(SEARCH)!
    expect(replaced.getAttribute('viewBox')).toBe('0 0 16 16')
    expect(replaced.hasAttribute('width') || replaced.hasAttribute('class')).toBe(false)
    expect(replaced.querySelector('circle')?.getAttribute('fill')).toBe('var(--dsw-alias-link)')
    const untouched = symbol('dsw-icon-plus-outline-regular')
    theme.setTheme('light')
    expect(symbol(SEARCH)?.querySelector('circle')).toBeNull()
    expect(symbol('dsw-icon-plus-outline-regular')).toBe(untouched)
    dispose()
    await fiber.dispose()
  })

  it('rejects replacements a sprite cannot render', async () => {
    const { theme, fiber } = await mount()
    const reject = (icons: Record<string, unknown>) => () => theme.register({ id: 'x', colorScheme: 'light', tokens: {}, icons })
    const svg = (body: string, root = 'xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"') => `<svg ${root}>${body}</svg>`
    expect(reject({ 'dsw-icon-nope': TWO_TONE })).toThrow(/"dsw-icon-nope" is not an ICON_SYMBOLS id/)
    expect(reject({ toString: TWO_TONE })).toThrow(/is not an ICON_SYMBOLS id/)
    expect(reject({ [SEARCH]: 1 })).toThrow(/SVG document string/)
    expect(reject({ [SEARCH]: '<svg><path></svg>' })).toThrow(/not a well-formed SVG-namespace/)
    expect(reject({ [SEARCH]: '<svg viewBox="0 0 16 16"><path/></svg>' })).toThrow(/not a well-formed SVG-namespace/)
    expect(reject({ [SEARCH]: '<g xmlns="http://www.w3.org/2000/svg"/>' })).toThrow(/not a well-formed SVG-namespace/)
    expect(reject({ [SEARCH]: svg('<path/>', 'xmlns="http://www.w3.org/2000/svg" width="16"') })).toThrow(/needs a viewBox/)
    expect(reject({ [SEARCH]: svg('<style>path{fill:red}</style>') })).toThrow(/<style> or <script>/)
    expect(reject({ [SEARCH]: svg('<mask id="root"/>') })).toThrow(/element id "root" must start with "dsw-icon-search-outline-regular-"/)
    expect(reject({ [SEARCH]: svg(`<g id="${SEARCH}"/>`) })).toThrow(/must start with/)
    expect(theme.getTheme().themes.map(t => t.id)).toEqual(['light', 'dark'])
    await fiber.dispose()
  })

  it('treats missing icons as no replacement and keeps a frozen copy of the registered ones', async () => {
    const { theme, fiber, symbol } = await mount()
    theme.register({ id: 'none', colorScheme: 'light', tokens: {}, icons: null as never })
    const icons: Record<string, string> = { [SEARCH]: TWO_TONE }
    theme.register({ id: 'skin', colorScheme: 'light', tokens: {}, icons })
    icons[SEARCH] = '<svg viewBox="0 0 16 16"><path/></svg>'
    theme.setTheme('skin')
    expect(symbol(SEARCH)?.querySelector('circle')).not.toBeNull()
    expect(Object.isFrozen(theme.getTheme().active.icons)).toBe(true)
    theme.setTheme('none')
    expect(symbol(SEARCH)?.querySelector('circle')).toBeNull()
    await fiber.dispose()
  })

  it('accepts element ids in the symbol namespace', async () => {
    const { theme, fiber, symbol } = await mount()
    theme.register({ id: 'grad', colorScheme: 'light', tokens: {}, icons: { [SEARCH]: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><linearGradient id="${SEARCH}-g"/><rect width="16" height="16" fill="url(#${SEARCH}-g)"/></svg>` } })
    theme.setTheme('grad')
    expect(symbol(SEARCH)?.querySelector('linearGradient')?.id).toBe(`${SEARCH}-g`)
    await fiber.dispose()
  })

  it('keeps every default root presentation attribute on its symbol', async () => {
    const { fiber, symbol } = await mount()
    for (const [id, markup] of Object.entries(ICON_SYMBOLS)) {
      const root = new DOMParser().parseFromString(markup, 'image/svg+xml').documentElement
      const expected = [...root.attributes].filter(({ name }) => name !== 'xmlns').map(({ name, value }) => [name, value])
      const actual = [...symbol(id)!.attributes].filter(({ name }) => name !== 'id').map(({ name, value }) => [name, value])
      expect(actual, id).toEqual(expected)
      const children = [...symbol(id)!.children]
      expect(children.length, id).toBe(root.children.length)
      expect(children.every((child, index) => child.isEqualNode(root.children[index]!)), id).toBe(true)
    }
    await fiber.dispose()
  })
})
