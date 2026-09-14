/** Complete HTML rendered in a script-enabled opaque iframe, without parent application access. */
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { DocumentPreviewProps } from '../document/contract.ts'
import { LoadingIndicator } from '../LoadingIndicator.tsx'
import { createHtmlDocument } from './bootstrap.ts'
import { packHtml } from './pack.ts'
import type { ReadHtmlRelative } from './pack.ts'
import { createReadHtmlRelative } from './read-relative.ts'
import type { ReadHtmlRelated } from './read-relative.ts'
import type {} from './locales.ts'
import css from './HtmlBody.module.css'

/** Standard document inputs plus this renderer's dictionary. */
export type HtmlBodyProps = DocumentPreviewProps & PropsLocale<'documentHtml'> & {
  /** Ordinary Remote callback bound by this renderer's Slot inject. */
  readonly readRelated: ReadHtmlRelated
}

type FrameInput = {
  readonly data: Uint8Array<ArrayBuffer>
  readonly readRelative: ReadHtmlRelative
}

type FrameState = FrameInput & { readonly url: string | undefined }

/** One mounted file owns its root Blob; replacing content also replaces the browsing context. */
function HtmlFrame({ data, readRelative, t }: FrameInput & { t: HtmlBodyProps['t'] }): ReactNode {
  const [frame, setFrame] = useState<FrameState>()
  useEffect(() => {
    const controller = new AbortController()
    let url: string | undefined
    void (async () => {
      try {
        const bundle = await packHtml(data, readRelative, controller.signal)
        controller.signal.throwIfAborted()
        const html = createHtmlDocument(bundle)
        url = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
        setFrame({ data, readRelative, url })
      } catch {
        if (!controller.signal.aborted) setFrame({ data, readRelative, url: undefined })
      }
    })()
    return () => {
      controller.abort()
      if (url !== undefined) URL.revokeObjectURL(url)
    }
  }, [data, readRelative])

  if (frame?.data !== data || frame.readRelative !== readRelative) {
    return <LoadingIndicator className={clsx(css.status, css.opening)} label={t('loading')} />
  }
  if (frame.url === undefined) return <p className={css.status} role="alert">{t('failed')}</p>
  return <iframe key={frame.url} className={css.frame} src={frame.url} sandbox="allow-scripts" title={t('frame')} data-html-preview />
}

/**
 * Render complete HTML with the standard file and tab hooks.
 * @param props - document bytes, hooks, related-file reader and locale.
 * @returns an isolated HTML document, or nothing for text delivery.
 */
export function HtmlBody({ content, resourceAddress, readRelated, useTabInfo, t }: HtmlBodyProps): ReactNode {
  const { tab } = useTabInfo()
  const readRelative = useMemo(
    () => createReadHtmlRelative(readRelated, resourceAddress, tab.signal),
    [readRelated, resourceAddress, tab.signal],
  )
  if (content.kind !== 'bytes') return null
  return <HtmlFrame key={resourceAddress} data={content.data} readRelative={readRelative} t={t} />
}
