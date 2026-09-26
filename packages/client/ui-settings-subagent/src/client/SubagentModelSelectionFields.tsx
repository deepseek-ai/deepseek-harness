/** User control for model-selectable subagent delegation in new sessions. */

import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  SubagentModelCandidate,
  SubagentModelSelectionCardFace,
  SubagentModelSelectionCardState,
} from './subagent-model-selection-card-controller.ts'
import css from './SubagentModelSelectionFields.module.css'

/** Plain model state and callbacks supplied by the owning Subagent card. */
export type SubagentModelSelectionFieldsProps = PropsLocale<'settings.subagent'>
  & Pick<SubagentModelSelectionCardFace, 'toggleEnabled' | 'toggleModel' | 'retryCatalog'>
  & { state: SubagentModelSelectionCardState }

/**
 * Render the default-off preference and its exact adapter-route choices.
 * @param props - locale copy, the card snapshot, and its toggle action.
 * @returns the model permission and route choices inside the shared card.
 */
export function SubagentModelSelectionFields(props: SubagentModelSelectionFieldsProps) {
  const { t, state } = props
  const availableGroups = new Map<string, {
    providerName: string
    candidates: SubagentModelCandidate[]
  }>()
  const unavailable: SubagentModelCandidate[] = []
  for (const candidate of state.candidates) {
    if (!candidate.available) {
      unavailable.push(candidate)
      continue
    }
    const group = availableGroups.get(candidate.provider)
    if (group === undefined) {
      availableGroups.set(candidate.provider, {
        providerName: candidate.providerName,
        candidates: [candidate],
      })
    } else {
      group.candidates.push(candidate)
    }
  }
  const renderCandidate = (candidate: SubagentModelCandidate) => (
    <label key={candidate.key} className={css.model}>
      <input
        type="checkbox"
        checked={candidate.selected}
        disabled={!state.writable || state.saving}
        onChange={() => { props.toggleModel(candidate.key) }}
      />
      <span>
        <span className={css.modelName}>{candidate.modelName}</span>
        <span className={css.route}>{`${candidate.providerName} · ${candidate.provider}/${candidate.model}`}</span>
      </span>
      {!candidate.available
        ? <span className={css.unavailable}>{t('subagentModelSelectionUnavailable')}</span>
        : null}
    </label>
  )
  return (
    <>
      <div className={css.permission}>
        <div className={css.toggleRow}>
          <span className={css.toggleLabel}>{t('subagentModelSelectionToggle')}</span>
          <Switch
            checked={state.enabled}
            label={t('subagentModelSelectionToggle')}
            disabled={!state.writable || state.saving}
            onChange={props.toggleEnabled}
          />
        </div>
        <p className={css.hint}>
          {t(state.enabled ? 'subagentModelSelectionChoose' : 'subagentModelSelectionOff')}
        </p>
      </div>
      {state.enabled
        ? (
          <div className={css.selection}>
            {state.catalogStatus === 'loading'
              ? <p className={css.notice} role="status">{t('subagentModelSelectionLoading')}</p>
              : null}
            {state.catalogStatus === 'error'
              ? (
                <div className={css.catalogError} role="alert">
                  <span>{t('subagentModelSelectionLoadFailed')}</span>
                  <button type="button" disabled={state.saving} onClick={props.retryCatalog}>
                    {t('subagentModelSelectionRetry')}
                  </button>
                </div>
              )
              : null}
            {state.catalogPartial
              ? <p className={css.notice}>{t('subagentModelSelectionPartial')}</p>
              : null}
            {state.candidates.length > 0
              ? (
                <fieldset className={css.models}>
                  <legend>{t('subagentModelSelectionAllowed')}</legend>
                  {[...availableGroups].map(([provider, group]) => (
                    <div key={provider} className={css.modelGroup}>
                      <div className={css.providerName}>{group.providerName}</div>
                      {group.candidates.map(renderCandidate)}
                    </div>
                  ))}
                  {unavailable.length > 0
                    ? (
                      <div className={css.modelGroup}>
                        <div className={css.providerName}>{t('subagentModelSelectionUnavailableGroup')}</div>
                        {unavailable.map(renderCandidate)}
                      </div>
                    )
                    : null}
                </fieldset>
              )
              : state.catalogStatus === 'ready'
                ? <p className={css.notice}>{t('subagentModelSelectionEmpty')}</p>
                : null}
            {state.invalid ? <p className={css.invalid}>{t('subagentModelSelectionRequired')}</p> : null}
          </div>
        )
        : null}
      {state.conflicted
        ? <p className={css.conflict} role="status">{t('subagentModelSelectionConflict')}</p>
        : null}
    </>
  )
}
