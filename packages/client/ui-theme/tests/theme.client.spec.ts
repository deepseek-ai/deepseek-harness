// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { stubConfigForm, type StubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import type {
  ThemeSettings,
  ThemeSnapshot,
  ThemeTokenOverrides,
} from '@deepseek-ai/dsh-client-ui-theme/client'
import { ThemeRuntime } from '@deepseek-ai/dsh-client-ui-theme/client'

const make = (host = stubConfigForm<ThemeSettings>()): {
  ctx: Context
  theme: ThemeRuntime
  events: ThemeSnapshot[]
  host: StubConfigForm<ThemeSettings>
} => {
  const ctx = new Context()
  const events: ThemeSnapshot[] = []
  ctx.on('theme/change', (snapshot) => { events.push(snapshot) })
  return { ctx, theme: new ThemeRuntime(ctx, host.scope), events, host }
}

describe('ThemeRuntime', () => {
  it('defaults to the system preference resolved against prefers-color-scheme', () => {
    const { theme } = make()
    const snapshot = theme.getTheme()
    expect(snapshot.preference).toBe('system')
    expect(snapshot.fontSize).toBe(14)
    // jsdom matchMedia is absent; system resolves to light.
    expect(snapshot.active.id).toBe('light')
    expect(snapshot.active.colorScheme).toBe('light')
    expect(snapshot.themes.map(t => t.id)).toEqual(['light', 'dark'])
  })

  it('seeds the initial font size from the boot-script body variable, ignoring junk', () => {
    // The Host boot script writes the durable size on body before any plugin
    // runs; the first snapshot must match it so activation never flashes 14.
    document.body.style.setProperty('--dsh-content-font-size', '16px')
    try {
      expect(make().theme.getTheme().fontSize).toBe(16)
      document.body.style.setProperty('--dsh-content-font-size', '99px')
      expect(make().theme.getTheme().fontSize).toBe(14)
    } finally {
      document.body.style.removeProperty('--dsh-content-font-size')
    }
  })

  it('setFontSize switches, writes through the scope, and republishes; same value is a no-op', () => {
    const { theme, events, host } = make()
    theme.setFontSize(17)
    expect(theme.getTheme().fontSize).toBe(17)
    expect(host.set).toHaveBeenCalledWith('fontSize', 17)
    expect(events).toHaveLength(1)
    theme.setFontSize(17)
    expect(events).toHaveLength(1)
    expect(host.set).toHaveBeenCalledOnce()
  })

  it('rejects out-of-range and fractional font sizes', () => {
    const { theme, events, host } = make()
    for (const px of [11, 18, 14.5, Number.NaN]) {
      expect(() => { theme.setFontSize(px) }).toThrow('outside 12..17')
    }
    expect(events).toHaveLength(0)
    expect(host.set).not.toHaveBeenCalled()
  })

  it('adopts a published Host font size without writing it back', () => {
    const { theme, events, host } = make()
    host.publish({ status: 'ready', value: { preference: 'system', fontSize: 12 }, revision: 1, writable: true })
    expect(theme.getTheme().fontSize).toBe(12)
    expect(events).toHaveLength(1)
    expect(host.set).not.toHaveBeenCalled()
  })

  it('setTheme switches, writes through the scope, republishes, and keeps DOM untouched', () => {
    const { theme, events, host } = make()
    theme.setTheme('dark')
    expect(theme.getTheme().preference).toBe('dark')
    expect(theme.getTheme().active.colorScheme).toBe('dark')
    expect(host.set).toHaveBeenCalledWith('preference', 'dark')
    expect(events).toHaveLength(1)
    expect(events[0]).toBe(theme.getTheme())
    // The service never touches presentation state.
    expect(document.body.hasAttribute('data-ds-dark-theme')).toBe(false)
    // Same-value set is a no-op (no extra event).
    theme.setTheme('dark')
    expect(events).toHaveLength(1)
    expect(host.set).toHaveBeenCalledOnce()
  })

  it('adopts a published Host section without writing it back', () => {
    const { theme, events, host } = make()
    host.publish({ status: 'ready', value: { preference: 'dark', fontSize: 14 }, revision: 1, writable: true })
    expect(theme.getTheme().preference).toBe('dark')
    expect(events).toHaveLength(1)
    expect(host.set).not.toHaveBeenCalled()
    host.publish({ value: { preference: 'dark', fontSize: 14 }, revision: 2 })
    expect(events).toHaveLength(1)
  })

  it('adopts a section already standing at construction', () => {
    const host = stubConfigForm<ThemeSettings>()
    host.publish({ status: 'ready', value: { preference: 'dark', fontSize: 14 }, revision: 1, writable: true })
    const { theme } = make(host)
    expect(theme.getTheme().preference).toBe('dark')
  })

  it('throws on unknown setTheme ids, duplicate registration, and the system id', () => {
    const { theme } = make()
    expect(() => { theme.setTheme('sepia') }).toThrow('not registered')
    expect(() => theme.register({ id: 'light', colorScheme: 'light', tokens: {} })).toThrow('already registered')
    expect(() => theme.register({ id: 'system', colorScheme: 'light', tokens: {} })).toThrow('preference')
  })

  it('registered themes join the snapshot; disposing the active one resets to default', () => {
    const { theme, events, host } = make()
    const dispose = theme.register({ id: 'sepia', colorScheme: 'light', tokens: { '--dsw-alias-bg-base': 'red' } })
    expect(theme.getTheme().themes.map(t => t.id)).toEqual(['light', 'dark', 'sepia'])
    theme.setTheme('sepia')
    expect(theme.getTheme().active.tokens['--dsw-alias-bg-base']).toBe('red')
    dispose()
    expect(theme.getTheme().preference).toBe('system')
    expect(theme.getTheme().themes.map(t => t.id)).toEqual(['light', 'dark'])
    // Custom ids are in-process extension themes; only the built-in product
    // preferences cross the Host settings schema.
    expect(host.set).not.toHaveBeenCalled()
    // register + set + dispose = three publishes; disposer is idempotent.
    expect(events.length).toBe(3)
    dispose()
    expect(events.length).toBe(3)
  })

  it('disposing an inactive theme keeps the active preference', () => {
    const { theme } = make()
    const dispose = theme.register({ id: 'sepia', colorScheme: 'light', tokens: {} })
    theme.setTheme('dark')
    dispose()
    expect(theme.getTheme().preference).toBe('dark')
  })

  it('revision increases monotonically across every publish', () => {
    const { theme, events } = make()
    theme.setTheme('dark')
    theme.setTheme('light')
    const dispose = theme.register({ id: 'sepia', colorScheme: 'dark', tokens: {} })
    dispose()
    expect(events.map(e => e.revision)).toEqual([1, 2, 3, 4])
  })

  it('stacks reversible token overrides in call order and selects the active palette value', () => {
    const { theme } = make()
    const firstTokens: ThemeTokenOverrides = {
      '--shared': { light: 'first-light', dark: 'first-dark' },
      '--first': { light: 'first-only-light', dark: 'first-only-dark' },
    }
    const disposeFirst = theme.overrideTokens('first', firstTokens)
    firstTokens['--shared']!.light = 'mutated-after-call'
    const disposeSecond = theme.overrideTokens('second', {
      '--shared': { light: 'second-light', dark: 'second-dark' },
    })

    expect(theme.getTheme().active.tokens).toMatchObject({
      '--first': 'first-only-light',
      '--shared': 'second-light',
    })
    theme.setTheme('dark')
    expect(theme.getTheme().active.tokens).toMatchObject({
      '--first': 'first-only-dark',
      '--shared': 'second-dark',
    })

    disposeSecond()
    expect(theme.getTheme().active.tokens['--shared']).toBe('first-dark')
    disposeFirst()
    expect(theme.getTheme().active.tokens['--shared']).toBeUndefined()
  })

  it('replacing one source leaves its stale disposer harmless', () => {
    const { theme, events } = make()
    const stale = theme.overrideTokens('package', {
      '--old': { light: 'old-light', dark: 'old-dark' },
    })
    const current = theme.overrideTokens('package', {
      '--new': { light: 'new-light', dark: 'new-dark' },
    })
    stale()
    expect(theme.getTheme().active.tokens).toEqual({ '--new': 'new-light' })
    current()
    current()
    expect(theme.getTheme().active.tokens).toEqual({})
    expect(events).toHaveLength(3)
  })

  it('exports sorted built-in, registered, and override-only token descriptions as copies', () => {
    const { theme } = make()
    theme.register({
      id: 'custom',
      colorScheme: 'light',
      tokens: {
        '--dsw-alias-bg-base': 'duplicate-built-in',
        '--registered': 'registered',
      },
    })
    theme.overrideTokens('package', {
      '--registered': { light: 'duplicate-registered', dark: 'duplicate-registered' },
      semanticAccent: { light: 'pink', dark: 'red' },
    })

    const tokens = theme.exportInspectTokens()
    expect(tokens.map(token => token.name)).toEqual([...tokens.map(token => token.name)].sort())
    expect(tokens.find(token => token.name === '--registered')).toMatchObject({
      valueType: 'CSS value',
      cssVariable: '--registered',
    })
    const semantic = tokens.find(token => token.name === 'semanticAccent')
    expect(semantic).toMatchObject({ valueType: 'CSS value' })
    expect(semantic).not.toHaveProperty('cssVariable')
    expect(tokens.filter(token => token.name === '--dsw-alias-bg-base')).toHaveLength(1)

    tokens[0]!.description = 'caller mutation'
    expect(theme.exportInspectTokens()[0]!.description).not.toBe('caller mutation')
  })

  it('rejects every malformed token override value with a teaching error', () => {
    const { theme } = make()
    const override = (value: unknown): void => {
      theme.overrideTokens('package', { '--bad': value } as unknown as ThemeTokenOverrides)
    }
    expect(() => { override('red') }).toThrow(/bare string.*light.*dark/)
    for (const value of [1, null, {}, { light: 1, dark: 'dark' }, { light: 'light' }]) {
      expect(() => { override(value) }).toThrow(/must map to a \{ light, dark \} pair/)
    }
  })

  it('context dispose releases the scope subscription', async () => {
    const { ctx, host } = make()
    expect(host.listenerCount()).toBe(1)
    await ctx.fiber.dispose()
    expect(host.listenerCount()).toBe(0)
  })

  describe('prefers-color-scheme resolution (stubbed matchMedia)', () => {
    type Listener = () => void
    const stubMedia = (initialMatches: boolean) => {
      const listeners = new Set<Listener>()
      const media = {
        matches: initialMatches,
        addEventListener: (_: 'change', fn: Listener) => { listeners.add(fn) },
        removeEventListener: (_: 'change', fn: Listener) => { listeners.delete(fn) },
        flip() {
          this.matches = !this.matches
          for (const fn of listeners) fn()
        },
        listenerCount: () => listeners.size,
      }
      vi.stubGlobal('matchMedia', () => media)
      return media
    }

    afterEach(() => { vi.unstubAllGlobals() })

    it('system resolves against the media query and follows OS flips', () => {
      const media = stubMedia(true)
      const { theme, events } = make()
      expect(theme.getTheme().preference).toBe('system')
      expect(theme.getTheme().active.id).toBe('dark')
      media.flip()
      expect(theme.getTheme().active.id).toBe('light')
      expect(events).toHaveLength(1)
    })

    it('OS flips do not republish while a concrete preference is set', () => {
      const media = stubMedia(false)
      const { theme, events } = make()
      theme.setTheme('light')
      expect(events).toHaveLength(1)
      media.flip()
      expect(events).toHaveLength(1)
      expect(theme.getTheme().active.id).toBe('light')
    })

    it('context dispose releases the media listener', async () => {
      const media = stubMedia(false)
      const { ctx } = make()
      expect(media.listenerCount()).toBe(1)
      await ctx.fiber.dispose()
      expect(media.listenerCount()).toBe(0)
    })
  })
})
