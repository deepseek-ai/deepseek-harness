/**
 * One model of either adapter catalog editor. A folded row is a line of text
 * that names the model and is the drag source for reordering, marked by six
 * dots at its start while the pointer is on it; unfolding it replaces the
 * text with the fields, and an unfolded row is not dragged. A field the card's
 * last save refused is marked invalid with the reason under it.
 */

import { useId } from 'react'
import type { DragEvent, ReactNode } from 'react'
import {
  IconChevronDownOutlineRegular, IconChevronRightOutlineRegular, IconDragDotsFillRegular, IconTrashOutlineRegular,
  useRowDragPreview,
} from '@deepseek-ai/dsh-client-ui-primitives/client'
import type { DeepSeekModelDraft, ModelFailureField } from './DeepSeekModelsEditor.tsx'
import type { ModelsKey } from './locales.ts'
import { ModelInputTypes } from './ModelInputTypes.tsx'
import { ModelReasoningEfforts } from './ModelReasoningEfforts.tsx'
import type { ModelRowOrder } from './useModelRows.ts'
import styles from './ModelsSection.module.css'

/** A capacity's editable text and adapter-specific inherited hint. */
interface CapacityInput {
  value: string
  placeholder: string
  onChange: (value: string) => void
  onBlur?: () => void
}

/** Adapter-owned data and actions for one model row. */
interface ModelRowProps {
  model: DeepSeekModelDraft
  rowKey: number
  position: number
  order: ModelRowOrder
  inputField: 'inputModalities' | 'input'
  inputFallback?: readonly string[] | undefined
  inputLoading?: boolean
  /** Levels the row's `reasoningEfforts` may declare; absent or empty shows no reasoning control. */
  reasoningLevels?: readonly string[] | undefined
  /** Whether the route's protocol accepts only {@link reasoningLevels}, each sent under its own name. */
  reasoningLevelsOnly?: boolean | undefined
  expanded: boolean
  /** The fields the card's last save refused that still fail, each with its message key. */
  failures: ReadonlyMap<ModelFailureField, ModelsKey>
  disabled: boolean
  t: (key: ModelsKey) => string
  contextWindow: CapacityInput
  maxTokens: CapacityInput
  onFieldChange: (field: 'id' | 'name', value: string | undefined) => void
  onIdBlur?: (value: string) => void
  onChange: (model: DeepSeekModelDraft) => void
  onToggle: () => void
  onRemove: () => void
}

function rowHalf(event: DragEvent<HTMLElement>): 'before' | 'after' {
  const rect = event.currentTarget.getBoundingClientRect()
  return event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
}

/** A row's text field, or the empty string while unset or not a string. */
function textOf(model: DeepSeekModelDraft, field: 'id' | 'name'): string {
  const value = model[field]
  return typeof value === 'string' ? value : ''
}

/**
 * Render one model row, folded or unfolded.
 * @param props - drafted fields and their owning editor's actions.
 * @returns one expandable model entry.
 */
