/** Staged worktree row settings using the shared Plugins form model. */
import { SettingsFormModel, type SettingsFieldState, type SettingsFormActions, type SettingsFormScope,
  type SettingsFormShell } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'

/** The volatile fields of the worktree service's Config. */
export interface WorktreeSettings {
  retainOnArchive: boolean
}

/** Current drafts and the shared form status. */
export interface WorktreeFormState extends SettingsFormShell {
  retainOnArchive: SettingsFieldState
}

/** Registration-side form observable and edit callbacks. */
export interface WorktreeSettingsInjected extends SettingsFormActions {
  hooks: { worktreeForm: SnapshotStore<WorktreeFormState> }
}

/** Stages the retain switch until the reader saves it; the draft text is `true` or `false`. */
export class WorktreeSettingsForm {
  private readonly form: SettingsFormModel<WorktreeSettings>
  private readonly state: SnapshotStore<WorktreeFormState>

  /** @param scope - Host-backed configuration form of the worktree row. */
  constructor(scope: SettingsFormScope<WorktreeSettings>) {
    this.form = new SettingsFormModel(scope, [{
      field: 'retainOnArchive',
      format: value => value === true ? 'true' : 'false',
      parse: text => text === 'true' ? { kind: 'set', value: true } : text === 'false' ? { kind: 'set', value: false } : undefined,
    }])
    this.state = this.form.bind(() => ({ ...this.form.shell(), retainOnArchive: this.form.field('retainOnArchive') }))
  }

  /**
   * Build the registration face for the row page.
   * @returns draft observable and shared edit/save actions.
   */
  inject(): WorktreeSettingsInjected { return { hooks: { worktreeForm: this.state }, ...this.form.actions() } }
  /** Release the accepted-value subscription. */
  dispose(): void { this.form.dispose() }
}
