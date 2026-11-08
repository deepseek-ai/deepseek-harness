/**
 * The search settings panel edits the navigator's draft of excluded directories.
 * The navigator saves it when the panel closes, including through the magnifier.
 * The `.gitignore` choice above the list is saved as soon as it changes, as
 * the hidden-entry control in the search bar is.
 *
 * It floats over the navigator below the search field. The field that adds a
 * directory stays above the list, which alone scrolls; a new rule goes to the
 * top. The header's restore control appears while the list differs from the
 * default list in any way, order included, and replaces it with that list. The close control, Escape, and focus leaving the panel request
 * closure; focus moving to the magnifier leaves closure to its click.
 */
import { useId, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import clsx from 'clsx'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import {
  IconCloseOutlineRegular, IconPlusOutlineRegular, IconRefreshOutlineRegular, IconTrashOutlineRegular, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from './locales.ts'
import {
  addRule, defaultRules, isDefaultRules, removeRule, setRuleEnabled, type ExclusionRule, type RuleInvalidReason,
} from './search-rules.ts'
import css from './FilesBody.module.css'

/**
 * The settings panel.
 * @param props.rules - the navigator's current draft.
 * @param props.respectGitignore - whether the workspace's search leaves out entries `.gitignore` ignores.
 * @param props.onRespectGitignore - saves a new `.gitignore` choice at once.
 * @param props.trigger - the control that opens and closes the panel; focus moving to it leaves the closing to its click.
 * @param props.onChange - replaces the draft without saving preferences.
 * @param props.onClose - saves and closes the draft, returning focus to the trigger when requested.
 * @param props.t - namespace-bound translate.
 * @returns the panel.
 */
export function SearchSettings({ rules, respectGitignore, onRespectGitignore, trigger, onChange, onClose, t }: {
  readonly rules: readonly ExclusionRule[]
  readonly respectGitignore: boolean
  readonly onRespectGitignore: (respectGitignore: boolean) => void
  readonly trigger: RefObject<HTMLElement | null>
  readonly onChange: (rules: readonly ExclusionRule[]) => void
  readonly onClose: (refocus: boolean) => void
  readonly t: TranslateNS<'sidebarFiles'>
}): ReactNode {
  const [text, setText] = useState('')
  const [invalid, setInvalid] = useState<RuleInvalidReason | undefined>(undefined)
  const add = useRef<HTMLInputElement | null>(null)
  const title = useId()
  const error = useId()
  // A control that is about to disappear hands the keyboard to the add field first, so the panel keeps it.
  const keepFocus = (): void => { add.current?.focus() }
  return (
    <section
      className={css.settings}
      role="dialog"
      aria-labelledby={title}
      tabIndex={-1}
      data-files-search-settings
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.nativeEvent.isComposing) return
        // Kept from the navigator's own Escape and the overlay's close on the document.
        event.preventDefault()
        event.stopPropagation()
        onClose(true)
      }}
      onBlur={(event) => {
        const next = event.relatedTarget
        if (next instanceof Node && (event.currentTarget.contains(next) || trigger.current?.contains(next) === true)) return
        onClose(false)
      }}
    >
      <div className={css.settingsHeader}>
        <span id={title} className={css.settingsTitle}>{t('settings.title')}</span>
        {!isDefaultRules(rules) && (
          <Tooltip label={t('settings.restore')} side="bottom" portal>
            <button type="button" className={css.tool} aria-label={t('settings.restore')} data-files-settings-restore
              onClick={() => {
                keepFocus()
                onChange(defaultRules())
              }}>
              <IconRefreshOutlineRegular />
            </button>
          </Tooltip>
        )}
        <Tooltip label={t('settings.close')} side="bottom" portal>
          <button type="button" className={css.tool} aria-label={t('settings.close')} onClick={() => { onClose(true) }}>
            <IconCloseOutlineRegular />
          </button>
        </Tooltip>
      </div>
      <p className={css.settingsDescription}>{t('settings.description')}</p>
      <div className={clsx(css.rule, css.settingsOption)}>
        <label className={css.ruleLabel}>
          <input type="checkbox" className={css.ruleCheck} checked={respectGitignore} data-files-respect-gitignore
            onChange={(event) => { onRespectGitignore(event.target.checked) }} />
          <span className={css.ruleName}>{t('settings.respectGitignore')}</span>
        </label>
      </div>
      <div className={clsx(css.rule, css.addRule)}>
        <IconPlusOutlineRegular className={css.icon} />
        <input
          ref={add}
          className={css.ruleInput}
          type="text"
          value={text}
          placeholder={t('settings.add')}
          aria-label={t('settings.add')}
          aria-invalid={invalid !== undefined}
          aria-describedby={invalid === undefined ? undefined : error}
          autoComplete="off"
          spellCheck={false}
          autoFocus
          onChange={(event) => {
            setText(event.target.value)
            setInvalid(undefined)
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
            event.preventDefault()
            const added = addRule(rules, text)
            if (added.kind === 'invalid') {
              setInvalid(added.reason)
              return
            }
            onChange(added.rules)
            setText('')
          }}
        />
      </div>
      {invalid !== undefined && <p id={error} className={css.settingsError} role="alert">{t(`settings.invalid.${invalid}`)}</p>}
      <ul className={css.rules}>
        {rules.map(rule => (
          <li key={rule.path} className={clsx(css.rule, !rule.enabled && css.ruleOff)} data-files-rule={rule.path}>
            <label className={css.ruleLabel}>
              <input type="checkbox" className={css.ruleCheck} checked={rule.enabled}
                aria-label={t('settings.toggle', { path: rule.path })}
                onChange={(event) => { onChange(setRuleEnabled(rules, rule.path, event.target.checked)) }} />
              <span className={css.ruleName}>{rule.path}</span>
            </label>
            <Tooltip label={t('settings.remove', { path: rule.path })} side="bottom" portal>
              <button type="button" className={css.tool} aria-label={t('settings.remove', { path: rule.path })}
                onClick={() => {
                  keepFocus()
                  onChange(removeRule(rules, rule.path))
                }}>
                <IconTrashOutlineRegular />
              </button>
            </Tooltip>
          </li>
        ))}
      </ul>
    </section>
  )
}
