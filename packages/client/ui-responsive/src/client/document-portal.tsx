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
 * @param page - Read the current presentation document when the component renders.
 * @returns Component that places its children in the document body without imposing a layout box.
 */
export function createDocumentPortal(page: () => Document): FC<DocumentPortalProps> {
  return function DocumentPortal({ children, onKeyDown, onKeyDownCapture }) {
    const doc = page()
    const [owner, setOwner] = useState<string | null>()
    useKeyDown(doc, onKeyDownCapture, true)
    useKeyDown(doc, onKeyDown, false)
    // Sample after each commit, including a change of the existing source boundary. Children mount already scoped.
    const readOwner = (source: HTMLTemplateElement | null): void => {
      if (source) setOwner(source.closest('[data-plugin]')?.getAttribute('data-plugin') ?? null)
    }
    return <><template ref={readOwner} />{owner !== undefined && createPortal(
      <div data-plugin={owner ?? undefined} style={{ display: 'contents' }}>{children}</div>,
      doc.body,
    )}</>
  }
}
