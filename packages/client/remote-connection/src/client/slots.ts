/** Replaceable settings content sharing the plugin-owned browser invitation. */
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { RemoteConnectionFace } from './remote-connection-controller.ts'
import type { LoginLinkFace } from './login-link-controller.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * Complete Remote connection panel with shared invitation state and actions.
     * Receives invitation and login-link selectors, their actions, and close().
     * Unloading a replacement restores the default panel with the current invitation.
     */
    'settings.remoteConnection.content': {
      kind: 'single'
      scope: 'root'
      owner: SettingsSectionOwnerProps
      inject: RemoteConnectionFace & LoginLinkFace
    }
  }
}

/** Settings close action, invitation selector, and create/cancel/reload actions supplied to every panel. */
export type RemoteConnectionContentProps = PropsRuntime<'settings.remoteConnection.content'>
