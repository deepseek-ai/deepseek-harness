/** One settings card for Subagent delegation limits and model authorization. */

import { useId } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { SettingsForm } from '@deepseek-ai/dsh-client-ui-primitives'
import { formLabels } from './locales.ts'
import { SubagentLimitsFields } from './SubagentLimitsFields.tsx'
import { SubagentModelSelectionFields } from './SubagentModelSelectionFields.tsx'
import { subagentCardShell, type SubagentCardFace } from './subagent-card-controller.ts'
import css from './SubagentCard.module.css'

/** Framework-derived props for the shared Subagent settings card. */
export type SubagentCardProps = PropsRuntime<'plugins.item'>
  & PropsLocale<'settings.subagent'> & InjectFace<SubagentCardFace>

/**
 * Render the available Subagent settings with one configuration page and save footer.
 * @param props - Locale, both form snapshots, and their shared actions.
 * @returns The summary or the available settings form.
 */
export function SubagentCard(props: SubagentCardProps) {
  const { t } = props
  const limits = props.useSubagentLimitsCard(snapshot => snapshot)
  const models = props.useSubagentModelSelectionCard(snapshot => snapshot)
  const headingId = useId()
  if (props.view === 'summary') return t('subagentDescription')
  const state = subagentCardShell(limits, models)
  return (
    <SettingsForm labels={formLabels(t)}
      state={state} onSave={props.save} onDiscard={props.discard}>
      {limits.available
        ? (
          <section className={css.section} aria-labelledby={`${headingId}-limits`}>
            <h3 className={css.heading} id={`${headingId}-limits`}>{t('subagentLimitsTitle')}</h3>
            <SubagentLimitsFields t={t} state={{ ...limits, saving: state.saving }}
              edit={props.editLimit} resetField={props.resetLimit} />
          </section>
        )
        : null}
      {models.available
        ? (
          <section className={css.section} aria-labelledby={`${headingId}-models`}>
            <h3 className={css.heading} id={`${headingId}-models`}>{t('subagentModelSelectionTitle')}</h3>
            <SubagentModelSelectionFields t={t} state={{ ...models, saving: state.saving }}
              toggleEnabled={props.toggleEnabled} toggleModel={props.toggleModel} retryCatalog={props.retryCatalog} />
          </section>
        )
        : null}
    </SettingsForm>
  )
}
