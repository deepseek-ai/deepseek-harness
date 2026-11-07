// @vitest-environment jsdom
/** Overlay clearance follows the desktop frame and visible anchor position. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { overlayTopMargin } from '../src/overlay-top-margin.ts'

const root = document.documentElement
let originalClearance: string
let originalPriority: string
let originalFullscreen: string | null

beforeEach(() => {
  originalClearance = root.style.getPropertyValue('--dsh-frame-top-clearance')
  originalPriority = root.style.getPropertyPriority('--dsh-frame-top-clearance')
  originalFullscreen = root.getAttribute('data-fullscreen')
  root.style.removeProperty('--dsh-frame-top-clearance')
  root.removeAttribute('data-fullscreen')
})

afterEach(() => {
  root.style.setProperty('--dsh-frame-top-clearance', originalClearance, originalPriority)
  if (originalFullscreen === null) root.removeAttribute('data-fullscreen')
  else root.setAttribute('data-fullscreen', originalFullscreen)
})

describe('overlayTopMargin', () => {
  it('uses the requested margin when the frame publishes no clearance', () => {
    expect(overlayTopMargin(12)).toBe(12)
  })

  it('uses the frame margin when no anchor is provided', () => {
    root.style.setProperty('--dsh-frame-top-clearance', '40px')
    expect(overlayTopMargin(12)).toBe(60)
  })

  it('caps clearance at a visible anchor and its requested gap', () => {
    root.style.setProperty('--dsh-frame-top-clearance', '40px')
    expect(overlayTopMargin(12, { top: 10, bottom: 24 }, 4)).toBe(28)
  })

  it('does not cap clearance at an anchor above the viewport', () => {
    root.style.setProperty('--dsh-frame-top-clearance', '40px')
    expect(overlayTopMargin(12, { top: -10, bottom: 24 }, 4)).toBe(60)
  })

  it('keeps the requested minimum when the anchor cap is smaller', () => {
    root.style.setProperty('--dsh-frame-top-clearance', '40px')
    expect(overlayTopMargin(12, { top: 0, bottom: 4 }, 4)).toBe(12)
  })

  it('keeps the requested minimum when it exceeds frame clearance', () => {
    root.style.setProperty('--dsh-frame-top-clearance', '40px')
    expect(overlayTopMargin(80)).toBe(80)
  })

  it('excludes native frame clearance in fullscreen', () => {
    root.style.setProperty('--dsh-frame-top-clearance', '40px')
    root.setAttribute('data-fullscreen', '')
    expect(overlayTopMargin(12)).toBe(20)
  })
})
