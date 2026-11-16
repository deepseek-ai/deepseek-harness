/** Replaceable and additive settings content sharing plugin-owned login state. */
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
    /**
     * Additional options rendered after the active Remote connection panel.
     * Entries share its invitation and login-link state, actions, and close().
     * Replacing the panel does not replace these independently ordered entries.
     */
    'settings.remoteConnection.extensions': {
      kind: 'list'
      scope: 'root'
      owner: SettingsSectionOwnerProps
      inject: RemoteConnectionFace & LoginLinkFace
    }
  }
}

/** Settings close action, invitation selector, and create/cancel/reload actions supplied to every panel. */
export type RemoteConnectionContentProps = PropsRuntime<'settings.remoteConnection.content'>

/** Shared login state, actions, and settings close action supplied to appended options. */
export type RemoteConnectionExtensionProps = PropsRuntime<'settings.remoteConnection.extensions'>
