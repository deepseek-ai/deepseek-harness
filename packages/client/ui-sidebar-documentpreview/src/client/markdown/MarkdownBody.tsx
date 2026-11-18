/** One retained Markdown renderer over the document owner's accumulated text. */
import { lazy, Suspense, useMemo } from 'react'
import type { ReactNode } from 'react'
import { MarkdownText, type MarkdownLabels, type MarkdownPathImages } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { DocumentPreviewProps } from '../document/contract.ts'
import { splitFrontmatter } from './frontmatter.ts'
import type { FrontmatterFieldsProps } from './frontmatter-fields.tsx'
import { markdownImageUrl } from './path-images.ts'
import type {} from './locales.ts'
import css from './MarkdownBody.module.css'

/** Show the verbatim frontmatter when the field-list chunk cannot load. */
function FrontmatterFallback({ fallback }: FrontmatterFieldsProps): ReactNode {
  return fallback
}

const FrontmatterFields = lazy(() => import('./frontmatter-fields.tsx').then(
  module => ({ default: module.FrontmatterFields }),
  // The failed chunk only removes the field layout; the body and verbatim metadata stay usable.
  () => ({ default: FrontmatterFallback }),
))

/** Standard document inputs and this implementation's locale. */
export type MarkdownBodyProps = DocumentPreviewProps & PropsLocale<'documentMarkdown'>

/**
 * Render one accumulated document; EOF completes the primitive's full parse.
 * A leading YAML frontmatter block renders as a field list instead of Markdown; its
 * verbatim source stands in while the field-list chunk loads or when it fails.
 * Relative image destinations resolve beside the file at `baseAddress`; without
 * one they stay unresolved, while absolute paths and URLs render as usual.
 * @param props - owner-loaded contents, the optional base address, and localized primitive labels.
 * @returns Markdown content, or nothing for a non-text delivery.
 */
export function MarkdownBody({ content, baseAddress, useResource, t }: MarkdownBodyProps): ReactNode {
  if (content.kind !== 'text') return null
  return baseAddress === undefined
    ? <MarkdownDocument text={content.text} eof={content.eof} documentPath={undefined} t={t} />
    : <BasedMarkdownDocument text={content.text} eof={content.eof} baseAddress={baseAddress} useResource={useResource} t={t} />
}

/** One text delivery with the source path its relative images resolve beside. */
interface MarkdownDocumentProps {
  readonly text: string
  readonly eof: boolean
  /** Absolute source path; `undefined` leaves relative image destinations unresolved. */
  readonly documentPath: string | undefined
  readonly t: MarkdownBodyProps['t']
}

/**
 * Read the base file's absolute path, then render the document beside it.
 * @param props - the text delivery, the base file address, the resource hook, and copy.
 * @returns the Markdown document.
 */
function BasedMarkdownDocument({ baseAddress, useResource, ...delivery }: Omit<MarkdownDocumentProps, 'documentPath'>
  & { readonly baseAddress: string; readonly useResource: MarkdownBodyProps['useResource'] }): ReactNode {
  const documentPath = useResource<'file'>(baseAddress).value?.absolutePath
  return <MarkdownDocument {...delivery} documentPath={documentPath} />
}

/**
 * Render one text delivery with its optional frontmatter box.
 * @param props - the text, its completion, the image base path, and copy.
 * @returns the Markdown document.
 */
function MarkdownDocument({ text, eof, documentPath, t }: MarkdownDocumentProps): ReactNode {
  const pathImages = useMemo<MarkdownPathImages>(() => ({
    resolve: value => markdownImageUrl(document.baseURI, documentPath, value),
  }), [documentPath])
  const copyLabel = t('code.copy')
  const copiedLabel = t('code.copied')
  const footnotes = t('footnotes')
  const codeLabel = t('codeBlock.title')
  const wrapLabel = t('codeBlock.wrap')
  const unwrapLabel = t('codeBlock.unwrap')
  const labels = useMemo<MarkdownLabels>(() => ({
    code: { copyLabel, copiedLabel, toolbarLabels: { codeLabel, wrapLabel, unwrapLabel } }, footnotes,
  }), [copyLabel, copiedLabel, footnotes, codeLabel, wrapLabel, unwrapLabel])
  const split = useMemo(() => splitFrontmatter(text), [text])
  return (
    <div className={css.document} data-document-markdown>
      {split === undefined ? null : <FrontmatterBox source={split.source} />}
      <MarkdownText text={split?.body ?? text} streaming={!eof} labels={labels} pathImages={pathImages} />
    </div>
  )
}

/**
 * Frame one frontmatter block and choose its field list or verbatim source.
 * @param props - YAML between the frontmatter delimiters.
 * @returns the metadata box; it collapses when the document has no content.
 */
function FrontmatterBox({ source }: { source: string }): ReactNode {
  const verbatim = <pre className={css.frontmatterSource}>{source}</pre>
  return (
    <div className={css.frontmatter} data-document-frontmatter>
      <Suspense fallback={verbatim}><FrontmatterFields source={source} fallback={verbatim} /></Suspense>
    </div>
  )
}
