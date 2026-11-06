/** Account state and presentation extension points shared with client plugins. */
import type { AccountClientMetadata, AccountView } from '@deepseek-ai/dsh-deepseek-account/types'

/** Latest account-stream availability, without notification state. */
export interface AccountUiState {
  readonly view: AccountView | undefined
  readonly failed: boolean
}

/** Read the account stream already owned by the account settings plugin. */
export interface AccountUi {
  /** Read the current state from the existing account snapshot.
   * @returns the latest account state.
   */
  getSnapshot(): AccountUiState
  /** Build metadata for one account request.
   * @param locale - requested language.
   * @returns this client's version, language, and timezone.
   */
  clientMetadata(locale: string): AccountClientMetadata
}

/** Account-menu presentation facts supplied to its notification extension. */
export interface AccountNotificationsOwnerProps {
  /** Whether the account menu can display notifications outside onboarding. */
  active: boolean
  /** Open the account section in the existing settings shell. */
  openAccount: () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context { accountUi: AccountUi }
  interface Events {
    /** Account stream update or loss of access. @mode parallel
     * @param state - latest account state.
     * @param reset - whether account availability, credentials, or the connection lifetime changed.
     */
    'account-ui/change'(state: AccountUiState, reset: boolean): void
    /** Explicit account refresh from Settings or a returned Platform page. @mode parallel */
    'account-ui/refresh'(): Promise<void>
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Notifications anchored at the account menu; the contribution owns its markup and lifecycle. */
    'settings.launcher.notifications': { kind: 'single'; scope: 'root'; owner: AccountNotificationsOwnerProps }
  }
}
