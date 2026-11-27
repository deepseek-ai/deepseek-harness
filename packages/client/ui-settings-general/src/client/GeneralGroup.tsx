/** Group bodies render their declared preferences without duplicating card chrome. */
import type { PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots/client'
import type { SettingsGeneralGroupItemSlot } from '@deepseek-ai/dsh-client-ui-settings/client'

type GroupProps<K extends 'settings.general.item' | SettingsGeneralGroupItemSlot> = PropsRuntime<'settings.general.group'> & PropsRenderSlots<K>

/** @param props - authorized legacy item renderer. @returns the default preferences. */
export function GeneralGroup({ renderSlot }: GroupProps<'settings.general.item'>) {
  return renderSlot('settings.general.item', {})
}

/** @param props - authorized display renderer. @returns the session display preferences. */
export function DisplayGroup({ renderSlot }: GroupProps<'settings.general.group.display.item'>) {
  return renderSlot('settings.general.group.display.item', {})
}

/** @param props - authorized interaction renderer. @returns the interaction preferences. */
export function InteractionGroup({ renderSlot }: GroupProps<'settings.general.group.interaction.item'>) {
  return renderSlot('settings.general.group.interaction.item', {})
}

/** @param props - authorized notifications renderer. @returns the available notification preferences. */
export function NotificationsGroup({ renderSlot }: GroupProps<'settings.general.group.notifications.item'>) {
  return renderSlot('settings.general.group.notifications.item', {})
}

/** @param props - authorized data renderer. @returns the data preferences. */
export function DataGroup({ renderSlot }: GroupProps<'settings.general.group.data.item'>) {
  return renderSlot('settings.general.group.data.item', {})
}

/** @param props - authorized updates renderer. @returns release and update preferences. */
export function UpdatesGroup({ renderSlot }: GroupProps<'settings.general.group.updates.item'>) {
  return renderSlot('settings.general.group.updates.item', {})
}
