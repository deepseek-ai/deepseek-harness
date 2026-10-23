/**
 * The provider retry-policy fields of an editor card. Both adapter families
 * embed the same `retryPolicy` schema in a provider profile, so the card reads
 * its modes, defaults, and bounds from that schema instead of copying them.
 * An absent `retryPolicy` keeps the inherited policy; choosing a mode writes a
 * user-layer policy whose empty fields keep the inherited values.
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import type { SettingsSchemaOperations } from './schema-operations.ts'
import type { ModelsKey } from './locales.ts'
import styles from './ModelsSection.module.css'

/** One schema node of the provider's settings form. */
type SchemaNode = NonNullable<ReturnType<SettingsSchemaOperations['nodeAtPath']>>

const CODES = ['retryableCodes'] as const
const MAX_RETRIES = ['maxRetries'] as const
const INITIAL_DELAY = ['backoff', 'initialDelayMs'] as const
const MAX_DELAY = ['backoff', 'maxDelayMs'] as const
const JITTER = ['backoff', 'jitterRatio'] as const

type FieldPath = typeof CODES | typeof MAX_RETRIES | typeof INITIAL_DELAY | typeof MAX_DELAY | typeof JITTER

/** Backoff fields of both modes, as `[policy path, label]`. */
const BACKOFF_FIELDS: readonly (readonly [FieldPath, ModelsKey])[] = [
  [INITIAL_DELAY, 'retryInitialDelay'],
  [MAX_DELAY, 'retryMaxDelay'],
  [JITTER, 'retryJitter'],
]

/** Plain decimal text; prefixed forms such as `0x10` stay invalid text. */
const DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/iu

/** The inherited policy beneath the user layer, plus the schema bounds of its fields. */
export interface RetryPolicyDefaults {
  /** Mode in effect when the user layer names none. */
  mode: 'normal' | 'always'
  /** Read the inherited value of one policy field: the composition layer, then the schema default. */
  value: (path: readonly string[]) => unknown
  /** Read the schema maximum of one numeric policy field. */
  max: (path: readonly string[]) => number | undefined
}

/**
 * Resolve the inherited policy beneath the user layer.
 * @param schema - settings schema operations.
 * @param node - the `retryPolicy` schema union.
 * @param inherited - the policy the composition layer sets, if any.
 * @returns the inherited mode, field values, and field bounds.
 */
export function retryPolicyDefaults(
  schema: SettingsSchemaOperations,
  node: SchemaNode,
  inherited: unknown,
): RetryPolicyDefaults {
  const normal = node.list?.find(branch => branch.dict?.['mode']?.value === 'normal')
  const field = (path: readonly string[]) => normal === undefined ? undefined : schema.nodeAtPath(normal, path)
  return {
    mode: schema.getPath(inherited, ['mode']) === 'always' ? 'always' : 'normal',
    value: (path) => {
      const value = schema.getPath(inherited, path)
      if (value !== undefined) return value
      const fallback: unknown = field(path)?.meta.default
      return fallback
    },
    max: (path) => {
      const max: unknown = field(path)?.meta.max
      return typeof max === 'number' ? max : undefined
    },
  }
}

/** A refused drafted policy: the message and, when one field causes it, that field. */
export interface RetryPolicyFailure {
  message: string
  path?: readonly string[]
}

/**
 * The first refused field of a drafted policy, checked as `resolveRetryPolicy`
 * checks the merged policy: fields the draft leaves empty inherit.
 * @param schema - settings schema operations.
 * @param node - the `retryPolicy` schema union, which bounds every field.
 * @param policy - the drafted user-layer policy; undefined inherits.
 * @param defaults - the inherited policy beneath the draft.
 * @param t - section copy.
 * @returns the failure, or undefined when the policy is valid.
 */
