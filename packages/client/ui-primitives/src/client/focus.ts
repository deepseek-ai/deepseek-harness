/** Mobile-device detection and automatic focus presentation. */
const releases = new WeakMap<HTMLElement, () => void>()
const navigationKeys = new Set(['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'])
let mobileDevice: boolean | undefined

/**
 * Identify iOS and Android phones and tablets from the current browser's device information.
 * MacIntel with multiple touch points identifies desktop-mode iPads.
 * The first result is shared by all callers until the page reloads.
 * @returns true for recognized mobile devices; false for other devices, including unrecognized UAs.
 */
export function isMobileDevice(): boolean {
  if (mobileDevice !== undefined) return mobileDevice
  const { userAgent, platform, maxTouchPoints } = navigator
  mobileDevice = /Android|iPhone|iPad|iPod/i.test(userAgent)
    || (platform === 'MacIntel' && maxTouchPoints > 1)
  return mobileDevice
}

/**
 * Focus an automatic destination without a focus outline until keyboard navigation or blur.
 * The theme suppresses outlines while data-dsh-automatic-focus is present; borders and shadows remain intact.
 * Tab and directional navigation restore normal focus styling.
 * @param element - control or container receiving automatic focus.
 * @param options - browser focus options, including scroll preservation.
 */
export function focusWithoutRing(element: HTMLElement, options?: FocusOptions): void {
  releases.get(element)?.()
  const release = (): void => {
    element.removeAttribute('data-dsh-automatic-focus')
    element.removeEventListener('blur', release)
    element.removeEventListener('keydown', navigate, true)
    releases.delete(element)
  }
  const navigate = (event: KeyboardEvent): void => {
    if (!event.isComposing && !event.ctrlKey && !event.altKey && !event.metaKey && navigationKeys.has(event.key)) release()
  }
  releases.set(element, release)
  element.setAttribute('data-dsh-automatic-focus', '')
  element.addEventListener('blur', release)
  element.addEventListener('keydown', navigate, true)
  element.focus(options)
  if (!element.matches(':focus')) release()
}
