/** A market entry's long description: the Markdown document the Host reads for one listed version. */
import { useEffect, useMemo, type ReactNode } from 'react'
import { DetailDocument, detailDocumentState, useDetailDocumentLabels, type MarkdownPathImages } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { detailKey, type DetailFace, type DetailFailureKind, type DetailRequest } from './market-store.ts'

const FAILURE_KEYS = {
  'too-large': 'detailTooLarge',
  'network': 'detailNetwork',
  'denied': 'detailDenied',
  'git-unavailable': 'detailGitUnavailable',
  'invalid': 'detailInvalid',
  'other': 'detailFailed',
} as const satisfies Record<DetailFailureKind, string>

/** Props of the detail section: the entry version, the dictionary, and the injected detail reads. */
export type PluginDetailSectionProps = { readonly request: DetailRequest } & PropsLocale<'pluginMarket'> & InjectFace<DetailFace>

/**
 * Read and render an entry version's detail document in the active language. Relative images load from the Host beside
 * the document.
 * @param props - the entry version, the dictionary, and the injected detail reads.
 * @returns the section, or null when the version has no document.
 */
export function PluginDetailSection(props: PluginDetailSectionProps): ReactNode {
  const { request, t, loadDetail, retryDetail, detailImage } = props
  const language = props.useLocale(snapshot => snapshot.active)
  const key = detailKey(request, language)
  const state = props.useDetails(details => details[key])
  // The key names the request completely; a read the controller forgot, after a connection reset, starts again.
  const missing = state === undefined
  useEffect(() => { if (missing) loadDetail(request, language) }, [key, missing])
  const labels = useDetailDocumentLabels({
    title: t('detailTitle'), loading: t('detailLoading'), retry: t('retry'), copy: t('copy'), copied: t('copied'),
    codeBlock: t('codeBlock.title'), wrap: t('codeBlock.wrap'), unwrap: t('codeBlock.unwrap'), footnotes: t('footnotes'),
  })
  const detail = state?.status === 'ready' ? state.detail : undefined
  const document = detail?.status === 'found' ? detail.document : undefined
  const images = useMemo<MarkdownPathImages | undefined>(
    () => document === undefined ? undefined : { resolve: value => detailImage(document, value) },
    [document, detailImage],
  )
  const shown = detailDocumentState(state?.status === 'error'
    ? { status: 'error', message: t(FAILURE_KEYS[state.failure]) }
    : state === undefined || state.status === 'loading' ? state : { status: 'ready', markdown: detail?.status === 'found' ? detail.markdown : undefined })
  return <DetailDocument state={shown} labels={labels} images={images} onRetry={() => { retryDetail(request, language) }} />
}
