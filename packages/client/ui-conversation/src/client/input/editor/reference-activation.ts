/** Route composer clicks through the live reference owner without editing the draft. */
import {
  $getNearestNodeFromDOMNode, $getSelection, $isRangeSelection,
  CLICK_COMMAND, COMMAND_PRIORITY_LOW,
} from 'lexical'
import type { LexicalEditor } from 'lexical'
import type { ReferenceInsert } from '../../contract/input.ts'
import { $isReferenceChipNode } from './chip-node.tsx'
import { TextRefNode } from './text-ref.ts'

/**
 * Install preview activation for atomic chips and editable reference tokens.
 * @param editor - composer editor.
 * @param open - live source routing; false preserves ordinary editor handling.
 * @returns command disposer.
 */
export function registerReferenceActivation(
  editor: LexicalEditor,
  open: (source: string | undefined, reference: Pick<ReferenceInsert, 'ref' | 'appearance'>) => boolean,
): () => void {
  return editor.registerCommand(CLICK_COMMAND, (event) => {
    if (event.target === null || event.button !== 0 || event.detail > 1) return false
    const selection = $getSelection()
    if ($isRangeSelection(selection) && !selection.isCollapsed()) return false
    const node = $getNearestNodeFromDOMNode(event.target as Node)
    if ($isReferenceChipNode(node)) {
      if (node.isInvalid()) return false
      const appearance = node.getAppearance()
      return open(node.getSource(), { ref: node.getReference(), ...appearance === undefined ? {} : { appearance } })
    }
    return node instanceof TextRefNode && open(undefined, { ref: node.getTextContent() })
  }, COMMAND_PRIORITY_LOW)
}
