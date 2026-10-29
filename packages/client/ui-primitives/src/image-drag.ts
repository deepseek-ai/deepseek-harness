/** Image gestures delegate file preparation and transport to the owning feature. */
import { useCallback, useEffect, useMemo, useRef, type DragEvent, type MouseEvent, type PointerEvent, type ImgHTMLAttributes } from 'react'
import type { FileDragActions, FileDragSource, PreparedFileDrag } from './file-drag-actions.ts'

interface Preparation { abort: AbortController; prepared?: PreparedFileDrag; failed: boolean }
type ImageGestures = Required<Pick<ImgHTMLAttributes<HTMLImageElement>,
  'onPointerEnter' | 'onPointerDown' | 'onPointerLeave' | 'onDragStart' | 'onDragEnd' | 'onClickCapture'>>

/**
 * Prepare resource-backed images on primary press, other images also on hover; release on leave.
 * Releasing inside the image retains preparation for the next gesture; cancelled drags never start late.
 * @param actions - stable file preparation and error callbacks.
 * @param src - displayed image URL.
 * @param name - proposed export name.
 * @param original - already loaded original bytes.
 * @param resourceAddress - verifiable reference to an unmodified local original.
 * @returns image gesture handlers; overflowing images remain owned by their pan handler.
 */
export function useImageDrag(
  actions: FileDragActions, src: string, name: string, original?: File, resourceAddress?: string,
): ImageGestures {
  const source = useMemo<FileDragSource>(() => original === undefined
    ? { kind: 'url', url: src, name, mediaType: '', resourceAddress }
    : { kind: 'blob', blob: original, name, mediaType: original.type, resourceAddress }, [src, name, original, resourceAddress])
  const state = useRef<Preparation>()
  const dragged = useRef(false)
  const release = useCallback((): void => {
    const previous = state.current
    state.current = undefined
    previous?.abort.abort()
    previous?.prepared?.release()
  }, [])
  useEffect(() => release, [release, source, actions])
  const prepare = useCallback((image: HTMLImageElement): void => {
    if (src === '' || state.current !== undefined) return
    const current: Preparation = { abort: new AbortController(), failed: false }
    state.current = current
    window.addEventListener('pointerup', (event) => {
      if (event.target !== image) release()
    }, { signal: current.abort.signal })
    window.addEventListener('blur', release, { once: true, signal: current.abort.signal })
    void actions.prepare(source, current.abort.signal).then((prepared) => {
      if (current.abort.signal.aborted) prepared.release()
      else current.prepared = prepared
    }, (_error: unknown) => {
      // Speculation stays quiet; only a later failed gesture presents retry feedback.
      current.failed = true
    })
  }, [src, actions, source, release])
  const intent = useCallback((event: PointerEvent<HTMLImageElement>): void => {
    if (!event.defaultPrevented && event.currentTarget.draggable
      && (resourceAddress === undefined || event.type === 'pointerdown')) prepare(event.currentTarget)
  }, [prepare, resourceAddress])
  const onDragStart = useCallback((event: DragEvent<HTMLImageElement>): void => {
    if (event.defaultPrevented || src === '') return
    dragged.current = true
    const current = state.current
    if (current?.prepared !== undefined) {
      if (!current.prepared.start(event.dataTransfer, event.currentTarget)) { event.preventDefault(); release() }
      return
    }
    const url = new URL(src, location.href)
    if (original === undefined && (url.protocol === 'https:' || url.protocol === 'http:') && url.origin !== location.origin) return
    event.preventDefault()
    if (current?.failed === true) { actions.reportFailure(); release() }
    prepare(event.currentTarget)
  }, [src, original, actions, prepare, release])
  const onPointerDown = useCallback((event: PointerEvent<HTMLImageElement>): void => {
    dragged.current = false
    if (event.button === 0) intent(event)
  }, [intent])
  const onPointerLeave = useCallback((event: PointerEvent<HTMLImageElement>): void => {
    // Browsers may leave a small image before dispatching its dragstart.
    if (event.buttons !== 1) release()
  }, [release])
  const onClickCapture = useCallback((event: MouseEvent): void => {
    if (event.detail === 0) { dragged.current = false; return }
    if (!dragged.current) return
    event.preventDefault()
    event.stopPropagation()
    dragged.current = false
  }, [])
  return { onPointerEnter: intent, onPointerDown, onPointerLeave, onDragStart, onDragEnd: release, onClickCapture }
}
