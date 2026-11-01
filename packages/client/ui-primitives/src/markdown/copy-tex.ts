/** Clipboard projection that copies rendered KaTeX formulas as their TeX source. */

/** The whole formula around a node, including the display wrapper that marks display math. */
function closestFormula(node: Node): Element | null {
  const element = node instanceof Element ? node : node.parentElement
  return element?.closest('.katex-display') ?? element?.closest('.katex') ?? null
}

/**
 * Rewrite a copy whose selection lies inside one rendered Markdown document and
 * includes rendered math, so each formula becomes its trimmed TeX source,
 * delimited as `$…$` inline and `$$…$$` for display math, in both the
 * plain-text and HTML clipboard data. A selection endpoint inside a formula
 * extends to the whole formula in the clipboard only; the visible selection is
 * unchanged. A copy without math, a selection reaching outside `root`, and a
 * copy whose default an inner listener already prevented keep their data.
 * @param event - Native copy event.
 * @param root - The rendered Markdown document root.
 */
export function copyKatexAsTex(event: ClipboardEvent, root: HTMLElement): void {
  const selection = root.ownerDocument.getSelection()
  if (event.defaultPrevented || event.clipboardData === null || selection === null
    || selection.rangeCount !== 1 || selection.isCollapsed) return
  const range = selection.getRangeAt(0).cloneRange()
  if (!root.contains(range.commonAncestorContainer)) return
  const startFormula = closestFormula(range.startContainer)
  if (startFormula !== null) range.setStartBefore(startFormula)
  const endFormula = closestFormula(range.endContainer)
  if (endFormula !== null) range.setEndAfter(endFormula)
  const fragment = range.cloneContents()
  const formulas = [...fragment.querySelectorAll('.katex')]
  if (formulas.length === 0) return
  for (const formula of formulas) {
    const tex = formula.querySelector('annotation[encoding="application/x-tex"]')?.textContent.trim()
    if (tex === undefined) continue
    const delimiter = formula.closest('.katex-display') === null ? '$' : '$$'
    formula.replaceWith(`${delimiter}${tex}${delimiter}`)
  }
  // innerText applies the browser's own block and line-break serialization,
  // which needs a rendered element; an off-screen child of the root keeps the
  // Markdown styles that decide block layout while staying invisible.
  const container = root.ownerDocument.createElement('div')
  container.style.cssText = 'position:fixed;top:0;left:-100000px;pointer-events:none'
  container.append(fragment)
  root.append(container)
  try {
    event.clipboardData.setData('text/plain', container.innerText)
    event.clipboardData.setData('text/html', container.innerHTML)
  } finally {
    container.remove()
  }
  event.preventDefault()
}
