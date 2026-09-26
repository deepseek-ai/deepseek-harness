/** Load the PDF renderer only after a PDF body is mounted. */
import { lazy, Suspense, type ReactNode } from 'react'
import { LoadingIndicator } from '../LoadingIndicator.tsx'
import type { PdfBodyProps } from './pdf.tsx'

const LoadedPdfBody = lazy(async () => ({ default: (await import('./pdf.tsx')).PdfBody }))

/**
 * Suspend while the package-local PDF chunk arrives.
 * @param props - PDF body props supplied by the document slot.
 * @returns the deferred PDF renderer.
 */
export function LazyPdfBody(props: PdfBodyProps): ReactNode {
  const loading = <LoadingIndicator label={props.t('loading')} />
  return <Suspense fallback={loading}>
    <LoadedPdfBody {...props} loading={loading} />
  </Suspense>
}
