/** Desktop Platform viewport; the native child owns remote content and credentials. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button, IconChevronLeftOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PlatformPage } from './platform-pages.ts'
import css from './PlatformOverlay.module.css'
import { acquireOverlayInert } from './overlay-inert.ts'

/** Non-secret commands supplied by the desktop application preload. */
export interface PlatformBridge {
  /** @param page - supported Platform destination. @param bounds - viewport rectangle. @returns after document load. */
  open(this: void, page: PlatformPage, bounds: { x: number; y: number; width: number; height: number }): Promise<void>
  /** @param bounds - viewport rectangle. @returns after native bounds update. */
  setBounds(this: void, bounds: { x: number; y: number; width: number; height: number }): Promise<void>
  /** @returns after the native document is destroyed. */
  close(this: void): Promise<void>
}

/** @param props - native commands, localized copy, and return action. @returns full-window Platform container. */
export function PlatformOverlay({ bridge, page, backLabel, loadingLabel, failureLabel, retryLabel, onClose }: {
  bridge: PlatformBridge
  page: PlatformPage
  backLabel: string
  loadingLabel: string
  failureLabel: string
  retryLabel: string
  onClose: () => void
}) {
  const layer = useRef<HTMLDivElement>(null)
  const back = useRef<HTMLButtonElement>(null)
  const viewport = useRef<HTMLDivElement>(null)
  const [attempt, setAttempt] = useState(0)
  const [status, setStatus] = useState<'loading' | 'loaded' | 'failed'>('loading')
  // Restore inertness and focus in the layout cleanup, so a Modal mounted by the
  // same commit records the restored focus before it takes its own.
  useLayoutEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const background = Array.from(document.body.children).filter((element): element is HTMLElement =>
      element instanceof HTMLElement && element !== layer.current).map(element => acquireOverlayInert(element))
    back.current?.focus()
    return () => {
      for (const release of background) release()
      if (previousFocus?.isConnected) previousFocus.focus()
    }
  }, [])
  // A retry or a destination change replaces the surface holding focus with the
  // loading state, so the return action takes it back on each attempt.
  useLayoutEffect(() => { back.current?.focus() }, [page, attempt])
  useEffect(() => {
    const element = viewport.current as HTMLDivElement
    let closed = false
    const bounds = () => {
      const rect = element.getBoundingClientRect()
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    }
    const fail = () => { if (!closed) setStatus('failed') }
    setStatus('loading')
    void bridge.open(page, bounds()).then(() => { if (!closed) setStatus('loaded') }, fail)
    const observer = new ResizeObserver(() => { void bridge.setBounds(bounds()).catch(fail) })
    observer.observe(element)
    return () => {
      closed = true
      observer.disconnect()
      void bridge.close().catch(() => {
        // Window teardown may remove the desktop IPC receiver before React unmounts.
      })
    }
  }, [bridge, page, attempt])
  return createPortal(<div ref={layer} className={css.overlay} role="dialog" aria-modal="true" aria-label={backLabel}>
    <header className={css.header} data-window-drag>
      <div className={css.controls}>
        <span className={css.trafficLights} aria-hidden="true" />
        <button ref={back} className={css.back} onClick={onClose}>
          <IconChevronLeftOutlineRegular size={16} />{backLabel}
        </button>
      </div>
    </header>
    <div ref={viewport} className={css.viewport}>
      {status !== 'loaded' && <div className={css.status} role="status" aria-label={status === 'loading' ? loadingLabel : undefined}>
        {status === 'failed' ? <>
          <span className={css.failure}>{failureLabel}</span>
          <Button variant="outline" className={css.retry} onClick={() => { setAttempt(value => value + 1) }}>{retryLabel}</Button>
        </> : <span className={css.spinner} aria-hidden="true" />}
      </div>}
    </div>
  </div>, document.body)
}
