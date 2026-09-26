/** Input-type declarations shared by the DeepSeek and pi-ai catalog editors. */

import type { ReactNode } from 'react'
import { Checkbox } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DeepSeekModelDraft } from './DeepSeekModelsEditor.tsx'
import type { ModelsKey } from './locales.ts'
import styles from './ModelsSection.module.css'

/** Props of {@link ModelInputTypes}. */
interface ModelInputTypesProps {
  /** Effective model row, including fields outside the curated editor. */
  model: DeepSeekModelDraft
  /** Adapter-owned field; pi-ai inherits capabilities when absent or empty. */
  field: 'inputModalities' | 'input'
  /** One-based row position for the accessible group label. */
  position: number
  /** Prevent changes while read-only or saving. */
  disabled: boolean
  /** Installed model or provider defaults when the row does not declare input types. */
  fallback?: readonly string[] | undefined
  /** Section copy. */
  t: (key: ModelsKey) => string
  /** Replace this row, preserving unrelated configuration. */
  onChange: (model: DeepSeekModelDraft) => void
}

/**
 * Edit a nonempty set of input types, displaying inherited types before an override exists.
 * @param props - model declaration and row replacement action.
 * @returns the labeled text and image checkboxes.
 */
export function ModelInputTypes({ model, field, position, disabled, fallback, t, onChange }: ModelInputTypesProps): ReactNode {
  const modalities = model[field]
  const selected = Array.isArray(modalities) && modalities.length > 0 ? modalities : fallback ?? ['text']
  return (
    <fieldset className={styles['modelInputTypes']} aria-label={`${t('modelInputTypes')} ${String(position)}`}>
      <legend className={styles['modelFieldLabel']}>{t('modelInputTypes')}</legend>
      <div className={styles['modelInputChoices']}>
        {(['text', 'image'] as const).map(modality => (
          <Checkbox
            key={modality}
            label={t(modality === 'text' ? 'modelInputText' : 'modelInputImage')}
            checked={selected.includes(modality)}
            disabled={disabled || (selected.length === 1 && selected.includes(modality))}
            onChange={(checked) => {
              const nextSelected = (['text', 'image'] as const).filter(value =>
                value === modality ? checked : selected.includes(value))
              const next = { ...model, [field]: nextSelected }
              // DeepSeek rejects image request limits on a text-only model.
              if (field === 'inputModalities' && !nextSelected.includes('image')) {
                Reflect.deleteProperty(next, 'imagePixelBudget')
                Reflect.deleteProperty(next, 'imageMaxBytes')
              }
              onChange(next)
            }}
          />
        ))}
      </div>
    </fieldset>
  )
}
