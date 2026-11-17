import { useId, useRef } from 'react'
import type { ReactNode } from 'react'
import {
  Button,
  IconPlusOutlineRegular,
  IconQuestionOutlineRegular,
  IconTrashOutlineRegular,
  Switch,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot, PropsStore } from '@deepseek-ai/dsh-client-store'
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { Config } from '../config.ts'
import defaults from '../defaults.ts'
import type { createSettingsStore } from './store.ts'
import { formatPeriod, reportPeriods, validReportPeriods } from '../periods.ts'
import {
  HISTORY_MS,
  languages,
  languageText,
  outputLanguages,
  MINUTE_MS,
  PROMPT_LIMIT,
  progressPrecisions,
} from '../policy.ts'

export type EditableSettings = Pick<
  Config,
  | 'language'
  | 'progressDecimals'
  | 'segmentedProgress'
  | 'allowTodo'
  | 'autoOpenSidebar'
  | 'reminderIterations'
  | 'reportsEnabled'
  | 'taskPrompt'
  | 'summaryPrompt'
  | 'levelPrompts'
> & { periods: number[] }
export interface SettingsInjected {
  hooks: { locale: ObservableSnapshot<{ active: string }>; settings: ObservableSnapshot<ConfigFormSnapshot<Config>> }
  save: (value: EditableSettings, revision: number | undefined) => Promise<boolean>
}
type SettingsProps = PropsRuntime<'plugins.bundle.config'> &
  PropsLocale<'timeline'> &
  PropsStore<ReturnType<typeof createSettingsStore>> &
  InjectFace<SettingsInjected>

/** Materialize previous per-rollup overrides before saving level-specific instructions. */
export function editableSettings(value: Config): EditableSettings {
  const periods = reportPeriods(value)
  return {
    language: value.language,
    progressDecimals: value.progressDecimals,
    segmentedProgress: value.segmentedProgress,
    allowTodo: value.allowTodo,
    autoOpenSidebar: value.autoOpenSidebar,
    reminderIterations: value.reminderIterations,
    reportsEnabled: value.reportsEnabled,
    taskPrompt: value.taskPrompt,
    summaryPrompt: value.summaryPrompt,
    periods,
    levelPrompts: periods.map((_, index) => value.levelPrompts[index] ?? ''),
  }
}

function OptionHelp({ text }: { text: string }) {
  return (
    <Tooltip label={text} side="top" maxWidth={280} portal openOnClick>
      <button type="button" className="timeline-option-help" aria-label={text}>
        <IconQuestionOutlineRegular size={14} />
      </button>
    </Tooltip>
  )
}

function PromptCount({ length, locale }: { length: number; locale: string }) {
  return (
    <div className="timeline-prompt-foot timeline-muted">
      {length.toLocaleString(locale)} / {PROMPT_LIMIT.toLocaleString(locale)}
    </div>
  )
}

/**
 * Edit Timeline settings from its plugin detail page.
 * @param props Localized settings, draft store and save action.
 * @returns The settings form.
 */
