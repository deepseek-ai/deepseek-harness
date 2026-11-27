/** User controls for the default subagent route and model-selectable delegation in every session. */

import { useId, useState } from 'react'
import { IconChevronDownOutlineRegular, Menu, type MenuEntry, Switch } from '@deepseek-ai/dsh-client-ui-primitives/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots/client'
import type {
  SubagentModelCandidate,
  SubagentModelSelectionCardFace,
  SubagentModelSelectionCardState,
} from './subagent-model-selection-card-controller.ts'
import css from './SubagentModelSelectionFields.module.css'
import fieldCss from './SubagentDefaultModelField.module.css'

/** Plain model state and callbacks supplied by the owning Subagent card. */
export type SubagentModelSelectionFieldsProps = PropsLocale<'settings.subagent'>
  & Pick<SubagentModelSelectionCardFace, 'toggleEnabled' | 'toggleModel' | 'retryCatalog' | 'selectDefault'>
  & { state: SubagentModelSelectionCardState }

/** Candidates split into advertised provider groups and stored routes no adapter advertises. */
function groupCandidates(candidates: readonly SubagentModelCandidate[]) {
  const groups = new Map<string, {
    providerName: string
    candidates: SubagentModelCandidate[]
  }>()
  const unavailable: SubagentModelCandidate[] = []
  for (const candidate of candidates) {
    if (!candidate.available) {
      unavailable.push(candidate)
      continue
    }
    const group = groups.get(candidate.provider)
    if (group === undefined) {
      groups.set(candidate.provider, {
        providerName: candidate.providerName,
        candidates: [candidate],
      })
    } else {
      group.candidates.push(candidate)
    }
  }
  return { groups, unavailable }
}

/**
 * Render the default route, the default-off preference, and its exact adapter-route choices.
 * @param props - locale copy, the card snapshot, and its actions.
 * @returns the default model, model permission, and route choices inside the shared card.
 */
export function SubagentModelSelectionFields(props: SubagentModelSelectionFieldsProps) {
  const { t, state } = props
  const defaultId = useId()
  const [open, setOpen] = useState(false)
  const disabled = !state.writable || state.saving
  if (open && disabled) setOpen(false)
  const { groups: availableGroups, unavailable } = groupCandidates(state.candidates)
  const defaults = groupCandidates(state.defaultCandidates)
  const inherit = t('subagentDefaultModelInherit')
  const defaultKey = state.defaultKey ?? ''
  const items: MenuEntry[] = [{ id: '', label: inherit }]
  let defaultLabel = inherit
  for (const [provider, group] of defaults.groups) {
    items.push({ type: 'label', id: `provider:${provider}`, text: group.providerName })
    for (const model of group.candidates) {
      const fullName = `${model.modelName} · ${group.providerName}`
      items.push({ id: model.key, label: (
        <>
          <span aria-hidden="true" title={model.modelName}>{model.modelName}</span>
          <span className={fieldCss.srOnly}>{fullName}</span>
        </>
      ) })
      if (model.key === defaultKey) defaultLabel = fullName
    }
  }
  if (defaults.unavailable.length > 0) {
    items.push({ type: 'label', id: 'unavailable', text: t('subagentModelSelectionUnavailableGroup') })
    for (const model of defaults.unavailable) {
      const label = `${model.provider}/${model.model}`
      items.push({ id: model.key, label })
      if (model.key === defaultKey) defaultLabel = label
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
  const catalogFeedback = (
    <>
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
    </>
  )
  return (
    <>
      <div className={css.toggleRow}>
        <div className={css.permission}>
          <label id={`${defaultId}-label`} htmlFor={defaultId}>{t('subagentDefaultModel')}</label>
          <p className={css.hint} id={`${defaultId}-hint`}>{t('subagentDefaultModelHint')}</p>
        </div>
        <Menu
          className={fieldCss.anchor}
          portal align="end" autoFocus minWidthFromAnchor
          open={open} onClose={() => { setOpen(false) }}
          items={items} selectedId={defaultKey}
          onSelect={(key) => {
            setOpen(false)
            if (key !== defaultKey) props.selectDefault(key === '' ? undefined : key)
          }}
          anchor={(
            <button type="button" id={defaultId} className={fieldCss.select} disabled={disabled}
              aria-haspopup="menu" aria-expanded={open}
              aria-labelledby={`${defaultId}-label ${defaultId}-value`} aria-describedby={`${defaultId}-hint`}
              onClick={() => { setOpen(!open) }}>
              <span id={`${defaultId}-value`} className={fieldCss.value}>{defaultLabel}</span>
              <IconChevronDownOutlineRegular size={12} className={fieldCss.chevron} />
            </button>
          )}
        />
      </div>
      {!state.enabled && catalogFeedback}
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
            {catalogFeedback}
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
