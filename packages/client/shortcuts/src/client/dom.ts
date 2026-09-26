/** Main-document keyboard adapter; local controls arbitrate before window bubbling. */
import { modalSelector, observeComposition } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ShortcutContext, ShortcutFixedInput } from './types.ts'
import type { ShortcutRegistry } from './registry.ts'
import type { ShortcutPlatform, ShortcutRuntime } from '../protocol.ts'

/**
 * Detect the visiting device, never the server operating system.
 * @param document - product document, marked by Electron preload when present.
 * @param navigator - browser device identification.
 * @returns explicit runtime and platform for default resolution.
 */
export function detectEnvironment(document: Document, navigator: Navigator): {
  runtime: ShortcutRuntime
  platform: ShortcutPlatform
} {
  const desktop = document.documentElement.dataset.platform
  const device = desktop ?? navigator.platform
  return { runtime: desktop === undefined ? 'web' : 'desktop',
    platform: /darwin|mac|iphone|ipad/iu.test(device) ? 'macos' : /win/iu.test(device) ? 'windows' : 'linux' }
}

/**
 * Install document composition tracking and application dispatch after local handlers.
 * @param window - input window owned by the client plugin.
 * @param shortcuts - command registry for this window.
 * @param fixed - optional fixed-sequence consumer after local controls.
 * @param native - native input owns configurable bindings; DOM delivery only feeds fixed actions.
 * @returns disposer releasing every listener.
 */
export function installKeyboard(window: Window, shortcuts: Pick<ShortcutRegistry, 'dispatch' | 'runtime' | 'platform'>,
  fixed?: (input: ShortcutFixedInput) => void, native = false): () => void {
  const document = window.document
  const composition = observeComposition(document)
  let pending = false
  let pendingTimer: number | undefined
  const reset = (): void => { fixed?.({ type: 'reset' }) }
  let deadKey = false
  const blur = (): void => { deadKey = false; reset() }
  const containsModal = (node: Node): boolean => node instanceof Element
    && (node.matches(modalSelector) || node.querySelector(modalSelector) !== null)
  const changedModals = (records: MutationRecord[]): void => {
    if (records.some(record => record.type === 'attributes'
      ? record.oldValue === 'dialog' || record.oldValue === 'true' || containsModal(record.target)
      : [...record.addedNodes, ...record.removedNodes].some(containsModal))) reset()
  }
  const observer = fixed === undefined ? undefined : new MutationObserver(changedModals)
  observer?.observe(document.documentElement, { childList: true, subtree: true,
    attributes: true, attributeFilter: ['role', 'aria-modal'], attributeOldValue: true })
  const capture = (): void => {
    if (pending) reset()
    window.clearTimeout(pendingTimer)
    if (observer !== undefined) changedModals(observer.takeRecords())
    pending = true
    // Native event listeners can yield a microtask checkpoint before bubbling.
    pendingTimer = window.setTimeout(() => {
      pending = false
      pendingTimer = undefined
      reset()
    }, 0)
  }
  const keydown = (event: KeyboardEvent): void => {
    window.clearTimeout(pendingTimer)
    pendingTimer = undefined
    pending = false
    const target = event.composedPath().find(value => value instanceof Element)
    const element = target instanceof Element ? target : document.activeElement
    const region = element?.closest('.xterm') ? 'terminal'
      : element?.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]') ? 'editable' : 'page'
    const dialogs = document.querySelectorAll<HTMLElement>(modalSelector)
    const top = [...dialogs].at(-1)
    const context: ShortcutContext = { region, modal: top === undefined ? null : top.dataset.shortcutModal ?? 'other', target: element }
    const guarded = composition.guards(event) || deadKey
      || event.getModifierState('AltGraph')
    const isDead = event.key === 'Dead'
    // macOS can report Option+Command+N as Dead outside input-method composition.
    const commandDeadKey = isDead && shortcuts.runtime === 'web' && shortcuts.platform === 'macos'
      && event.code === 'KeyN' && event.metaKey && event.altKey && !event.ctrlKey && !event.shiftKey
    deadKey = isDead
    const gesture = { code: event.code, control: event.ctrlKey, alt: event.altKey, shift: event.shiftKey,
      meta: event.metaKey, repeat: event.repeat, composing: guarded || isDead, defaultPrevented: event.defaultPrevented }
    const consume = (): void => {
      event.preventDefault()
      if (commandDeadKey) deadKey = false
    }
    fixed?.({ type: 'keydown', gesture, context, consume })
    if (native) return
    shortcuts.dispatch({ ...gesture, composing: guarded || (isDead && !commandDeadKey),
      defaultPrevented: event.defaultPrevented }, context, consume)
  }
  document.addEventListener('compositionstart', reset, true)
  document.addEventListener('compositionend', reset, true)
  document.addEventListener('focusin', reset, true)
  document.addEventListener('pointerdown', reset, true)
  window.addEventListener('keydown', capture, true)
  window.addEventListener('keydown', keydown)
  window.addEventListener('blur', blur)
  return () => {
    pending = false
    window.clearTimeout(pendingTimer)
    observer?.disconnect()
    composition.dispose()
    document.removeEventListener('compositionstart', reset, true)
    document.removeEventListener('compositionend', reset, true)
    document.removeEventListener('focusin', reset, true)
    document.removeEventListener('pointerdown', reset, true)
    window.removeEventListener('keydown', capture, true)
    window.removeEventListener('keydown', keydown)
    window.removeEventListener('blur', blur)
  }
}
