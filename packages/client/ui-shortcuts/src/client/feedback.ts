/** Localized failures shared by direct removal and inline shortcut editing. */
import type { ShortcutConfigSnapshot, ShortcutRuntime, ShortcutSaveResult } from '@deepseek-ai/dsh-client-shortcuts/protocol'
import type { ShortcutCatalogEntry } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

/**
 * Identify the unreadable preferences, their recovery path, and the bindings still in use.
 * @param config - failed read and last accepted preferences.
 * @param runtime - storage owner whose location and reload action to show.
 * @param t - shortcut dictionary.
 * @returns localized recovery guidance without replacing the stored document.
 */
export function shortcutReadFailure(config: ShortcutConfigSnapshot, runtime: ShortcutRuntime, t: PropsLocale<'shortcuts'>['t']): string {
  const location = t(runtime === 'desktop' ? 'desktop-document' : 'web-document')
  const reload = t(runtime === 'desktop' ? 'desktop-reload' : 'web-reload')
  return `${t(config.error ?? 'read', { location, reload })} ${t(config.usingDefaults ? 'using-defaults' : 'using-accepted')}`
}

/**
 * Describe an unsuccessful preference write without losing command names.
 * @param result - rejected operation result.
 * @param catalog - current command labels.
 * @param t - shortcut dictionary.
 * @param runtime - storage owner for unreadable-document recovery guidance.
 * @returns localized diagnosis for a system toast and accessible field description.
 */
export function shortcutFailure(result: ShortcutSaveResult, catalog: readonly Pick<ShortcutCatalogEntry, 'id' | 'label'>[], t: PropsLocale<'shortcuts'>['t'], runtime: ShortcutRuntime): string {
  if (result.status === 'unreadable') return shortcutReadFailure(result.snapshot, runtime, t)
  return result.issue ? t(result.issue) : result.status === 'conflict'
    ? t('conflict', { commands: result.conflicts?.map(id => catalog.find(row => row.id === id)?.label ?? id).join(', ') ?? '' })
    : t(result.status)
}