export function ModelRow(props: ModelRowProps): ReactNode {
  const { model, position, t, disabled, failures } = props
  const preview = useRowDragPreview(styles['modelDragPreview'] as string)
  const rowId = useId()
  /** The invalid state of one field's input, and the reason shown under it. */
  const refusal = (field: ModelFailureField): { input: { 'aria-invalid'?: true; 'aria-describedby'?: string }; reason: ReactNode } => {
    const key = failures.get(field)
    if (key === undefined) return { input: {}, reason: null }
    const id = `${rowId}-${field}`
    return { input: { 'aria-invalid': true, 'aria-describedby': id }, reason: <span id={id} className={styles['error']}>{t(key)}</span> }
  }
  // Only a folded row moves: its text carries no caret or selection for a drag to interrupt.
  const draggable = !props.expanded && !disabled
  const modelField = (field: 'id' | 'name') => (
    <label className={`${styles['modelField']} ${field === 'name' ? styles['modelName'] : ''}`}>
      {field === 'name'
        ? <span className={`${styles['modelFieldLabel']} ${styles['modelNameLabel']}`}>{t('modelName')}</span>
        : null}
      <input
        className={styles['input']}
        type="text"
        value={textOf(model, field)}
        placeholder={t(field === 'id' ? 'modelId' : 'modelName')}
        aria-label={`${t(field === 'id' ? 'modelId' : 'modelName')} ${String(position)}`}
        disabled={disabled}
        {...refusal(field).input}
        onChange={(event) => {
          const value = event.target.value
          props.onFieldChange(field, field === 'name' && value === '' ? undefined : value)
        }}
        onBlur={field === 'id' ? event => props.onIdBlur?.(event.target.value) : undefined}
      />
      {refusal(field).reason}
    </label>
  )
  const id = textOf(model, 'id')
  const name = textOf(model, 'name')
  return (
    <div
      className={styles['modelEntry']}
      data-row-key={props.rowKey}
      data-invalid={failures.size > 0 || undefined}
      data-dragging={props.order.dragging || undefined}
      data-drop-target={props.order.dragging ? undefined : props.order.target}
      draggable={draggable || undefined}
      onDragStart={draggable
        ? (event) => {
          event.dataTransfer.effectAllowed = 'move'
          event.dataTransfer.setData('application/x-dsh-model-order', String(position))
          props.order.onStart()
          preview.start(event)
        }
        : undefined}
      onDragEnd={() => { if (preview.clear()) props.order.onEnd() }}
      onDragOver={(event) => {
        if (!props.order.canDrop) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        props.order.onOver(rowHalf(event))
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
        props.order.onLeave()
      }}
      onDrop={(event) => {
        if (!props.order.canDrop) return
        event.preventDefault()
        props.order.onDrop(rowHalf(event))
      }}
    >
      {/* A mark, not a control: the row is the drag source, and the mark lets pointer events through to it. */}
      {draggable
        ? <span className={styles['modelGrip']} aria-hidden="true"><IconDragDotsFillRegular /></span>
        : null}
      <div className={styles['modelRow']} data-expanded={props.expanded || undefined}>
        {props.expanded
          ? (
            <>
              {modelField('id')}
              {modelField('name')}
            </>
          )
          : (
            // A pointer shortcut for the button beside it, which is the control
            // keyboards and assistive technology unfold the row through.
            <div className={styles['modelSummary']} onClick={props.onToggle}>
              <span className={styles['modelSummaryId']} data-unnamed={id.length === 0 || undefined}>
                {id.length === 0 ? t('modelId') : id}
              </span>
              {/* The space separates the two values as text; the flex gap alone spaces them on screen. */}
              {name.length === 0 ? null : <>{' '}<span className={styles['modelSummaryName']}>{name}</span></>}
            </div>
          )}
        <button
          type="button"
          className={styles['iconButton']}
          aria-label={`${t('modelAdvanced')} ${String(position)}`}
          aria-expanded={props.expanded}
          title={t('modelAdvanced')}
          onClick={(event) => { event.currentTarget.focus(); props.onToggle() }}
        >
          {props.expanded ? <IconChevronDownOutlineRegular /> : <IconChevronRightOutlineRegular />}
        </button>
        <button
          type="button"
          className={`${styles['iconButton']} ${styles['iconButtonDanger']}`}
          aria-label={`${t('removeModel')} ${String(position)}`}
          title={t('removeModel')}
          disabled={disabled}
          onClick={props.onRemove}
        >
          <IconTrashOutlineRegular size={14} />
        </button>
        {props.expanded
          ? (
            <div className={styles['modelAdvanced']}>
              {(['contextWindow', 'maxTokens'] as const).map(field => (
                <label className={styles['modelField']} key={field}>
                  <span className={styles['modelFieldLabel']}>{t(field)}</span>
                  <input
                    className={styles['input']}
                    type="text"
                    inputMode="numeric"
                    value={props[field].value}
                    placeholder={props[field].placeholder}
                    aria-label={`${t(field)} ${String(position)}`}
                    disabled={disabled}
                    {...refusal(field).input}
                    onChange={(event) => { props[field].onChange(event.target.value) }}
                    onBlur={props[field].onBlur}
                  />
                  {refusal(field).reason}
                </label>
              ))}
              <ModelInputTypes
                model={model} field={props.inputField} position={position}
                fallback={props.inputFallback} disabled={disabled || props.inputLoading === true} t={t} onChange={props.onChange}
              />
              {props.reasoningLevels !== undefined && props.reasoningLevels.length > 0
                ? (
                  <ModelReasoningEfforts
                    model={model} levels={props.reasoningLevels} levelsOnly={props.reasoningLevelsOnly === true}
                    position={position} disabled={disabled} t={t} onChange={props.onChange}
                  />
                )
                : null}
            </div>
          )
          : null}
      </div>
    </div>
  )
}
