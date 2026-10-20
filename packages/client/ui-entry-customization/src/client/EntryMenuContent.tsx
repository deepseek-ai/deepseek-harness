/** Rows of a navigation region's More menu: customizable entries, then plugin discovery and creation. */
import {
  IconPluginPinwheelOutlineRegular, IconPlusOutlineRegular, MenuItemButton,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { EntryPickerRow } from './EntryPickerRow.tsx'

/** Navigation region whose More menu hosts one registration. */
export type EntryRegion = 'sidebar' | 'conversation' | 'rightbar'

/** Region identity and footer actions injected into each registration. */
export interface EntryMenuInjected {
  /** Region of this registration; selects pin copy and the Creator prompt. */
  readonly region: EntryRegion
  /** Open the Plugins main list. */
  readonly browsePlugins: () => void
  /** Start a Creator draft with this region's prompt without sending it. */
  readonly createPlugin: () => void
}

// The three region owners declare the same fields; the sidebar's slot names them.
type EntryMenuContentProps = PropsRuntime<'sidebar.panellist.actions'>
  & PropsLocale<'entryCustomization'> & InjectFace<EntryMenuInjected>

/**
 * Render the region's entries with pin actions, then the discovery and Creator rows.
 * @param props - Owner entries and callbacks, injected region actions, and localized copy.
 * @returns Menu rows for the region's More menu.
 */
export function EntryMenuContent({
  entries, onOpen, onPinnedChange, onDismiss, region, browsePlugins, createPlugin, t,
}: EntryMenuContentProps) {
  return <>
    {entries.map((entry) => {
      const pinLabel = t(`${entry.pinned ? 'unpin' : 'pin'}.${region}`)
      return <EntryPickerRow key={entry.id} label={entry.label} pinned={entry.pinned} pinLabel={pinLabel}
        pinAccessibleLabel={t('pinLabel', { name: entry.label, action: pinLabel })} singleLine={region === 'rightbar'}
        onOpen={() => { onDismiss(); onOpen(entry.id) }}
        onPin={() => { onPinnedChange(entry.id, !entry.pinned) }} />
    })}
    <MenuItemButton icon={<IconPluginPinwheelOutlineRegular size={16} />} separatorBefore={entries.length > 0}
      onSelect={() => { onDismiss(); browsePlugins() }}>
      {t('install')}
    </MenuItemButton>
    <MenuItemButton icon={<IconPlusOutlineRegular size={16} />} onSelect={() => { onDismiss(); createPlugin() }}>
      {t('create')}
    </MenuItemButton>
  </>
}
