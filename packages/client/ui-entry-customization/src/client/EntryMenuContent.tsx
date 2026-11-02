/** Folded Conversation Views, plugin discovery while reachable, and creation. */
import {
  Button, IconCheckOutlineRegular, IconPinOutlineRegular, IconPluginPinwheelOutlineRegular, IconPlusOutlineRegular, MenuItemButton, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRenderFactories, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import css from './EntryMenu.module.css'

/** Navigation region whose More menu hosts one registration. */
export type EntryRegion = 'sidebar' | 'conversation' | 'rightbar'

/** Region identity and footer actions injected into each registration. */
export interface EntryMenuInjected {
  /** Region of this registration; selects analytics attributes and the Creator prompt. */
  readonly region: EntryRegion
  readonly hooks: {
    /** Whether the Plugins page navigation service is present; the discovery row shows only while it is. */
    readonly pluginNavigation: HostObservable<boolean>
  }
  /** Open the Plugins main list. */
  readonly browsePlugins: () => void
  /** Start a Creator draft with this region's prompt without sending it. */
  readonly createPlugin: () => void
}

// The three region owners declare the same fields; the sidebar's slot names them.
type EntryMenuContentProps = PropsRuntime<'sidebar.panellist.actions'>
  & PropsRenderFactories & PropsLocale<'entryCustomization'> & InjectFace<EntryMenuInjected>

/**
 * Render unpinned sidebar entries or folded Conversation Views, followed by discovery and Creator actions.
 * @param props - Owner dismissal callback, injected actions, and localized copy.
 * @returns Menu rows for the region's More menu.
 */
export function EntryMenuContent({
  entries, onOpen, onPinnedChange, region, onDismiss, usePluginNavigation, browsePlugins, createPlugin, t, renderFactorySlot,
}: EntryMenuContentProps) {
  const moreEntries = region === 'sidebar' ? entries.filter(entry => !entry.pinned) : region === 'conversation' ? entries : []
  const browsable = usePluginNavigation(present => present)
  return <>
    {moreEntries.map(entry => <div key={entry.id} className={region === 'sidebar' ? css.sidebarEntry : undefined}>
      <MenuItemButton current={entry.active === true} icon={region === 'sidebar' ? (
        <span className={css.entryIcon} aria-hidden="true">
          {renderFactorySlot('sidebar.panel.icon', { id: entry.id, size: 16, active: entry.active === true })}
        </span>
      ) : undefined}
      onSelect={() => { onDismiss(); onOpen(entry.id) }}>
        <span className={css.entryName}>
          <span className={css.entryTitle}>{entry.label}</span>
          {entry.active === true && <IconCheckOutlineRegular size={16} className={css.activeMark} />}
        </span>
      </MenuItemButton>
      {region === 'sidebar' && <span className={css.pinAnchor}>
        <Tooltip label={t('pinTooltip')} side="bottom" align="end" delayMs={500} portal>
          <Button size="sm" role="menuitem" className={css.pinButton} aria-label={t('pin', { name: entry.label })}
            onClick={() => { onDismiss(); onPinnedChange(entry.id, true) }}>
            <IconPinOutlineRegular size={14} />
          </Button>
        </Tooltip>
      </span>}
    </div>)}
    {browsable && <MenuItemButton separatorBefore={moreEntries.length > 0} icon={<IconPluginPinwheelOutlineRegular size={16} />}
      onSelect={() => { onDismiss(); browsePlugins() }}>
      {t('install')}
    </MenuItemButton>}
    <MenuItemButton icon={<IconPlusOutlineRegular size={16} />} separatorBefore={!browsable && moreEntries.length > 0}
      onSelect={() => { onDismiss(); createPlugin() }}>
      {t('create')}
    </MenuItemButton>
  </>
}
