/**
 * Fixed theme snapshots for hand-built component props and the Slot test renderer.
 * @module @deepseek-ai/dsh-client-test-runtime/src/theme
 */
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots/client'
import type { ThemeDefinition, ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'

/** The theme Hook every Slot component receives. */
export type ThemeStandardProps = Pick<GlobalStandardProps, 'useTheme'>

/** Palette of the fixture theme. */
export interface ThemeHookOptions {
  /** Resolved palette of the selected built-in theme; light when omitted. */
  readonly colorScheme?: 'light' | 'dark'
}

const LIGHT: ThemeDefinition = Object.freeze({ id: 'light', colorScheme: 'light', tokens: Object.freeze({}) })
const DARK: ThemeDefinition = Object.freeze({ id: 'dark', colorScheme: 'dark', tokens: Object.freeze({}) })

/**
 * Build the snapshot ui-theme publishes for a selected built-in theme with the default font settings.
 * @param options - resolved palette; light when omitted.
 * @returns frozen snapshot whose preference and active theme name that palette.
 */
export function themeSnapshot(options: ThemeHookOptions = {}): ThemeSnapshot {
  const colorScheme = options.colorScheme ?? 'light'
  return Object.freeze({
    preference: colorScheme,
    fontSizes: Object.freeze({ text: 14, code: 11, terminal: 13 }),
    fontFamilies: Object.freeze({ text: '', code: '', terminal: '' }),
    active: colorScheme === 'dark' ? DARK : LIGHT,
    themes: Object.freeze([LIGHT, DARK]),
    revision: 0,
  })
}

/**
 * Supply `useTheme` over one fixed snapshot without subscribing to theme changes.
 * @param options - resolved palette; light when omitted.
 * @returns the theme standard prop.
 */
export function themeHooks(options: ThemeHookOptions = {}): ThemeStandardProps {
  const snapshot = themeSnapshot(options)
  return { useTheme: selector => selector(snapshot) }
}
