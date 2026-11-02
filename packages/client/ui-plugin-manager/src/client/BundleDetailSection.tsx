/** A bundle's long description on its page: the Markdown document the Host reads for it. */
import { useEffect, useMemo, type ReactNode } from 'react'
import { DetailDocument, detailDocumentState, useDetailDocumentLabels, type MarkdownPathImages } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { bundleDetailKey, type BundleDetailFailure, type BundleDetailsState } from './detail-store.ts'

type Translate = PropsLocale<'pluginManager'>['t']

const FAILURE_KEYS = {
  'too-large': 'detailTooLarge',
  'network': 'detailNetwork',
  'denied': 'detailFailed',
  'git-unavailable': 'detailFailed',
  'invalid': 'detailInvalid',
  'other': 'detailFailed',
} as const satisfies Record<BundleDetailFailure, string>

/** What the section reads and calls; the page passes them from its injected face. */
export interface BundleDetailSectionProps {
  readonly name: string
  readonly version: string | undefined
  /** Whether the bundle's files are unavailable, so the Host reads its offered version from the npm file CDNs. */
  readonly fromNpm: boolean
  readonly language: string
  readonly details: BundleDetailsState
  readonly t: Translate
  readonly load: (name: string, version: string | undefined, language: string, fromNpm: boolean) => void
  readonly retry: (name: string, version: string | undefined, language: string, fromNpm: boolean) => void
  readonly image: (name: string, document: string, destination: string, fromNpm: boolean) => string | undefined
}

/**
 * Read and render a bundle's detail document in the active language; relative images load from the Host beside it.
 * @param props - the bundle, the language, the reads, and the page's callbacks.
 * @returns the section, or null when the bundle has no document.
 */
export function BundleDetailSection(props: BundleDetailSectionProps): ReactNode {
  const { name, version, fromNpm, language, details, t, load, retry, image } = props
  const key = bundleDetailKey(name, version, language)
  const state = details[key]
  useEffect(() => { load(name, version, language, fromNpm) }, [key, details])
  const labels = useDetailDocumentLabels({
    title: t('detailTitle'), loading: t('detailLoading'), retry: t('retry'), copy: t('copy'), copied: t('copied'),
    codeBlock: t('codeBlock.title'), wrap: t('codeBlock.wrap'), unwrap: t('codeBlock.unwrap'), footnotes: t('detailFootnotes'),
  })
  const detail = state?.status === 'ready' ? state.detail : undefined
  const document = detail?.status === 'found' ? detail.path : undefined
  const images = useMemo<MarkdownPathImages | undefined>(
    () => document === undefined ? undefined : { resolve: value => image(name, document, value, fromNpm) },
    [name, document, fromNpm, image],
  )
  const shown = detailDocumentState(state?.status === 'error'
    ? { status: 'error', message: t(FAILURE_KEYS[state.failure]) }
    : state === undefined || state.status === 'loading' ? state : { status: 'ready', markdown: detail?.status === 'found' ? detail.markdown : undefined })
  return <DetailDocument state={shown} labels={labels} images={images} onRetry={() => { retry(name, version, language, fromNpm) }} />
}
