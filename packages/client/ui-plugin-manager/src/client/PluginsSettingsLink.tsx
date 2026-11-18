/** The Settings navigation entry that leaves Settings for the Plugins page. */
import { useEffect, type ReactNode } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the `settings.section` declaration this entry registers into.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'

/** What the entry receives from the plugin manager. */
export interface PluginsSettingsLinkInjected {
  /** Show the Plugins page's main list. */
  readonly openPlugins: () => void
}

/** Full component props assembled by the settings shell. */
export type PluginsSettingsLinkProps = PropsRuntime<'settings.section'> & InjectFace<PluginsSettingsLinkInjected>

/**
 * Selecting the entry closes Settings and opens the Plugins page; the entry has no page of its own.
 * @param props - the shell's close action and the injected navigation.
 * @returns nothing; the entry renders no content.
 */
export function PluginsSettingsLink({ close, openPlugins }: PluginsSettingsLinkProps): ReactNode {
  // Mounting is the selection: the shell mounts a page only when its navigation entry is chosen.
  useEffect(() => {
    close()
    openPlugins()
  }, [close, openPlugins])
  return null
}
