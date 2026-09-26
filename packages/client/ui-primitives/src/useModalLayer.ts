/** Shared modal keyboard ownership and focus lifetime. */
import { useLayoutEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { observeComposition } from './keyboard-composition.ts'
import { focusWithoutRing } from './focus.ts'

/** Dialog and menu elements whose document order determines foreground shortcut ownership. */
export const modalSelector = '[role="dialog"][aria-modal="true"], [role="menu"]'

const layers = new WeakMap<Document, { element: HTMLElement; close: () => void }[]>()

/**
 * Request closure of the foreground registered modal using its current onClose callback.
 * A newer menu or unregistered dialog blocks dismissal of the modal behind it.
 * @param document - product document whose modal owns the close command.
 */
export function closeTopModal(document: Document): void {
  const top = layers.get(document)?.at(-1)
  if (top === undefined) return
  const foreground = [...document.querySelectorAll(modalSelector)].at(-1)
  if (foreground === top.element) top.close()
}
/**
 * Whether an anchor belongs behind the current modal and must yield keyboard input.
 * @param anchor - local control owning the input handler.
 * @returns true when another modal owns the foreground.
 */
export function isBehindModal(anchor: HTMLElement | null): boolean {
  if (anchor === null) return false
  const top = layers.get(anchor.ownerDocument)?.at(-1)
  return top !== undefined && !top.element.contains(anchor)
}

const focusable = 'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]'

/**
 * Give only the top modal Escape and Tab ownership, then restore its previous focus.
 * Automatic entry and return focus omit outlines; keyboard traversal retains its indicators.
 * Controls mounted with the dialog use data-modal-autofocus for initial focus;
 * React autoFocus runs before this layer can capture the invoking control.
 * Local menus handle their Escape during capture before this bubble listener.
 * @param dialog - mounted dialog element.
 * @param open - whether this layer is active.
 * @param onClose - top-layer Escape or application close action.
 */
export function useModalLayer(dialog: RefObject<HTMLElement | null>, open: boolean, onClose: () => void): void {
  const close = useRef(onClose)
  close.current = onClose
  useLayoutEffect(() => {
    const element = dialog.current
    if (!open || element === null) return
    const document = element.ownerDocument
    const composition = observeComposition(document)
    const previous = document.activeElement
    const stack = layers.get(document) ?? []
    layers.set(document, stack)
    const layer = { element, close: () => { close.current() } }
    stack.push(layer)
    const initial = element.querySelector<HTMLElement>('[data-modal-autofocus]')
      ?? element.querySelector<HTMLElement>(focusable) ?? element
    if (!element.contains(document.activeElement)) focusWithoutRing(initial)
    const keydown = (event: KeyboardEvent): void => {
      const composing = composition.guards(event)
      if (stack.at(-1) !== layer || event.defaultPrevented || composing
        || event.ctrlKey || event.altKey || event.metaKey) return
      if (event.key === 'Escape' && !event.shiftKey) {
        event.preventDefault()
        if (!event.repeat) close.current()
      }
      if (event.key !== 'Tab') return
      // Portaled menus own their traversal while they contain focus.
      if (document.activeElement?.closest('[role="menu"]')) return
      const items = [...element.querySelectorAll<HTMLElement>(focusable)]
        .filter(item => !item.closest('[inert], [hidden]'))
      const first = items[0] ?? element
      const last = items.at(-1) ?? element
      const atEdge = event.shiftKey ? document.activeElement === first : document.activeElement === last
      if (document.activeElement === element || !element.contains(document.activeElement) || atEdge) {
        event.preventDefault()
        const target = event.shiftKey ? last : first
        target.focus()
      }
    }
    document.addEventListener('keydown', keydown)
    return () => {
      composition.dispose()
      const wasTop = stack.at(-1) === layer
      stack.splice(stack.indexOf(layer), 1)
      document.removeEventListener('keydown', keydown)
      if (stack.length === 0) layers.delete(document)
      if (wasTop) {
        const target = previous instanceof HTMLElement && previous.isConnected ? previous : stack.at(-1)?.element
        if (target !== undefined) focusWithoutRing(target)
      }
    }
  }, [dialog, open])
}
