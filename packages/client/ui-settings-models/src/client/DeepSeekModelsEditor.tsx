/**
 * Curated editor for the direct DeepSeek adapter's advisory model catalog.
 * The settings layer replaces `models` as one array, so the parent supplies
 * the effective inherited rows until the first edit materializes a user
 * override; reset removes that override instead of copying defaults into it.
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import { IconPlusOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { en } from './locales.ts'
import { ModelRow } from './ModelRow.tsx'
import styles from './ModelsSection.module.css'

/** One catalog entry kept structurally open so hidden or future fields survive an edit. */
export type DeepSeekModelDraft = Record<string, unknown>

/** The catalog fields this editor writes. */
type CatalogField = 'id' | 'name' | 'contextWindow' | 'maxTokens'

/** The two token counts edited as K/M-suffixed text behind a row's disclosure. */
type CapacityField = 'contextWindow' | 'maxTokens'

/** Row index encoded in an editing-buffer key. */
function rowOf(key: string): number {
  return Number(key.slice(0, key.indexOf(':')))
}

/** Accepted capacity spellings: a decimal count with an optional K/M suffix. */
const CAPACITY_PATTERN = /^(\d+(?:\.\d+)?)([km])?$/i

/** Decimal suffix scales — `1M` is 1000K, matching how model capacities are quoted. */
const CAPACITY_SCALE = { k: 1_000, m: 1_000_000 } as const

/**
 * Read a typed capacity, so a user can write `256K` or `1M` instead of counting
 * zeroes. The stored value stays a plain token count.
 * @param text - raw field text.
 * @returns the count; `undefined` when blank (inherit), `NaN` when unreadable
 * (rejected by {@link validateDeepSeekModels} before any write).
 */
export function parseCapacity(text: string): number | undefined {
  const trimmed = text.trim()
  if (trimmed.length === 0) return undefined
  const match = CAPACITY_PATTERN.exec(trimmed)
  if (match === null) return Number.NaN
  const suffix = match[2]?.toLowerCase()
  const scale = suffix === 'k' || suffix === 'm' ? CAPACITY_SCALE[suffix] : 1
  const scaled = Number(match[1]) * scale
  // A decimal multiple is exact in intent but not in binary floating point
  // (2.3 * 1e6 lands a few ULPs high), so an integral intent snaps back.
  const rounded = Math.round(scaled)
  return Math.abs(scaled - rounded) < 1e-6 ? rounded : scaled
}

/**
 * Spell a stored count back in the shortest form that survives a round trip
 * through {@link parseCapacity}; a count that is not a whole number of
 * thousands stays written out.
 * @param value - stored capacity.
 * @returns the field text.
 */
export function formatCapacity(value: number): string {
  if (!Number.isInteger(value) || value <= 0) return String(value)
  if (value % CAPACITY_SCALE.m === 0) return `${String(value / CAPACITY_SCALE.m)}M`
  if (value % CAPACITY_SCALE.k === 0) return `${String(value / CAPACITY_SCALE.k)}K`
  return String(value)
}

/** A localized validation failure for one user-owned model array. */
export interface DeepSeekModelsValidationFailure {
  /** Zero-based model position. */
  index: number
  /** Message key owned by the Models settings section. */
  key: 'modelIdRequired' | 'modelIdDuplicate' | 'modelNameInvalid' | 'modelContextInvalid'
  | 'modelMaxTokensInvalid'
}

/** Convert a schema-validated catalog value into records without dropping hidden fields. */
export function modelDrafts(value: unknown): DeepSeekModelDraft[] {
  if (!Array.isArray(value)) return []
  return value.map(entry =>
    typeof entry === 'object' && entry !== null && !Array.isArray(entry)
      ? entry as DeepSeekModelDraft
      : {})
}

/**
 * Validate adapter constraints that the serialized schema cannot express.
 * @param value - user-owned `models` value, or undefined while inherited.
 * @returns the first invalid row, or undefined when the adapter will accept it.
 */
