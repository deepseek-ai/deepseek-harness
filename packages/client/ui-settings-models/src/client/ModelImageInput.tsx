/** Image-input declarations shared by the DeepSeek and pi-ai catalog editors. */

import type { ReactNode } from 'react'
import type { DeepSeekModelDraft } from './DeepSeekModelsEditor.tsx'
import type { ModelsKey } from './locales.ts'
import styles from './ModelsSection.module.css'

/** Props of {@link ModelImageInput}. */
interface ModelImageInputProps {
  /** Effective model row, including fields outside the curated editor. */
  model: DeepSeekModelDraft
  /** Adapter-owned field; pi-ai inherits capabilities when absent or empty. */
  field: 'inputModalities' | 'input'
  /** One-based row position for the accessible label. */
  position: number
  /** Prevent changes while read-only or saving. */
  disabled: boolean
  /** Section copy. */
  t: (key: ModelsKey) => string
  /** Replace this row, preserving unrelated configuration. */
  onChange: (model: DeepSeekModelDraft) => void
}

/**
 * Edit image support while retaining an explicit choice to inherit defaults.
 * @param props - model declaration and row replacement action.
 * @returns the labeled image-input selector.
 */
export function ModelImageInput({ model, field, position, disabled, t, onChange }: ModelImageInputProps): ReactNode {
  const modalities = model[field]
  const value = !Array.isArray(modalities) || modalities.length === 0
    ? 'default'
    : modalities.includes('image') ? 'enabled' : 'disabled'
  return (
    <label className={styles['modelField']}>
      <span className={styles['modelFieldLabel']}>{t('modelImageInput')}</span>
      <select
        className={`${styles['input']} ${styles['selectInput']}`}
        aria-label={`${t('modelImageInput')} ${String(position)}`}
        value={value}
        disabled={disabled}
        onChange={(event) => {
          const choice = event.target.value
          const next = { ...model }
          if (choice === 'default') Reflect.deleteProperty(next, field)
          else next[field] = choice === 'enabled' ? ['text', 'image'] : ['text']
          // DeepSeek rejects image request limits on a text-only model.
          if (field === 'inputModalities' && choice !== 'enabled') {
            Reflect.deleteProperty(next, 'imagePixelBudget')
            Reflect.deleteProperty(next, 'imageMaxBytes')
          }
          onChange(next)
        }}
      >
        <option value="default">{t(field === 'inputModalities' ? 'modelImageDefaultText' : 'modelImageDefault')}</option>
        <option value="enabled">{t('modelImageEnabled')}</option>
        <option value="disabled">{t('modelImageDisabled')}</option>
      </select>
    </label>
  )
}
