/**
 * The speaker control shared by the reply action row and the voice preference: a speaker while idle, four pulsing bars
 * from the click until sound, and a moving waveform while audio plays.
 */
import { IconSpeakerOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives/client'
import css from './ReadAloud.module.css'

const BARS = { loading: [0, 1, 2, 3], playing: [0, 1, 2, 3, 4] } as const

/** State, labels, and the one verb of the control. */
export interface ReadControlProps {
  /** Phase of the audio this control started; absent while idle. */
  readonly phase: 'loading' | 'playing' | undefined
  /** Name of the action that starts the audio. */
  readonly idleLabel: string
  /** Name of the action that stops it. */
  readonly busyLabel: string
  /** Whether the control refuses clicks. */
  readonly disabled?: boolean
  /** Start the audio, or stop it while it loads or plays. */
  readonly onToggle: () => void
}

/**
 * Render the control with the label of its next action as tooltip and accessible name.
 * @param props - phase, labels, and the toggle verb.
 * @returns the button.
 */
export function ReadControl({ phase, idleLabel, busyLabel, disabled, onToggle }: ReadControlProps) {
  const label = phase === undefined ? idleLabel : busyLabel
  return (
    <Tooltip label={label} side="bottom">
      <button
        type="button"
        className={css.action}
        aria-label={label}
        data-read-aloud={phase ?? 'idle'}
        data-action-ongoing={phase === undefined ? undefined : ''}
        disabled={disabled}
        onClick={onToggle}
      >
        {phase === undefined
          ? <IconSpeakerOutlineRegular />
          : <span className={css[phase]} aria-hidden="true">{BARS[phase].map(bar => <i key={bar} />)}</span>}
      </button>
    </Tooltip>
  )
}
