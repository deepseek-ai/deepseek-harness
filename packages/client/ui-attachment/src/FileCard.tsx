import { DocumentFileIcon, fileSizeText } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './FileCard.module.css'

/** Localized strings consumed by one pending-file card. */
export interface FileCardLabels {
  /** Card body announcement, e.g. "Pending file {name}". */
  readonly label: string
  /** Remove-button label. */
  readonly remove: string
  /** Status line while the upload is in flight. */
  readonly uploading: string
  /** Status line and retry affordance after a failed upload. */
  readonly failed: string
  /** Retry-button label. */
  readonly retry: string
}

/** Upload display state resolved by the owner. */
export type FileCardState = 'uploading' | 'ready' | 'error'

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return ''
  return name.slice(dot + 1).toUpperCase().slice(0, 8)
}

/** One pending generic-file card: name, size or upload status, remove, retry. */
export function FileCard({
  name, bytes, state, progress, labels, onRemove, onRetry,
}: {
  name: string
  bytes: number
  state: FileCardState
  progress?: number
  labels: FileCardLabels
  onRemove: () => void
  onRetry: () => void
}) {
  const extension = extensionOf(name)
  const meta = state === 'uploading'
    ? labels.uploading
    : state === 'error'
      ? labels.failed
      : [extension, fileSizeText(bytes)].filter(part => part !== '').join(' ')
  const retryable = state === 'error'
  return (
    <div
      className={`${css.card}${retryable ? ` ${css.failed}` : ''}`}
      title={name}
    >
      <span className={css.icon} aria-hidden>
        {state === 'uploading'
          ? <span className={css.spinner} />
          : <DocumentFileIcon />}
      </span>
      {retryable
        ? (
          <button type="button" className={`${css.body} ${css.retry}`} aria-label={labels.retry} onClick={onRetry}>
            <span className={css.name}>{name}</span>
            <span className={`${css.meta} ${css.metaFailed}`}>{meta}</span>
          </button>
        )
        : (
          <span className={css.body} aria-label={labels.label}>
            <span className={css.name}>{name}</span>
            <span className={css.meta}>{meta}</span>
          </span>
        )}
      <button
        type="button"
        className={retryable ? `${css.remove} ${css.removeFailed}` : css.remove}
        aria-label={labels.remove}
        onClick={onRemove}
      >
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
          <path d="M3 3L13 13M13 3L3 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>
      {state === 'uploading' && (
        <span className={css.progressTrack} aria-hidden>
          <span
            className={css.progressBar}
            style={progress === undefined ? undefined : { width: `${String(Math.min(1, Math.max(0, progress)) * 100)}%` }}
          />
        </span>
      )}
    </div>
  )
}
