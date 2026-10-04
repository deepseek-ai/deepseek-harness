/** Same-origin Inspector key delivery through the parent window's command adapter. */
import type { ShortcutCatalogEntry } from '@deepseek-ai/dsh-client-shortcuts/client'

/**
 * Forward the Inspector's current binding without replacing parent command arbitration.
 * @param frame - Owned DevTools iframe.
 * @param readBinding - Current effective Inspector binding, including user overrides.
 * @returns Release load and document listeners.
 */
export function bindInspectorKeyboard(frame: HTMLIFrameElement,
  readBinding: () => ShortcutCatalogEntry['binding'] | undefined): () => void {
  let release: (() => void) | undefined
  const attach = (): void => {
    release?.()
    release = undefined
    const document = frame.contentDocument
    if (document === null) return
    const keydown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing || event.getModifierState('AltGraph')) return
      const binding = readBinding()
      if (binding == null || binding.secondCode !== undefined || binding.code !== event.code) return
      const flags = [event.ctrlKey, event.altKey, event.shiftKey, event.metaKey]
      if (!(['control', 'alt', 'shift', 'meta'] as const).every((modifier, index) => binding.modifiers.includes(modifier) === flags[index])) return
      const forwarded = new KeyboardEvent('keydown', {
        key: event.key, code: event.code, ctrlKey: event.ctrlKey, altKey: event.altKey,
        shiftKey: event.shiftKey, metaKey: event.metaKey, repeat: event.repeat,
        bubbles: true, cancelable: true, composed: true,
      })
      if (!frame.dispatchEvent(forwarded)) event.preventDefault()
    }
    document.addEventListener('keydown', keydown)
    release = () => { document.removeEventListener('keydown', keydown) }
  }
  frame.addEventListener('load', attach)
  attach()
  return () => { frame.removeEventListener('load', attach); release?.() }
}
