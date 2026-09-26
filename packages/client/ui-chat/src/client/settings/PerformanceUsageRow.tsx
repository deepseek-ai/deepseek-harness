/** General Settings row for performance and usage detail. */

import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { PerformanceUsageMode } from '../../chat-settings.ts'
import type { PerformanceUsageInjected } from '../contract/slots.ts'
import type { ChatKey } from '../locale.ts'
import { PreferenceRow } from './PreferenceRow.tsx'

/** Registration-side performance and usage preference face. */
export interface PerformanceUsageRowInjected extends PerformanceUsageInjected {
  /** Change the performance and usage detail. */
  setPerformanceUsage: (mode: PerformanceUsageMode) => void
}

/** Full Settings-row props. */
export type PerformanceUsageRowProps =
  PropsRuntime<'settings.general.item'>
  & PropsLocale<'chat'>
  & InjectFace<PerformanceUsageRowInjected>

const OPTIONS: readonly { id: PerformanceUsageMode; label: ChatKey }[] = [
  { id: 'compact', label: 'settings.performance.compact' },
  { id: 'detailed', label: 'settings.performance.detailed' },
]

/**
 * Render the performance and usage detail selector.
 * @param props - composed Settings slot props.
 * @returns the preference row.
 */
export function PerformanceUsageRow({ usePerformanceUsage, setPerformanceUsage, t }: PerformanceUsageRowProps) {
  const mode = usePerformanceUsage(value => value)
  const selectedLabel = mode === 'detailed'
    ? 'settings.performance.detailed'
    : 'settings.performance.compact'
  return (
    <PreferenceRow
      title={t('settings.performance.title')}
      description={t('settings.performance.description')}
      value={mode}
      selectedLabel={t(selectedLabel)}
      options={OPTIONS.map(option => ({ id: option.id, label: t(option.label) }))}
      onSelect={(value) => { setPerformanceUsage(value as PerformanceUsageMode) }}
    />
  )
}
