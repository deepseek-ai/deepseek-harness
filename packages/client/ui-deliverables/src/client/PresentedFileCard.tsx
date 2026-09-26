/** File identity, Sidebar preview, and contributed native actions for one delivery. */
import type { ReactNode } from 'react'
import { resolveWorkspacePath } from '@deepseek-ai/dsh-util-workspace-path'
import { FileTypeIcon, fileExtension } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { PresentedHost } from '../presented.ts'
import { PRESENTED_SUCCESS_HOLD_MS, PRESENTED_SUCCESS_FADE_MS, type PresentedOpenPhase } from './present-open.ts'
import { basename, type PresentedPath } from './turn-deliverables.ts'
import type { NS } from './locales.ts'
import css from './Deliverables.module.css'

function cardDescription(description: string | undefined, fallback: string): string {
  const trimmed = description?.replace(/\s*(?:\([^()]*\)|（[^（）]*）)\s*$/u, '').trim()
  return trimmed === undefined || trimmed === '' ? fallback : trimmed
}

/**
 * Render independent file actions without nesting buttons inside a clickable card.
 * @param props - durable file metadata, Sidebar preview, Host capabilities, gesture status, and localized copy.
 * @returns the file card and its anchored action menu.
 */
export function PresentedFileCard({ file, cwd, phase, host, onPreview, actions, t }: {
  file: PresentedPath
  cwd: string | undefined
  phase: PresentedOpenPhase | undefined
  host: PresentedHost | null
  onPreview: () => void
  actions: ReactNode
} & PropsLocale<typeof NS>) {
  const succeeded = phase === 'opened' || phase === 'revealed'
  const reveal = host?.fileManager ?? 'directory'
  const name = basename(file.path)
  const metadata = fileExtension(name).toUpperCase() || t('presented.file')
  const status = phase === undefined
    ? cardDescription(file.description, metadata)
    : t(reveal === 'directory' && phase === 'revealed' ? 'presented.directoryOpened'
      : reveal === 'directory' && phase === 'revealing' ? 'presented.directoryOpening'
        : reveal === 'directory' && phase === 'revealError' ? 'presented.directoryError' : `presented.${phase}`)
  return <div className={css.file} data-presented-file>
    <button type="button" className={css.cardPreview} title={resolveWorkspacePath(cwd, file.path)}
      aria-label={t('presented.previewCard', { name: file.path })} onClick={onPreview} />
    <span className={css.fileIcon}><FileTypeIcon path={file.path} size={20} /></span>
    <div className={css.fileBody}>
      <div className={css.details}>
        <span className={css.fileName}>{name}</span>
        <span className={css.description} data-presented-description role={phase === undefined ? undefined : 'status'}
          data-error={phase === 'error' || phase === 'revealError' || phase === 'nativeUnavailable' ? true : undefined}>
          <span className={css.secondaryText} data-success={succeeded || undefined}
            style={succeeded ? { animationDelay: `${PRESENTED_SUCCESS_HOLD_MS}ms`, animationDuration: `${PRESENTED_SUCCESS_FADE_MS}ms` } : undefined}>
            {status}
          </span>
          <span className={css.previewHint}>{t('presented.preview')}</span>
        </span>
      </div>
      <div className={css.actions}>{actions}</div>
    </div>
  </div>
}