export function validateDeepSeekModels(value: unknown): DeepSeekModelsValidationFailure | undefined {
  if (value === undefined) return undefined
  const models = modelDrafts(value)
  const seen = new Set<string>()
  for (const [index, model] of models.entries()) {
    // Compared trimmed: surrounding whitespace is a paste artifact the adapter
    // would never match, and an untrimmed compare lets `model ` slip past the
    // duplicate check against its own twin.
    const id = model['id']
    const trimmed = typeof id === 'string' ? id.trim() : undefined
    if (trimmed === undefined || trimmed.length === 0) return { index, key: 'modelIdRequired' }
    if (seen.has(trimmed)) return { index, key: 'modelIdDuplicate' }
    seen.add(trimmed)
    const name = model['name']
    if (name !== undefined && (typeof name !== 'string' || name.length === 0)) {
      return { index, key: 'modelNameInvalid' }
    }
    const contextWindow = model['contextWindow']
    if (contextWindow !== undefined
      && (typeof contextWindow !== 'number' || !Number.isInteger(contextWindow) || contextWindow <= 0)) {
      return { index, key: 'modelContextInvalid' }
    }
    const maxTokens = model['maxTokens']
    if (maxTokens !== undefined
      && (typeof maxTokens !== 'number' || !Number.isInteger(maxTokens) || maxTokens <= 0)) {
      return { index, key: 'modelMaxTokensInvalid' }
    }
  }
  return undefined
}

/** Props of {@link DeepSeekModelsEditor}. */
export interface DeepSeekModelsEditorProps {
  /** Effective rows: inherited until the parent materializes an override. */
  models: readonly DeepSeekModelDraft[]
  /** Whether the user layer currently owns the whole array. */
  overridden: boolean
  /** Fallback context capacity used when a row omits its exact value. */
  defaultContextWindow: number | undefined
  /** Fallback output cap used when a row omits its exact value. */
  defaultMaxTokens: number | undefined
  /** Section copy. */
  t: (key: keyof typeof en) => string
  /** Disable every mutation. */
  disabled: boolean
  /** Replace the user-owned array after one visible edit. */
  onChange: (models: DeepSeekModelDraft[]) => void
  /** Remove the user-owned array and return to inheritance. */
  onReset: () => void
}

/**
 * Render the direct DeepSeek adapter's model catalog: id and display name on
 * each row, capacities and input types behind the row's own disclosure.
 * @param props - effective rows plus the array-level override actions.
 * @returns the catalog editor.
 */
