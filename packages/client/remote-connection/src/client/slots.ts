/** Replaceable and additive settings content sharing plugin-owned login state. */
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots/client'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { RemoteConnectionFace } from './remote-connection-controller.ts'
import type { LoginLinkFace } from './login-link-controller.ts'
import type { PairingInjected } from './PairingRequests.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots/client' {
  interface SlotMap {
    /**
     * Complete Remote connection panel with QR, login-link, and pairing approval state.
     * Receives invitation and login-link selectors, their actions, and close().
     * useApproval(selector) exposes owner-access availability and decision outcomes; decide() and dismiss() manage them.
     * Replacing this panel hides all default sections; unloading restores their current state.
     */
    'settings.remoteConnection.content': {
      kind: 'single'
      scope: 'root'
      owner: SettingsSectionOwnerProps
      inject: RemoteConnectionFace & LoginLinkFace & PairingInjected
    }
    /**
     * Additional options rendered after the active Remote connection panel.
     * Entries share its invitation, login-link, and owner-gated pairing state, actions, and close().
     * Replacing the panel does not replace these independently ordered entries.
     */
    'settings.remoteConnection.extensions': {
      kind: 'list'
      scope: 'root'
      owner: SettingsSectionOwnerProps
      inject: RemoteConnectionFace & LoginLinkFace & PairingInjected
    }
  }
}

/** Settings close action and shared QR, login-link, and owner-gated pairing state/actions supplied to every panel. */
export type RemoteConnectionContentProps = PropsRuntime<'settings.remoteConnection.content'>

/** Shared login and owner-gated pairing state, actions, and settings close action supplied to appended options. */
export type RemoteConnectionExtensionProps = PropsRuntime<'settings.remoteConnection.extensions'>