export function Settings({ useSettings, useLocale, useStore, actions, save, t }: SettingsProps): ReactNode {
  const field = useId()
  const locale = useLocale(value => value.active)
  const source = useSettings(value => value)
  const state = useStore(value => value)
  const pending = useRef(false)
  const { draft } = state
  const value = state.draft ?? (source.value === undefined ? undefined : editableSettings(source.value))
  const periods = value?.periods ?? []
  const lastPeriod = periods.at(-1) ?? 0
  const level = Math.min(state.level, periods.length - 1)
  const selectedPeriod = periods[level]
  const summaryPrompt = (level < 0 ? value?.summaryPrompt : value?.levelPrompts[level]) ?? ''
  const unitAt = (index: number, period: number): 'minute' | 'hour' =>
    state.units[index] ?? (period >= 3600000 && period % 3600000 === 0 ? 'hour' : 'minute')
  const edit = (value: EditableSettings, patch: Partial<EditableSettings>) => {
    actions.update({
      draft: { ...value, ...patch },
      revision: state.draft === null ? source.revision : state.revision,
      messageKey: null,
    })
  }
  const submit = async (draft: EditableSettings) => {
    if (pending.current) return
    pending.current = true
    actions.update({ saving: true, messageKey: null })
    try {
      const accepted = await save(draft, state.revision)
      actions.update(accepted ? { draft: null, messageKey: 'saved' } : { messageKey: 'saveFailed' })
    } catch {
      actions.update({ messageKey: 'saveFailed' })
    } finally {
      pending.current = false
      actions.update({ saving: false })
    }
  }
  const invalidReminder =
    value !== undefined && (!Number.isSafeInteger(value.reminderIterations) || value.reminderIterations < 1)
  const invalid =
    value !== undefined &&
    (invalidReminder ||
      !languages.includes(value.language) ||
      !progressPrecisions.includes(value.progressDecimals) ||
      !validReportPeriods(periods) ||
      value.taskPrompt.length > PROMPT_LIMIT ||
      !value.summaryPrompt.trim() ||
      value.summaryPrompt.length > PROMPT_LIMIT ||
      value.levelPrompts.some(prompt => prompt.length > PROMPT_LIMIT))
  return (
    <div className="dsh-timeline timeline-settings">
      <header className="timeline-page-header">
        <div className="timeline-page-title">
          <h2>{t('settings')}</h2>
          <div className="timeline-save-actions">
            <span
              role="status"
              className={state.messageKey === 'saveFailed' ? 'timeline-error' : 'timeline-muted'}
            >
              {value === undefined
                ? ''
                : state.messageKey === null
                  ? state.draft === null
                    ? t('upToDate')
                    : t('unsaved')
                  : t(state.messageKey)}
            </span>
            {state.draft === null ? null : (
              <Button disabled={state.saving} onClick={() => { actions.update({ draft: null, messageKey: null }) }}>
                {t('discard')}
              </Button>
            )}
            <Button
              className="timeline-primary"
              disabled={state.draft === null || state.saving || invalid || !source.writable}
              onClick={draft === null ? undefined : () => { void submit(draft) }}
            >
              {t(state.saving ? 'saving' : 'save')}
            </Button>
          </div>
        </div>
      </header>
      {value === undefined ? (
        <p role="status">{t(source.status === 'loading' ? 'loading' : 'settingsUnavailable')}</p>
      ) : (
        <>
          <section className="timeline-settings-section" aria-label={t('general')}>
            <h2>{t('general')}</h2>
            <div className="timeline-config-controls">
              <div className="timeline-setting">
                <div className="timeline-setting-label">
                  <label htmlFor={`${field}-language`}>{t('language')}</label>
                  <OptionHelp text={t('languageHint')} />
                </div>
                <select
                  id={`${field}-language`}
                  value={value.language}
                  disabled={state.saving || !source.writable}
                  onChange={(event) => {
                    const language = languages.find(item => item === event.currentTarget.value)
                    if (language !== undefined) edit(value, { language })
                  }}
                >
                  <option value="ui">{t('followAppLanguage')}</option>
                  {outputLanguages.map(language => (
                    <option key={language} value={language}>
                      {languageText[language].label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="timeline-setting">
                <div className="timeline-setting-label">
                  <label htmlFor={`${field}-decimals`}>{t('progressDecimals')}</label>
                  <OptionHelp text={t('progressDecimalsHint')} />
                </div>
                <select
                  id={`${field}-decimals`}
                  value={value.progressDecimals}
                  disabled={state.saving || !source.writable}
                  onChange={(event) => {
                    const progressDecimals = progressPrecisions.find(
                      precision => String(precision) === event.currentTarget.value,
                    )
                    if (progressDecimals !== undefined) edit(value, { progressDecimals })
                  }}
                >
                  {progressPrecisions.map(precision => (
                    <option key={precision} value={precision}>
                      {precision}
                    </option>
                  ))}
                </select>
              </div>
              <div className="timeline-switch-control">
                <div className="timeline-setting-label">
                  <span>{t('segmentedProgress')}</span>
                  <OptionHelp text={t('segmentedProgressHint')} />
                </div>
                <div className="timeline-switch-row">
                  <Switch
                    checked={value.segmentedProgress}
                    label={t('segmentedProgress')}
                    disabled={state.saving || !source.writable}
                    onChange={(segmentedProgress) => { edit(value, { segmentedProgress }) }}
                  />
                </div>
              </div>
            </div>
          </section>
          <section className="timeline-settings-section" aria-label={t('taskTracking')}>
            <h2>{t('taskTracking')}</h2>
            <div className="timeline-config-controls">
              <div className="timeline-switch-control">
                <div className="timeline-setting-label">
                  <span>{t('replaceTodo')}</span>
                  <OptionHelp text={t('replaceTodoHint')} />
                </div>
                <div className="timeline-switch-row">
                  <Switch
                    checked={!value.allowTodo}
                    label={t('replaceTodo')}
                    disabled={state.saving || !source.writable}
                    onChange={(replaceTodo) => { edit(value, { allowTodo: !replaceTodo }) }}
                  />
                </div>
              </div>
              <div className="timeline-switch-control">
                <div className="timeline-setting-label">
                  <span>{t('autoOpenSidebar')}</span>
                  <OptionHelp text={t('autoOpenSidebarHint')} />
                </div>
                <div className="timeline-switch-row">
                  <Switch
                    checked={value.autoOpenSidebar}
                    label={t('autoOpenSidebar')}
                    disabled={state.saving || !source.writable}
                    onChange={(autoOpenSidebar) => { edit(value, { autoOpenSidebar }) }}
                  />
                </div>
              </div>
              <div className="timeline-setting">
                <div className="timeline-setting-label">
                  <label htmlFor={`${field}-reminder`}>{t('reminderIterations')}</label>
                  <OptionHelp text={t('reminderHint')} />
                </div>
                <span className="timeline-reminder-input">
                  <input
                    id={`${field}-reminder`}
                    type="number"
                    min={1}
                    max={Number.MAX_SAFE_INTEGER}
                    step={1}
                    value={value.reminderIterations}
                    aria-invalid={invalidReminder}
                    disabled={state.saving || !source.writable}
                    onChange={(event) => { edit(value, { reminderIterations: Number(event.currentTarget.value) }) }}
                  />
                  <span>{t('iterations')}</span>
                </span>
              </div>
            </div>
          </section>
          {invalid ? (
            <p role="alert" className="timeline-error">
              {t(invalidReminder ? 'invalidReminder' : 'invalidSettings')}
            </p>
          ) : null}
          {!source.writable ? (
            <p role="status" className="timeline-muted">
              {t('settingsReadOnly')}
            </p>
          ) : null}
          <section className="timeline-settings-section" aria-label={t('progressReports')}>
            <h2>{t('progressReports')}</h2>
            <div className="timeline-switch-control">
              <div className="timeline-setting-label">
                <span>{t('reportsEnabled')}</span>
                <OptionHelp text={t('reportsEnabledHint')} />
              </div>
              <div className="timeline-switch-row">
                <Switch
                  checked={value.reportsEnabled}
                  label={t('reportsEnabled')}
                  disabled={state.saving || !source.writable}
                  onChange={(reportsEnabled) => { edit(value, { reportsEnabled }) }}
                />
              </div>
            </div>
            <div className="timeline-config-layout">
              <section className="timeline-levels" aria-label={t('hierarchy')}>
                <h3 className="timeline-setting-label">
                  {t('hierarchy')}
                  <OptionHelp text={t('hierarchyHint')} />
                </h3>
                <button
                  className="timeline-global-choice"
                  aria-pressed={level === -1}
                  onClick={() => { actions.update({ level: -1 }) }}
                >
                  <strong>{t('globalPrompt')}</strong>
                  <small>{t('globalPromptHint')}</small>
                </button>
                <div className="timeline-level-list">
                  {periods.map((period, index) => (
                    <div className="timeline-level-row" data-level={index} key={index}>
                      <button
                        className="timeline-level-choice"
                        aria-pressed={level === index}
                        onClick={() => { actions.update({ level: index }) }}
                      >
                        <span className="timeline-level-marker" aria-hidden="true">
                          {index + 1}
                        </span>
                        <span>
                          <strong>{formatPeriod(period)}</strong>
                          <small>
                            {t('level')} {index + 1}
                          </small>
                        </span>
                      </button>
                      <div className="timeline-period-input">
                        <input
                          aria-label={`${t('period')} ${index + 1}`}
                          type="number"
                          min={unitAt(index, period) === 'hour' ? 1 / 60 : 1}
                          step="any"
                          value={period / (unitAt(index, period) === 'hour' ? 3600000 : MINUTE_MS)}
                          disabled={state.saving || !source.writable}
                          onChange={(event) => {
                            edit(value, {
                              periods: periods.map((item, position) =>
                                position === index
                                  ? Math.round(
                                    Number(event.currentTarget.value) *
                                        (unitAt(index, period) === 'hour' ? 3600000 : MINUTE_MS),
                                  )
                                  : item,
                              ),
                            }) }
                          }
                        />
                        <select
                          aria-label={`${t('unit')} ${index + 1}`}
                          value={unitAt(index, period)}
                          disabled={state.saving || !source.writable}
                          onChange={(event) => {
                            const unit = event.currentTarget.value === 'hour' ? 'hour' : 'minute'
                            actions.update({
                              units: periods.map((period, position) =>
                                position === index ? unit : unitAt(position, period),
                              ),
                            })
                          }}
                        >
                          <option value="minute">{t('minutes')}</option>
                          <option value="hour">{t('hours')}</option>
                        </select>
                      </div>
                      <Button
                        className="timeline-icon-button timeline-delete"
                        aria-label={`${t('removeLevel')} ${index + 1}`}
                        title={`${t('removeLevel')} ${index + 1}`}
                        disabled={periods.length <= 1 || state.saving || !source.writable}
                        onClick={() => {
                          edit(value, {
                            periods: periods.filter((_, position) => position !== index),
                            levelPrompts: value.levelPrompts.filter((_, position) => position !== index),
                          })
                          actions.update({
                            level: level === index ? -1 : level > index ? level - 1 : level,
                            units: periods
                              .map((period, position) => unitAt(position, period))
                              .filter((_, position) => position !== index),
                          })
                        }}
                      >
                        <IconTrashOutlineRegular size={17} />
                      </Button>
                    </div>
                  ))}
                  <button
                    className="timeline-add-level"
                    aria-label={t('addLevel')}
                    title={t('addLevel')}
                    disabled={
                      periods.length >= 5 ||
                      lastPeriod >= HISTORY_MS ||
                      invalid ||
                      state.saving ||
                      !source.writable
                    }
                    onClick={() => {
                      edit(value, {
                        periods: [...periods, Math.min(lastPeriod * 2, HISTORY_MS)],
                        levelPrompts: [...value.levelPrompts, ''],
                      })
                      actions.update({ level: periods.length })
                    }}
                  >
                    <IconPlusOutlineRegular size={20} />
                  </button>
                </div>
              </section>
              <section className="timeline-prompt-editor" aria-label={t('prompt')}>
                <div className="timeline-heading">
                  <div>
                    <h3>
                      {selectedPeriod === undefined
                        ? t('globalPrompt')
                        : `${t('levelSummary', { level: level + 1, period: formatPeriod(selectedPeriod) })} ${t('levelPrompt')}`}
                    </h3>
                  </div>
                  <Button
                    disabled={state.saving || !source.writable}
                    title={level < 0 ? t('resetPrompt') : t('resetLevelHint')}
                    onClick={() => {
                      edit(
                        value,
                        level < 0
                          ? { summaryPrompt: defaults.summaryPrompt }
                          : {
                            levelPrompts: value.levelPrompts.map((prompt, index) =>
                              index === level ? '' : prompt,
                            ),
                          },
                      ) }
                    }
                  >
                    {t('resetPrompt')}
                  </Button>
                </div>
                <p className="timeline-muted">{t(level < 0 ? 'basePromptHint' : 'rollupPromptHint')}</p>
                <textarea
                  aria-label={t('prompt')}
                  spellCheck={false}
                  maxLength={PROMPT_LIMIT}
                  value={summaryPrompt}
                  placeholder={level < 0 ? undefined : t('levelPromptPlaceholder')}
                  disabled={state.saving || !source.writable}
                  onChange={(event) => {
                    edit(
                      value,
                      level < 0
                        ? { summaryPrompt: event.currentTarget.value }
                        : {
                          levelPrompts: value.levelPrompts.map((prompt, index) =>
                            index === level ? event.currentTarget.value : prompt,
                          ),
                        },
                    ) }
                  }
                />
                <PromptCount locale={locale} length={summaryPrompt.length} />
              </section>
            </div>
          </section>
          <section className="timeline-settings-section timeline-task-prompt" aria-label={t('taskPrompt')}>
            <div className="timeline-heading">
              <h2>{t('taskPrompt')}</h2>
              <Button
                aria-label={`${t('resetPrompt')}: ${t('taskPrompt')}`}
                disabled={state.saving || !source.writable}
                onClick={() => { edit(value, { taskPrompt: defaults.taskPrompt }) }}
              >
                {t('resetPrompt')}
              </Button>
            </div>
            <p className="timeline-muted">{t('taskPromptHint')}</p>
            <div>
              <textarea
                aria-label={t('taskPrompt')}
                rows={4}
                spellCheck={false}
                maxLength={PROMPT_LIMIT}
                value={value.taskPrompt}
                disabled={state.saving || !source.writable}
                onChange={(event) => { edit(value, { taskPrompt: event.currentTarget.value }) }}
              />
              <PromptCount locale={locale} length={value.taskPrompt.length} />
            </div>
          </section>
        </>
      )}
    </div>
  )
}
