/** Clipboard projection that copies rendered KaTeX formulas as their TeX source. */

/** The whole formula around a node, including the display wrapper that marks display math. */
function closestFormula(node: Node): Element | null {
  const element = node instanceof Element ? node : node.parentElement
  return element?.closest('.katex-display') ?? element?.closest('.katex') ?? null
}

/**
 * Rewrite a copy whose document selection includes rendered math so each
 * formula becomes its TeX source, delimited as `$…$` inline and `$$…$$` for
 * display math, in both the plain-text and HTML clipboard data. A selection
 * endpoint inside a formula extends to the whole formula in the clipboard only;
 * the visible selection is unchanged. Copies without math, or already handled
 * by an inner listener, keep their data.
 * @param event - Native copy event.
 * @param document - Document whose selection is copied.
 */
export function copyKatexAsTex(event: ClipboardEvent, document: Document): void {
  const selection = document.getSelection()
  if (event.defaultPrevented || event.clipboardData === null || selection === null
    || selection.rangeCount !== 1 || selection.isCollapsed) return
  const range = selection.getRangeAt(0).cloneRange()
  const startFormula = closestFormula(range.startContainer)
  if (startFormula !== null) range.setStartBefore(startFormula)
  const endFormula = closestFormula(range.endContainer)
  if (endFormula !== null) range.setEndAfter(endFormula)
  const fragment = range.cloneContents()
  const formulas = [...fragment.querySelectorAll('.katex')]
  if (formulas.length === 0) return
  for (const formula of formulas) {
    const tex = formula.querySelector('annotation[encoding="application/x-tex"]')?.textContent
    if (tex === undefined) continue
    const delimiter = formula.closest('.katex-display') === null ? '$' : '$$'
    formula.replaceWith(`${delimiter}${tex}${delimiter}`)
  }
  // innerText applies the browser's own block and line-break serialization,
  // which needs a rendered element; an off-screen one keeps it invisible.
  const container = document.createElement('div')
  container.style.cssText = 'position:fixed;top:0;left:-100000px;white-space:normal;pointer-events:none'
  container.append(fragment)
  document.body.append(container)
  try {
    event.clipboardData.setData('text/plain', container.innerText)
    event.clipboardData.setData('text/html', container.innerHTML)
  } finally {
    container.remove()
  }
  event.preventDefault()
}
