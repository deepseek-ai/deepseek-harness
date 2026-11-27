import { useMemo, type ReactNode } from 'react'
import { Button } from './Button.tsx'
import { MarkdownText, type MarkdownLabels, type MarkdownPathImages } from './markdown/MarkdownText.tsx'
import { StateDot } from './StateDot.tsx'
import css from './DetailDocument.module.css'

/** One read of a long Markdown description, such as a plugin's detail document. */
export type DetailDocumentState =
  | { readonly status: 'loading' }
  | { readonly status: 'found'; readonly markdown: string }
  | { readonly status: 'none' }
  | { readonly status: 'error'; readonly message: string }

/** A read as owners track it: in flight, settled with a document or none, or failed with a localized message. */
export type DetailDocumentRead =
  | undefined
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly markdown: string | undefined }
  | { readonly status: 'error'; readonly message: string }

/**
 * The state {@link DetailDocument} shows for an owner's read: loading until it settles, then the document, none, or the
 * failure.
 * @param read - the owner's read; undefined before it starts.
 * @returns the state to show.
 */
export function detailDocumentState(read: DetailDocumentRead): DetailDocumentState {
  if (read?.status === 'ready') return read.markdown === undefined ? { status: 'none' } : { status: 'found', markdown: read.markdown }
  return read?.status === 'error' ? read : { status: 'loading' }
}

/** Translated strings of a detail document's chrome, as an owner's dictionary supplies them. */
export interface DetailDocumentCopy {
  readonly title: string
  readonly loading: string
  readonly retry: string
  readonly copy: string
  readonly copied: string
  readonly codeBlock: string
  readonly wrap: string
  readonly unwrap: string
  readonly footnotes: string
}

/**
 * Assemble reference-stable labels for {@link DetailDocument} from translated strings.
 * @param copy - the translated strings.
 * @returns labels that keep their identity while the strings stay equal.
 */
export function useDetailDocumentLabels(copy: DetailDocumentCopy): DetailDocumentLabels {
  const { title, loading, retry, footnotes } = copy
  const { copy: copyLabel, copied: copiedLabel, codeBlock: codeLabel, wrap: wrapLabel, unwrap: unwrapLabel } = copy
  const markdown = useMemo(() => ({ code: { copyLabel, copiedLabel, toolbarLabels: { codeLabel, wrapLabel, unwrapLabel } }, footnotes }),
    [copyLabel, copiedLabel, codeLabel, wrapLabel, unwrapLabel, footnotes])
  return useMemo(() => ({ title, loading, retry, markdown }), [title, loading, retry, markdown])
}

/** Localized chrome of a detail document. */
export interface DetailDocumentLabels {
  /** Accessible name of the scrollable document region; the section shows no heading of its own. */
  readonly title: string
  /** Accessible name of the loading placeholder. */
  readonly loading: string
  /** Retry button text. */
  readonly retry: string
  readonly markdown: MarkdownLabels
}

/**
 * A section showing a long Markdown description, without a heading of its own: three skeleton lines while it loads, the
 * document once found, or the owner's failure message with a retry. Nothing renders for `none`. A document taller than
 * the section's height limit scrolls inside it, and the scroll region, named by `labels.title`, takes keyboard focus.
 * Raw HTML is omitted, relative links stay text, and only images the owner's `images` resolver accepts, or absolute
 * HTTP(S) images, load.
 * @param props.state - the read to show.
 * @param props.labels - localized region name, placeholder name, retry text, and Markdown chrome; keep `markdown` reference-stable.
 * @param props.images - resolves the document's relative image destinations to displayable URLs.
 * @param props.onRetry - reads the document again after a failure.
 * @returns the section, or null.
 */
export function DetailDocument({ state, labels, images, onRetry }: {
  readonly state: DetailDocumentState
  readonly labels: DetailDocumentLabels
  readonly images?: MarkdownPathImages | undefined
  readonly onRetry: () => void
}): ReactNode {
  if (state.status === 'none') return null
  let body: ReactNode
  switch (state.status) {
    case 'found':
      body = (
        <div className={css.document} role="region" aria-label={labels.title} tabIndex={0}>
          <MarkdownText text={state.markdown} labels={labels.markdown} pathImages={images} omitHtml />
        </div>
      )
      break
    case 'error':
      body = (
        <div className={css.failure}>
          <p className={css.error} role="alert"><StateDot state="error" />{state.message}</p>
          <Button variant="outline" size="sm" onClick={onRetry}>{labels.retry}</Button>
        </div>
      )
      break
    case 'loading':
      body = (
        <div className={css.skeleton} role="status" aria-label={labels.loading} aria-busy="true">
          <span className={`${css.bar} ${css.long}`} />
          <span className={`${css.bar} ${css.long}`} />
          <span className={`${css.bar} ${css.short}`} />
        </div>
      )
      break
  }
  return (
    <section className={css.section} data-detail-document>
      {body}
    </section>
  )
}
