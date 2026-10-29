/** Read browser text selections from one diff side without including the interleaved opposite column. */

/** Selected displayed lines and the exact selected text on their side. */
export interface CodeSelection {
  readonly side: 'L' | 'R'
  readonly from: number
  readonly to: number
  readonly text: string
}

function codeAt(node: Node | null): HTMLElement | null {
  return (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>('[data-review-code]') ?? null
}

/**
 * Find the side where a text selection begins; unified context belongs to the new side.
 * @param root - this file's diff element.
 * @param node - pointer or selection anchor.
 * @returns the available side, or undefined outside code text.
 */
export function codeSideAt(root: HTMLElement, node: Node | null): 'L' | 'R' | undefined {
  const code = codeAt(node)
  if (code === null || !root.contains(code)) return undefined
  return code.dataset.newLine === undefined ? 'L' : 'R'
}

/**
 * Read only code fragments from the selected side, retaining partial first and last lines for copy.
 * @param root - this file's diff element.
 * @param side - side captured when the gesture began.
 * @returns the selected range and text, or undefined for collapsed or cross-file selections.
 */
export function readCodeSelection(root: HTMLElement, side: 'L' | 'R'): CodeSelection | undefined {
  const selection = root.ownerDocument.getSelection()
  if (selection === null || selection.isCollapsed || selection.rangeCount === 0
    || !root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return undefined
  const range = selection.getRangeAt(0)
  const fragments: { line: number; text: string }[] = []
  for (const code of root.querySelectorAll<HTMLElement>('[data-review-code]')) {
    const line = side === 'L' ? code.dataset.oldLine : code.dataset.newLine
    if (line === undefined || !range.intersectsNode(code)) continue
    const part = root.ownerDocument.createRange()
    part.selectNodeContents(code)
    if (code.contains(range.startContainer)) part.setStart(range.startContainer, range.startOffset)
    if (code.contains(range.endContainer)) part.setEnd(range.endContainer, range.endOffset)
    const text = part.toString()
    if (text !== '' || code.textContent === '') fragments.push({ line: Number(line), text })
  }
  const first = fragments[0]
  const last = fragments.at(-1)
  if (first === undefined || last === undefined) return undefined
  return { side, from: first.line, to: last.line, text: fragments.map(item => item.text).join('\n') }
}