export function DeepSeekModelsEditor(props: DeepSeekModelsEditorProps): ReactNode {
  // Capacities are edited as text, so a field's keystrokes are held here
  // rather than re-derived from the parsed count on every change, which would
  // rewrite `1000` to `1K` mid-word. Unreadable text is kept past blur so the
  // save-time rejection names a row the user can still see — which is why
  // this is one entry PER FIELD: a single active buffer would be displaced by
  // editing any other field, and the abandoned one would fall back to
  // rendering its stored NaN as the literal `NaN`.
  //
  // Keys carry the row index, so the two operations that move indexes maintain
  // them: `remove` re-keys around the dropped row, and reset clears them all
  // because the rows they annotated are gone.
  const [editing, setEditing] = useState<ReadonlyMap<string, string>>(() => new Map())
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set())

  const update = (index: number, key: CatalogField, value: unknown): void => {
    const next = props.models.map((model, at) => {
      const copy = { ...model }
      if (at !== index) return copy
      if (value === undefined) Reflect.deleteProperty(copy, key)
      else copy[key] = value
      return copy
    })
    props.onChange(next)
  }

  const remove = (index: number): void => {
    setEditing((current) => {
      const next = new Map<string, string>()
      for (const [key, text] of current) {
        const at = rowOf(key)
        if (at === index) continue
        // Only the row number moves; the field half of the key is untouched.
        next.set(at > index ? key.replace(/^\d+/, String(at - 1)) : key, text)
      }
      return next
    })
    setExpanded((current) => {
      const next = new Set<number>()
      for (const at of current) {
        if (at === index) continue
        next.add(at > index ? at - 1 : at)
      }
      return next
    })
    props.onChange(props.models.filter((_model, at) => at !== index).map(model => ({ ...model })))
  }

  const reset = (): void => {
    setEditing(new Map())
    setExpanded(new Set())
    props.onReset()
  }

  const toggle = (index: number): void => {
    setExpanded((current) => {
      const next = new Set(current)
      if (!next.delete(index)) next.add(index)
      return next
    })
  }

  /** The field's text: its live keystrokes, else the stored count spelled short. */
  const capacityText = (model: DeepSeekModelDraft, index: number, field: CapacityField): string => {
    const typed = editing.get(`${String(index)}:${field}`)
    if (typed !== undefined) return typed
    const value = model[field]
    return typeof value === 'number' ? formatCapacity(value) : ''
  }

  const settleCapacity = (index: number, field: CapacityField): void => {
    const key = `${String(index)}:${field}`
    const typed = editing.get(key)
    if (typed === undefined) return
    // Unreadable text stays on screen: the save-time rejection names a row the
    // user can still see and correct.
    const parsed = parseCapacity(typed)
    if (parsed !== undefined && Number.isNaN(parsed)) return
    setEditing((current) => {
      const next = new Map(current)
      next.delete(key)
      return next
    })
  }

  const capacityInput = (model: DeepSeekModelDraft, index: number, field: CapacityField, fallback: number | undefined) => ({
    value: capacityText(model, index, field),
    placeholder: fallback === undefined
      ? props.t(field === 'contextWindow' ? 'contextWindowPlaceholder' : 'maxTokensPlaceholder')
      : formatCapacity(fallback),
    onChange: (text: string) => {
      setEditing(current => new Map(current).set(`${String(index)}:${field}`, text))
      update(index, field, parseCapacity(text))
    },
    onBlur: () => { settleCapacity(index, field) },
  })

  return (
    <section className={styles['modelCatalog']} aria-label={props.t('models')}>
      <div className={styles['modelListHead']}>
        <div className={styles['modelCatalogHeading']}>
          <span className={styles['modelCatalogTitle']}>{props.t('models')}</span>
          <span className={styles['modelCatalogMeta']}>
            {props.overridden ? props.t('modelsCustomized') : props.t('modelsInherited')}
          </span>
        </div>
        {props.overridden
          ? (
            <button
              type="button"
              className={styles['linkButton']}
              disabled={props.disabled}
              onClick={reset}
            >
              {props.t('resetModels')}
            </button>
          )
          : null}
      </div>
      {props.models.length === 0
        ? <p className={styles['modelEmpty']}>{props.t('modelsEmpty')}</p>
        : (
          <div className={styles['modelList']}>
            {props.models.map((model, index) => (
              <ModelRow
                key={index}
                model={model}
                position={index + 1}
                inputField="inputModalities"
                expanded={expanded.has(index)}
                disabled={props.disabled}
                t={props.t}
                contextWindow={capacityInput(model, index, 'contextWindow', props.defaultContextWindow)}
                maxTokens={capacityInput(model, index, 'maxTokens', props.defaultMaxTokens)}
                onFieldChange={(field, value) => { update(index, field, value) }}
                onIdBlur={(value) => {
                  const trimmed = value.trim()
                  if (trimmed !== value) update(index, 'id', trimmed)
                }}
                onChange={(next) => { props.onChange(props.models.map((row, at) => at === index ? next : row)) }}
                onToggle={() => { toggle(index) }}
                onRemove={() => { remove(index) }}
              />
            ))}
          </div>
        )}
      <button
        type="button"
        className={styles['addModelButton']}
        disabled={props.disabled}
        onClick={() => { props.onChange([...props.models.map(model => ({ ...model })), { id: '' }]) }}
      >
        <IconPlusOutlineRegular size={14} />
        {props.t('addModel')}
      </button>
    </section>
  )
}
