/**
 * Claim-token highlight: while a command claim holds, the draft's leading
 * token renders in the warn color. A TextNode transform keeps the token in
 * its own styled node (splitting when typing merges text into it), and the
 * shell nudges the first leaf dirty when the claim flips so entering and
 * leaving claimed restyles without a text edit.
 */
import type { LexicalEditor, TextNode as TextNodeType } from 'lexical'
import { $getRoot, $isElementNode, $isTextNode, TextNode } from 'lexical'

/** Inline style carried by the claim-token node (the old backdrop's hlToken color). */
const TOKEN_STYLE = 'color: var(--dsw-alias-state-warn-label)'

/** The document's first text leaf, or null (empty document / leading chip). */
function firstTextLeaf(): TextNodeType | null {
  const block = $getRoot().getFirstChild()
  if (!$isElementNode(block)) return null
  const leaf = block.getFirstChild()
  return $isTextNode(leaf) ? leaf : null
}

/**
 * Register the claim-token styling transform.
 * @param editor - the shell-owned editor.
 * @param activeToken - live claim token accessor; null while unclaimed.
 * @returns the unregister disposer.
 */
export function registerClaimDecoration(editor: LexicalEditor, activeToken: () => string | null): () => void {
  return editor.registerNodeTransform(TextNode, (node) => {
    const first = firstTextLeaf()
    if (first === null || node.getKey() !== first.getKey()) {
      // Off the token seat: clear a stale token style (a node can move here
      // by paragraph merges).
      if (node.getStyle() === TOKEN_STYLE) node.setStyle('')
      return
    }
    const text = node.getTextContent()
    const active = activeToken()
    const token = text === active?.trimEnd() ? text : active
    if (token === null || !text.startsWith(token)) {
      if (node.getStyle() === TOKEN_STYLE) node.setStyle('')
      return
    }
    if (text.length > token.length) {
      // Typing at the token boundary lands in the styled node; split the
      // overflow back out so only the token itself carries the color.
      const [tokenNode] = node.splitText(token.length)
      if (tokenNode !== undefined && tokenNode.getStyle() !== TOKEN_STYLE) tokenNode.setStyle(TOKEN_STYLE)
      return
    }
    if (node.getStyle() !== TOKEN_STYLE) node.setStyle(TOKEN_STYLE)
  })
}

/**
 * Nudge the token seat dirty so the transform restyles after a claim flip
 * (claims change phase without a text edit; transforms only run on dirty
 * nodes).
 * @param editor - the shell-owned editor.
 */
export function refreshClaimDecoration(editor: LexicalEditor): void {
  // Not discrete: a refresh can fire from inside an update listener, where a
  // synchronous nested commit would recurse; the queued update lands on the
  // next flush.
  editor.update(() => {
    firstTextLeaf()?.markDirty()
  })
}
