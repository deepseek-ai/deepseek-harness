/** Document-level listeners and a portal that retains its source's package style scope. */
import { useLayoutEffect, useState, type FC, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/** Each keyboard handler receives the native event even when focus is outside the portal. */
export interface DocumentPortalProps {
  readonly children?: ReactNode
  readonly onKeyDown?: (event: KeyboardEvent) => void
  readonly onKeyDownCapture?: (event: KeyboardEvent) => void
}

function useKeyDown(doc: Document, handler: DocumentPortalProps['onKeyDown'], capture: boolean): void {
  useLayoutEffect(() => {
    if (!handler) return
    // Each mounted portal owns its listener, even if two portals receive the same callback.
    const listen = (event: KeyboardEvent): void => { handler(event) }
    doc.addEventListener('keydown', listen, capture)
    return () => { doc.removeEventListener('keydown', listen, capture) }
  }, [capture, doc, handler])
}

/**
 * Bind one stable component to the application's mount document, independently of the caller's JavaScript realm.
 * @param doc - Document of this application mount.
 * @returns Component that places its children in the document body without imposing a layout box. Its
 *   `[data-document-portal]` wrapper is a direct body child, so document-wide rules for body children address
 *   the wrapper's children instead. Children mount in the portal's own commit, already attached to the body under
 *   the source's package marker, before their layout effects run.
 */
export function createDocumentPortal(doc: Document): FC<DocumentPortalProps> {
  return function DocumentPortal({ children, onKeyDown, onKeyDownCapture }) {
    const [layer] = useState(() => {
      const wrapper = doc.createElement('div')
      wrapper.setAttribute('data-document-portal', '')
      wrapper.style.display = 'contents'
      return wrapper
    })
    useKeyDown(doc, onKeyDownCapture, true)
    useKeyDown(doc, onKeyDown, false)
    // Each commit samples the source's package marker. The template precedes the portal, so on mount this runs
    // before the layout effects of the portal's children.
    const anchor = (source: HTMLTemplateElement | null): void => {
      // React detaches the previous callback with null on every commit; removing the layer here would drop the
      // children's focus and running animations.
      if (source === null) return
      const owner = source.closest('[data-plugin]')?.getAttribute('data-plugin') ?? null
      if (owner === null) layer.removeAttribute('data-plugin')
      else layer.setAttribute('data-plugin', owner)
      if (!layer.isConnected) doc.body.append(layer)
    }
    // Unmounting removes the layer; a StrictMode remount appends it again.
    useLayoutEffect(() => {
      if (!layer.isConnected) doc.body.append(layer)
      return () => { layer.remove() }
    }, [layer])
    return <><template ref={anchor} />{createPortal(children, layer)}</>
  }
}
