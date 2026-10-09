/** General Settings row for work-details presentation. */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { TRANSCRIPT_VIEW_MODES, type TranscriptViewMode } from '../../chat-settings.ts'
import type { ChatKey } from '../locale.ts'
import { COLLAPSE_TIMINGS, type CollapseTiming } from '../presentation-policy.ts'
import { PreferenceRow } from './PreferenceRow.tsx'

/** Registration-side work-details preference face. */
export interface TranscriptViewRowInjected {
  hooks: {
    /** Persisted work-details preference bound as useTranscriptView. */
    transcriptView: SnapshotStore<TranscriptViewMode>
    /** Browser-local timing bound as useCollapseTiming. */
    collapseTiming: SnapshotStore<CollapseTiming>
  }
  /** Change the work-details presentation. */
  setTranscriptView: (mode: TranscriptViewMode) => void
  /** Retain collapse timing for this Client lifetime without changing Host settings. */
  setCollapseTiming: (timing: CollapseTiming) => void
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

const COLLAPSE_LABELS = {
  completion: 'settings.collapse.completion',
  'next-input': 'settings.collapse.nextInput',
} as const satisfies Record<CollapseTiming, ChatKey>

/**
 * Render work-details and browser-local collapse-timing selectors.
 * @param props - composed Settings slot props.
 * @returns the preference row.
 */
export function TranscriptViewRow({
  useTranscriptView, setTranscriptView, useCollapseTiming, setCollapseTiming, t,
}: TranscriptViewRowProps) {
  const mode = useTranscriptView(value => value)
  const timing = useCollapseTiming(value => value)
  return (
    <>
      <PreferenceRow
        title={t('settings.transcript.title')}
        description={t('settings.transcript.description')}
        value={mode}
        selectedLabel={t(LABELS[mode])}
        options={TRANSCRIPT_VIEW_MODES.map(id => ({ id, label: t(LABELS[id]) }))}
        onSelect={(value) => { setTranscriptView(value as TranscriptViewMode) }}
      />
      <PreferenceRow
        title={t('settings.collapse.title')}
        description={t('settings.collapse.description')}
        value={timing}
        selectedLabel={t(COLLAPSE_LABELS[timing])}
        options={COLLAPSE_TIMINGS.map(id => ({ id, label: t(COLLAPSE_LABELS[id]) }))}
        onSelect={(value) => { setCollapseTiming(value as CollapseTiming) }}
      />
    </>
  )
}
