/** Complete image bytes rendered in a shared zoom viewport. */
import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import type { PropsLocale, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { pathPartsOf } from '@deepseek-ai/dsh-util-workspace-path'
import type { DocumentPreviewProps } from '../document/contract.ts'
import { LoadingIndicator } from '../LoadingIndicator.tsx'
import { hostFileOf } from '../rpc.ts'
import { ZoomViewport, zoomSurfaceClass } from '../zoom/ZoomViewport.tsx'
import { DEFAULT_ZOOM, type ZoomInjected, type ZoomStore } from '../zoom/store.ts'
import type { ZoomLabels, ZoomPreference } from '../zoom/types.ts'
import type {} from './locales.ts'
import css from './ImageBody.module.css'

const IMAGE_MEDIA_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
} as const

type ImageMediaType = typeof IMAGE_MEDIA_TYPES[keyof typeof IMAGE_MEDIA_TYPES]

/** Standard document props plus the image renderer's dictionary. */
export type ImageBodyProps = DocumentPreviewProps & PropsLocale<'sidebarImage'> & PropsStore<ZoomStore> & ZoomInjected

type ImageSource =
  | {
    readonly kind: 'ready'
    readonly data: Uint8Array<ArrayBuffer>
    readonly mediaType: ImageMediaType
    readonly url: string
  }
  | { readonly kind: 'failed'; readonly data: Uint8Array<ArrayBuffer>; readonly mediaType: ImageMediaType }

/**
 * Resolve a supported filename to the media type assigned to its Blob.
 * @param path - decoded workspace file path.
 * @returns the image media type, or undefined for an unregistered suffix.
 */
export function imageMediaType(path: string): ImageMediaType | undefined {
  const normalized = path.replaceAll('\\', '/')
  const name = normalized.slice(normalized.lastIndexOf('/') + 1).toLowerCase()
  const extension = name.slice(name.lastIndexOf('.') + 1) as keyof typeof IMAGE_MEDIA_TYPES
  return IMAGE_MEDIA_TYPES[extension]
}

/**
 * Present complete image bytes with fit-width and fixed-scale viewing.
 * @param props - document bytes, resource identity, and locale.
 * @returns a rounded image fitted or scaled at its intrinsic aspect ratio.
 */
export function ImageBody(props: ImageBodyProps): ReactNode {
  const { content, resourceAddress, t } = props
  const { tab } = props.useTabInfo()
  const preference = props.useStore(state => state.byTab[tab.id] ?? DEFAULT_ZOOM)
  const path = useMemo(() => hostFileOf(resourceAddress).path, [resourceAddress])
  const mediaType = imageMediaType(path)
  const data = content.kind === 'bytes' ? content.data : undefined
  const [source, setSource] = useState<ImageSource>()
  const setPreference = useCallback((value: ZoomPreference): void => {
    props.actions.zoom(tab.id, value)
  }, [props.actions, tab.id])

  useEffect(() => { props.retainTab(tab.id, tab.signal) }, [props.retainTab, tab.id, tab.signal])

  useEffect(() => {
    if (data === undefined || mediaType === undefined) return
    let url: string | undefined
    try {
      url = URL.createObjectURL(new Blob([data], { type: mediaType }))
      setSource({ kind: 'ready', data, mediaType, url })
    } catch {
      setSource({ kind: 'failed', data, mediaType })
    }
    return () => {
      if (url !== undefined) URL.revokeObjectURL(url)
    }
  }, [data, mediaType])

  if (data === undefined || mediaType === undefined) {
    return <p className={css.status} role="alert">{t('unsupported')}</p>
  }
  if (source?.data !== data || source.mediaType !== mediaType) {
    return <LoadingIndicator label={t('loading')} />
  }
  if (source.kind === 'failed') return <p className={css.status} role="alert">{t('failed')}</p>
  const { name } = pathPartsOf(path)
  const labels: ZoomLabels = {
    controls: t('zoomControls'), menu: t('zoomMenu'), out: t('zoomOut'), into: t('zoomIn'),
    fitWidth: t('zoomFitWidth'), value: percent => t('zoomValue', { percent }),
  }
  return <LoadedImage key={source.url} url={source.url} name={name} preference={preference}
    onPreference={setPreference} labels={labels} signal={tab.signal}
    scrollportRef={props.scrollportRef} t={t} />
}

/** SVG stays in the browser's static image mode because its bytes only reach an img Blob URL. */
function LoadedImage({ url, name, preference, onPreference, labels, signal, scrollportRef, t }: {
  readonly url: string
  readonly name: string
  readonly preference: ZoomPreference
  readonly onPreference: (preference: ZoomPreference) => void
  readonly labels: ZoomLabels
  readonly signal: AbortSignal
  readonly scrollportRef: ImageBodyProps['scrollportRef']
  readonly t: ImageBodyProps['t']
}): ReactNode {
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [width, setWidth] = useState<number>()
  return <ZoomViewport preference={preference} intrinsicWidth={width} horizontalInset={24}
    labels={labels} signal={signal} scrollportRef={scrollportRef} onPreference={onPreference}>
    <div className={css.frame} data-image-preview>
      {state === 'loading' && <LoadingIndicator label={t('loading')} />}
      {state === 'failed' && <p className={css.status} role="alert">{t('failed')}</p>}
      <div className={`${css.surface} ${zoomSurfaceClass}`} data-document-zoom-surface
        style={{ '--document-zoom-width': `${width ?? 0}px` } as CSSProperties} hidden={state !== 'ready'}>
        <img
          className={css.image}
          src={url}
          alt={t('preview', { name })}
          decoding="async"
          draggable={false}
          referrerPolicy="no-referrer"
          onLoad={(event) => { setWidth(event.currentTarget.naturalWidth); setState('ready') }}
          onError={() => { setState('failed') }}
        />
      </div>
    </div>
  </ZoomViewport>
}
