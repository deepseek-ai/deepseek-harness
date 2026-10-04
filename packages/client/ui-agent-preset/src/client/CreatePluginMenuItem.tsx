/** Create a plugin through the existing Creator flow from the Add plugin menu. */
import { useEffect } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { IconAgentPresetOutlineRegular, MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AgentPresetSettingsState } from './settings-store.ts'
import css from './CreatePluginMenuItem.module.css'

/** Roster and navigation supplied by the preset plugin. */
export interface CreatePluginMenuItemInjected {
  hooks: {
    agentPresets: SnapshotStore<AgentPresetSettingsState>
  }
  load: () => Promise<void>
  startCreatorDraft: () => void
}

type CreatePluginMenuItemProps = PropsRuntime<'plugins.add.actions'>
  & PropsLocale<'settings.agentPreset'> & InjectFace<CreatePluginMenuItemInjected>

/**
 * Close the Add plugin menu before opening Creator without sending a message.
 * @param props - locale, roster, dismissal and navigation callbacks.
 * @returns a stable menu item that explains why Creator is unavailable.
 */
export function CreatePluginMenuItem({
  t, useAgentPresets, load, onDismiss, startCreatorDraft,
}: CreatePluginMenuItemProps) {
  const roster = useAgentPresets(state => state)
  const enabled = roster.status === 'ready' && roster.options.some(option => option.id === 'cordis')
  useEffect(() => { void load() }, [load])

  let description = t('createPluginDescription')
  if (roster.status === 'idle' || roster.status === 'loading') description = t('createPluginChecking')
  else if (roster.status === 'error' || roster.status === 'unavailable') description = t('createPluginUnavailable')
  else if (!enabled) description = t('createPluginMissing')

  return (
    <MenuItemButton icon={<IconAgentPresetOutlineRegular size={14} />} disabled={!enabled} onSelect={() => {
      onDismiss()
      startCreatorDraft()
    }}>
      <span className={css.copy}>
        <span>{t('createPlugin')}</span>
        <span className={css.description} title={description}>{description}</span>
      </span>
    </MenuItemButton>
  )
}
