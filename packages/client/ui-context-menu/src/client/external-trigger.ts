/** Context-menu trigger recognition shared by the document listener and popup. */

/**
 * Recognize an explicit menu button without depending on the popup implementation.
 * @param node - Pointer event target.
 * @returns Whether the node belongs to an explicit menu button.
 */
export function isContextMenuTrigger(node: Node): boolean {
  const element = node instanceof Element ? node : node.parentElement
  return element?.closest('[data-context-menu-trigger]') != null
}
