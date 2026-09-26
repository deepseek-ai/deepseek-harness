/**
 * The web-search provider's settings page: its endpoint, its per-request
 * search budget, and the key — which is written through the credentials
 * domain, never into the settings section, so the literal never rides a response.
 */

import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { SettingsForm, SettingsSecretField, SettingsValueField } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { formLabels } from './locales.ts'
import type { WebSearchCardFace } from './web-search-card-controller.ts'

/** Props the renderer binds for the web-search page. */
export type WebSearchCardProps =
  PropsRuntime<'plugins.item'>
  & PropsLocale<'settings.webSearch'>
  & InjectFace<WebSearchCardFace>

/**
 * Render the web-search provider's one-liner or its settings form, as the Plugins page asks.
 * @param props - the view asked for, locale copy, the form snapshot, and its actions.
 * @returns the one-liner, or the form.
 */
export function WebSearchCard(props: WebSearchCardProps) {
  const { t } = props
  const state = props.useWebSearchCard(snapshot => snapshot)
  if (props.view === 'summary') return t('description')
  const disabled = !state.writable
  return (
    <SettingsForm labels={formLabels(t)} state={state} onSave={props.save} onDiscard={props.discard}>
      <SettingsSecretField
        id="plugin-config-web-search-key"
        label={t('apiKey')}
        hint={t('apiKeyHint')}
        // The credentials domain accepts a key even when the settings document
        // itself is read-only; they are separate stores with separate refusals.
        // Its own writability is what disables this control — a key sourced
        // from the process environment cannot be written from here.
        disabled={!state.apiKeyWritable}
        text={state.apiKey.text}
        configured={state.apiKeyConfigured}
        stateLabel={state.apiKeyConfigured ? t('apiKeySet') : t('apiKeyUnset')}
        onEdit={(text) => { props.edit('apiKey', text) }}
      />
      <SettingsValueField
        id="plugin-config-web-search-endpoint"
        label={t('baseUrl')}
        hint={t('baseUrlHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidNumber')}
        disabled={disabled}
        {...state.baseURL}
        onEdit={(text) => { props.edit('baseURL', text) }}
        onReset={() => { props.resetField('baseURL') }}
      />
      <SettingsValueField
        id="plugin-config-web-search-max-uses"
        label={t('maxUses')}
        hint={t('maxUsesHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidNumber')}
        numeric
        disabled={disabled}
        {...state.maxUses}
        onEdit={(text) => { props.edit('maxUses', text) }}
        onReset={() => { props.resetField('maxUses') }}
      />
    </SettingsForm>
  )
}
