/** Body-portaled introduction with shared background interaction ownership. */
import { acquireOverlayInert } from './overlay-inert.ts'
import { useLayoutEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import css from './OnboardingSurface.module.css'

/**
 * Render a body-portaled onboarding stage and keep the application root inert
 * while mounted. Completion reveals the root beneath a fading stage;
 * native titlebar controls, dialogs, and account pages remain above the stage.
 * @param props.children - the step's page content, centered on the stage.
 * @param props.exiting - reveal the application while the owner retains the stage for its 180ms exit.
 * @returns the body-portaled overlay tree.
 */
export function OnboardingSurface({ children, exiting = false }: { children: ReactNode; exiting?: boolean }) {
  const rootState = useRef<{ element: HTMLElement; opacity: string } | null>(null)
  useLayoutEffect(() => {
    const appRoot = document.getElementById('root')
    if (appRoot === null) return
    const releaseInert = acquireOverlayInert(appRoot)
    const previousOpacity = appRoot.style.opacity
    rootState.current = { element: appRoot, opacity: previousOpacity }
    appRoot.style.opacity = '0'
    return () => {
      releaseInert()
      appRoot.style.opacity = previousOpacity
      rootState.current = null
    }
  }, [])
  useLayoutEffect(() => {
    const root = rootState.current
    if (root !== null) root.element.style.opacity = exiting ? root.opacity : '0'
  }, [exiting])

  return createPortal((
    <div className={css.onboardingOverlay} data-exiting={exiting || undefined} role="presentation">
      <div className={css.dragBand} data-window-drag aria-hidden="true" />
      <div className={css.onboardingStage}>{children}</div>
    </div>
  ), document.body)
}