export function retryPolicyFailure(
  schema: SettingsSchemaOperations,
  node: SchemaNode,
  policy: unknown,
  defaults: RetryPolicyDefaults,
  t: (key: ModelsKey) => string,
): RetryPolicyFailure | undefined {
  if (policy === undefined) return undefined
  if (typeof policy !== 'object' || policy === null || Array.isArray(policy)) {
    const message = schema.validate(node, policy)
    return message === undefined ? undefined : { message }
  }
  const fail = (key: ModelsKey, path: readonly string[]): RetryPolicyFailure => ({ message: t(key), path })
  const number = (path: readonly string[]): number => {
    const value = schema.getPath(policy, path) ?? defaults.value(path)
    return typeof value === 'number' ? value : NaN
  }
  if (schema.getPath(policy, ['mode']) === 'normal') {
    const retries = number(MAX_RETRIES)
    if (!Number.isSafeInteger(retries) || retries < 0) return fail('retryMaxRetriesInvalid', MAX_RETRIES)
    const codes = schema.getPath(policy, CODES)
    if (Array.isArray(codes)) {
      if (codes.length === 0 || codes.some(code => typeof code !== 'string' || code.length === 0)) {
        return fail('retryCodesInvalid', CODES)
      }
      if (new Set(codes).size !== codes.length) return fail('retryCodesDuplicate', CODES)
    }
  }
  for (const path of [INITIAL_DELAY, MAX_DELAY]) {
    const delay = number(path)
    const max = defaults.max(path) ?? Infinity
    if (!(delay > 0 && delay <= max)) return { message: t('retryDelayInvalid').replace('{max}', () => String(max)), path }
  }
  if (number(INITIAL_DELAY) > number(MAX_DELAY)) return fail('retryDelayOrder', INITIAL_DELAY)
  const jitter = number(JITTER)
  if (!(jitter >= 0 && jitter <= 1)) return fail('retryJitterInvalid', JITTER)
  const message = schema.validate(node, policy)
  return message === undefined ? undefined : { message }
}

/** Props of {@link RetryPolicyEditor}. */
export interface RetryPolicyEditorProps {
  /** Drafted user-layer policy; undefined inherits. */
  policy: unknown
  /** Inherited policy beneath the draft. */
  defaults: RetryPolicyDefaults
  /** Failure from {@link retryPolicyFailure}. */
  failure: RetryPolicyFailure | undefined
  /** Id of the element showing the failure message. */
  failureId: string
  /** Show the failure message below the fields; otherwise the owner shows it. */
  showFailure: boolean
  /** Section copy. */
  t: (key: ModelsKey) => string
  /** Disable edits. */
  disabled: boolean
  /** Replace the drafted policy; undefined removes the user-layer policy. */
  onChange: (next: Record<string, unknown> | undefined) => void
}

function textOf(value: unknown): string {
  if (Array.isArray(value)) return value.join(', ')
  return typeof value === 'number' || typeof value === 'string' ? String(value) : ''
}

/** Set or remove one field of a plain policy object, dropping an emptied `backoff`. */
function withField(policy: Record<string, unknown>, path: FieldPath, value: unknown): Record<string, unknown> {
  const assign = (target: Record<string, unknown>, key: string, next: unknown): void => {
    if (next === undefined) Reflect.deleteProperty(target, key)
    else target[key] = next
  }
  const result = { ...policy }
  if (path.length === 1) {
    assign(result, path[0], value)
    return result
  }
  const [parent, key] = path
  const prior = result[parent]
  const child = typeof prior === 'object' && prior !== null ? { ...prior as Record<string, unknown> } : {}
  assign(child, key, value)
  assign(result, parent, Object.keys(child).length === 0 ? undefined : child)
  return result
}

/**
 * Render the retry mode and its policy fields.
 * @param props - drafted policy, inherited values, and the draft writer.
 * @returns the retry-policy field group.
 */
