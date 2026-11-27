/** Video presentation. Every write retains the borrowed frame until completion; teardown stops owned media tracks. */
import type { FrameContentWindow, FrameForwardingFrame } from './api.ts'
import type { ContentState } from './content.ts'
import { contentFrame } from './content.ts'
import { FrameFailureError } from './errors.ts'

/** One mounted media backend's resources. */
export interface MediaPresenter {
  readonly submittedWindow: FrameContentWindow | undefined
  present(frame: FrameForwardingFrame): void | Promise<void>
  resume(): void
  setContent(content: ContentState | undefined): void
  dispose(): void
}

interface VideoTrackGenerator extends MediaStreamTrack { readonly writable: WritableStream<VideoFrame> }

/** Create a Chromium video display inside the placeholder.
 * @param element - Container; its positioned descendants remain above the media.
 * @param failure - Receives media playback failure while this backend is active.
 * @param submitted - Reports the generation accepted by the video track.
 * @returns Owned media display, released on backend switch or unmount.
 */
export function createMediaPresenter(
  element: HTMLElement, failure: (error: Error) => void,
  submitted: (generation: number) => void,
): MediaPresenter {
  const video = element.ownerDocument.createElement('video')
  Object.assign(video.style, { position: 'absolute', left: '0', top: '0', width: '100%', height: '100%', objectFit: 'fill', pointerEvents: 'none' })
  video.setAttribute('aria-hidden', 'true')
  const container = element.ownerDocument.createElement('div')
  Object.assign(container.style, { position: 'absolute', inset: '0', overflow: 'hidden', borderRadius: 'inherit', pointerEvents: 'none', zIndex: '-1' })
  container.setAttribute('aria-hidden', 'true')
  const Generator = (globalThis as { MediaStreamTrackGenerator?: new (options: { kind: 'video' }) => VideoTrackGenerator }).MediaStreamTrackGenerator
  if (Generator === undefined) throw new FrameFailureError('presentation', 'Video presentation requires MediaStreamTrackGenerator.')
  const track = new Generator({ kind: 'video' })
  const writer = track.writable.getWriter()
  let disposed = false
  video.autoplay = true
  video.muted = true
  video.playsInline = true
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    track.stop()
    video.pause()
    video.srcObject = null
    container.remove()
    void writer.abort().catch((error: unknown) => { console.error('Frame video writer teardown failed', error) })
  }
  const resume = (): void => {
    if (!video.paused || !video.isConnected) return
    void video.play().catch((error: unknown) => {
      // Removing a tab's DOM can interrupt play before the first frame arrives.
      if (!disposed && !(error instanceof DOMException && error.name === 'AbortError'))
        failure(new FrameFailureError('presentation', error instanceof Error ? error.message : String(error)))
    })
  }
  try {
    video.srcObject = new MediaStream([track])
    container.append(video); element.prepend(container)
    resume()
  } catch (error) { dispose(); throw error }
  let content: ContentState | undefined
  let submittedWindow: FrameContentWindow | undefined
  const place = (): void => {
    const window = submittedWindow ?? content?.windows.at(-1)
    const frame = window === undefined || content === undefined ? undefined : contentFrame(window, content.view)
    video.style.width = frame === undefined ? '100%' : `${frame.width}px`
    video.style.height = frame === undefined ? '100%' : `${frame.height}px`
    video.style.transform = frame === undefined ? '' : `translate(${frame.x}px, ${frame.y}px)`
    // Chromium can still display the preceding image after a track write completes.
    video.style.objectFit = frame === undefined ? 'fill' : 'contain'
    video.style.objectPosition = 'top left'
  }
  return {
    get submittedWindow() { return submittedWindow },
    resume,
    setContent(next) {
      content = next
      if (next === undefined) submittedWindow = undefined
      place()
    },
    async present({ image, metadata }) {
      const window = content?.windows.find(candidate => candidate.generation === metadata.generation)
      // The generator consumes its input. A clone leaves the lease's original close with FrameRx.
      const copy = image.clone()
      try {
        await writer.write(copy)
        if (!disposed) {
          submittedWindow = content === undefined ? undefined : window
          place()
          submitted(metadata.generation)
        }
      } catch (error) {
        // Disposal cancels outstanding writes.
        if (!disposed) throw error
      } finally { copy.close() }
    },
    dispose,
  }
}
