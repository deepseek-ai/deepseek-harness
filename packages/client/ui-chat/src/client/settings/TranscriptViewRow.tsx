/** General Settings row for work-details presentation. */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { TRANSCRIPT_VIEW_MODES, type TranscriptViewMode } from '../../chat-settings.ts'
import type { ChatKey } from '../locale.ts'
import { PreferenceRow } from './PreferenceRow.tsx'

/** Registration-side work-details preference face. */
export interface TranscriptViewRowInjected {
  hooks: {
    /** Persisted work-details preference bound as useTranscriptView. */
    transcriptView: SnapshotStore<TranscriptViewMode>
  }
  /** Change the work-details presentation. */
  setTranscriptView: (mode: TranscriptViewMode) => void
}

/** Full Settings-row props. */
export type TranscriptViewRowProps =
  PropsRuntime<'settings.general.item'>
  & PropsLocale<'chat'>
  & InjectFace<TranscriptViewRowInjected>

const LABELS = {
  compact: 'settings.transcript.compact',
  standard: 'settings.transcript.standard',
  detailed: 'settings.transcript.detailed',
  verbose: 'settings.transcript.verbose',
} as const satisfies Record<TranscriptViewMode, ChatKey>

/**
 * Render the work-details mode selector.
 * @param props - composed Settings slot props.
 * @returns the preference row.
 */
export function TranscriptViewRow({ useTranscriptView, setTranscriptView, t }: TranscriptViewRowProps) {
  const mode = useTranscriptView(value => value)
  return (
    <PreferenceRow
      title={t('settings.transcript.title')}
      description={t('settings.transcript.description')}
      value={mode}
      selectedLabel={t(LABELS[mode])}
      options={TRANSCRIPT_VIEW_MODES.map(id => ({ id, label: t(LABELS[id]) }))}
      onSelect={(value) => { setTranscriptView(value as TranscriptViewMode) }}
    />
  )
}