export function RetryPolicyEditor(props: RetryPolicyEditorProps): ReactNode {
  const { t, disabled, defaults, failure } = props
  const policy = typeof props.policy === 'object' && props.policy !== null
    ? props.policy as Record<string, unknown>
    : undefined
  const current = policy ?? {}
  const mode = current['mode']
  // Raw text keeps partial input such as `0.` visible while it is typed.
  const [texts, setTexts] = useState<Record<string, string>>({})
  // Backoff starts folded unless the draft already customizes it.
  const [backoffOpen] = useState(() => current['backoff'] !== undefined)
  const textAt = (path: FieldPath): string => texts[path.join('.')] ?? textOf(path.reduce<unknown>(
    (value, key) => typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined, current,
  ))
  const edit = (path: FieldPath, text: string): void => {
    const trimmed = text.trim()
    setTexts(previous => ({ ...previous, [path.join('.')]: trimmed.length === 0 ? '' : text }))
    const value = path === CODES
      ? trimmed.split(',').map(code => code.trim()).filter(code => code.length > 0)
      : DECIMAL.test(trimmed) ? Number(trimmed) : trimmed
    const empty = Array.isArray(value) ? value.length === 0 : value === ''
    props.onChange(withField(current, path, empty ? undefined : value))
  }
  const field = (path: FieldPath, label: ModelsKey, className = styles['modelField']): ReactNode => {
    const invalid = failure?.path?.join('.') === path.join('.')
    return (
      <label key={path.join('.')} className={className}>
        <span className={styles['modelFieldLabel']}>{t(label)}</span>
        <input
          className={styles['input']}
          type="text"
          inputMode={path === CODES ? 'text' : path === MAX_RETRIES ? 'numeric' : 'decimal'}
          value={textAt(path)}
          placeholder={textOf(defaults.value(path))}
          aria-invalid={invalid}
          aria-describedby={invalid ? props.failureId : undefined}
          disabled={disabled}
          onChange={(event) => { edit(path, event.target.value) }}
        />
      </label>
    )
  }
  const labelId = `${props.failureId}-label`
  const modeLabel = (value: 'normal' | 'always'): string => t(value === 'normal' ? 'retryModeNormal' : 'retryModeAlways')
  return (
    <div className={styles['field']} role="group" aria-labelledby={labelId}>
      <span id={labelId} className={styles['fieldLabel']}>{t('retryPolicy')}</span>
      <select
        className={`${styles['input']} ${styles['selectInput']}`}
        value={typeof mode === 'string' ? mode : ''}
        aria-labelledby={labelId}
        aria-describedby={failure !== undefined && failure.path === undefined ? props.failureId : undefined}
        disabled={disabled}
        onChange={(event) => {
          const next = event.target.value
          setTexts({})
          if (next === '') {
            props.onChange(undefined)
            return
          }
          // Fields of the other mode stay, as the adapter accepts them; a hidden
          // retry count that is not a number could no longer be corrected.
          const kept = next === 'always' && typeof current['maxRetries'] !== 'number'
            ? withField(current, MAX_RETRIES, undefined)
            : current
          props.onChange({ ...kept, mode: next })
        }}
      >
        <option value="">{t('retryModeDefault').replace('{mode}', () => modeLabel(defaults.mode))}</option>
        <option value="normal">{modeLabel('normal')}</option>
        <option value="always">{modeLabel('always')}</option>
      </select>
      {mode === 'always' ? <span className={styles['advancedHint']}>{t('retryAlwaysHint')}</span> : null}
      {mode === 'normal' || mode === 'always'
        ? (
          <div className={styles['retryBody']}>
            {mode === 'normal'
              ? <>
                {field(MAX_RETRIES, 'retryMaxRetries', `${styles['modelField']} ${styles['retryCount']}`)}
                {field(CODES, 'retryCodes')}
              </>
              : null}
            <details className={styles['retryFold']} open={backoffOpen}>
              <summary className={styles['customizedSummary']}>{t('retryBackoff')}</summary>
              <div className={styles['retryBackoff']}>{BACKOFF_FIELDS.map(([path, label]) => field(path, label))}</div>
            </details>
          </div>
        )
        : null}
      {failure === undefined || !props.showFailure
        ? null
        : <p id={props.failureId} className={styles['error']}>{failure.message}</p>}
    </div>
  )
}
