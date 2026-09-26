/** The shell page's staged form over the composed shell executor entry. */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  SettingsFormModel, settingsNumberField,
  type SettingsFieldState, type SettingsFormActions, type SettingsFormScope, type SettingsFormShell,
} from '@deepseek-ai/dsh-client-ui-primitives'

/** Profile entry id of the POSIX shell executor; the base bundle composes it off Windows. */
export const BASH_NS = 'bash-sandbox'
/** Profile entry id of the PowerShell executor; the base bundle composes it on Windows. */
export const PWSH_NS = 'pwsh-sandbox'

/** The shell fields this page edits — a subset of the served schema by design. */
export interface ShellSettings {
  /** Foreground command timeout in milliseconds. */
  timeoutMs?: number
  /** Per-stream in-memory output cap in bytes. */
  maxOutputBytes?: number
}

/** What the shell page renders. */
export interface ShellCardState extends SettingsFormShell {
  /** Command timeout in milliseconds. */
  timeoutMs: SettingsFieldState
  /** Per-stream output cap in bytes. */
  maxOutputBytes: SettingsFieldState
}

/** The registration-side face the shell page's slot entry injects. */
export interface ShellCardFace extends SettingsFormActions {
  hooks: {
    /** Page snapshot bound by the renderer as useShellCard. */
    shellCard: SnapshotStore<ShellCardState>
  }
}

/** Bridges one shell executor entry's form onto the page's staged form. */
export class ShellCardController {
  private readonly form: SettingsFormModel<ShellSettings>
  private readonly store: SnapshotStore<ShellCardState>

  /** @param scope - the shared configuration form of the composed shell executor entry. */
  constructor(scope: SettingsFormScope<ShellSettings>) {
    this.form = new SettingsFormModel(scope, [settingsNumberField('timeoutMs'), settingsNumberField('maxOutputBytes')])
    this.store = this.form.bind(() => this.projection())
  }

  private projection(): ShellCardState {
    return {
      ...this.form.shell(),
      timeoutMs: this.form.field('timeoutMs'),
      maxOutputBytes: this.form.field('maxOutputBytes'),
    }
  }

  /**
   * Build the face the page's slot registration injects.
   * @returns the page's snapshot and its form actions.
   */
  inject(): ShellCardFace {
    return { hooks: { shellCard: this.store }, ...this.form.actions() }
  }

  /** Release the form subscription. */
  dispose(): void { this.form.dispose() }
}
