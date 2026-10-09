/** Staged translation preferences using the shared Plugins form model. */
import { SettingsFormModel, settingsTextField, type SettingsFieldState, type SettingsFormActions,
  type SettingsFormScope, type SettingsFormShell } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { LANGUAGE_PREFERENCE_PATTERN, PROVIDER_PREFERENCES, type CotTranslationPreferences } from '../preferences.ts'

/** Current drafts and the shared form status. */
export interface TranslationFormState extends SettingsFormShell {
  provider: SettingsFieldState
  targetLanguage: SettingsFieldState
}

/** Registration-side form observable and edit callbacks. */
export interface TranslationFormInjected extends SettingsFormActions {
  hooks: { translationForm: SnapshotStore<TranslationFormState> }
}

/** Stages provider and language edits until the reader saves them. */
export class TranslationPreferencesForm {
  private readonly form: SettingsFormModel<CotTranslationPreferences>
  private readonly state: SnapshotStore<TranslationFormState>

  /** @param scope - Host-backed configuration form for this plugin. */
  constructor(scope: SettingsFormScope<CotTranslationPreferences>) {
    this.form = new SettingsFormModel(scope, [{
      ...settingsTextField('provider'),
      parse: (text) => {
        const provider = text.trim()
        return provider === '' ? { kind: 'clear' }
          : PROVIDER_PREFERENCES.some(choice => choice === provider) ? { kind: 'set', value: provider } : undefined
      },
    }, {
      ...settingsTextField('targetLanguage'),
      parse: text => LANGUAGE_PREFERENCE_PATTERN.test(text.trim())
        ? { kind: 'set', value: text.trim() } : undefined,
    }])
    this.state = this.form.bind(() => ({ ...this.form.shell(), provider: this.form.field('provider'),
      targetLanguage: this.form.field('targetLanguage') }))
  }

  /**
   * Build the registration face for the preferences form.
   * @returns draft observable and shared edit/save actions.
   */
  inject(): TranslationFormInjected { return { hooks: { translationForm: this.state }, ...this.form.actions() } }
  /** Release the accepted-preference subscription. */
  dispose(): void { this.form.dispose() }
}
