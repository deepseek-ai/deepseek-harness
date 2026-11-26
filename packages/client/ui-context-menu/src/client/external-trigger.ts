/** Context-menu trigger recognition shared by the document listener and popup. */

const TRIGGER = '[data-context-menu-trigger]'

/**
 * Recognize an explicit menu button without depending on the popup implementation.
 * @param node - Pointer event target.
 * @returns Whether the node belongs to an explicit menu button.
 */
export function isContextMenuTrigger(node: Node): boolean {
  // A node other than an element has no `closest`, so its parent element answers.
  return ((node as Partial<Element>).closest?.(TRIGGER) ?? node.parentElement?.closest(TRIGGER)) != null
}
