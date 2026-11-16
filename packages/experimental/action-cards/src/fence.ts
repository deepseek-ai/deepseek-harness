/** Find the fenced blocks of answer text that offer action cards. */
import type { ActionCardFence } from './types.ts'

/** Language of a block that offers a card, matched after lowercasing, as the Chat client dispatches fences. */
export const ACTION_CARD_FENCE: ActionCardFence = 'action-card'

/** Up to three spaces, optionally the marker of the list item the fence starts, then the fence and its info string. */
const OPENING = /^( {0,3})((?:[-+*]|\d{1,9}[.)]) {1,4})?(`{3,}|~{3,})(.*)$/u

/** An open fence: its closing line, its content indentation and, for a card block, the content read so far. */
interface OpenFence {
  readonly closing: RegExp
  readonly outdent: RegExp
  readonly content: string[] | undefined
}

/** Lowercased leading letters, digits, `_` and `-` of an info string's first word. */
function languageOf(info: string): string {
  return info.trim().replace(/[^\w-][\s\S]*$/u, '').toLowerCase()
}

/** The fence a line opens, or undefined when the line opens none. */
function opened(line: string): OpenFence | undefined {
  const opening = OPENING.exec(line)
  if (opening === null) return undefined
  const indent = String(opening[1])
  const item: string | undefined = opening[2]
  const marker = String(opening[3])
  const info = String(opening[4])
  if (marker.startsWith('`') && info.includes('`')) return undefined
  // In a list item, content lines and the closing line are indented from the item's content column.
  const width = indent.length + (item?.length ?? 0)
  const closingIndent = (item === undefined ? 0 : width) + 3
  return {
    closing: new RegExp(`^ {0,${String(closingIndent)}}${marker.charAt(0)}{${String(marker.length)},}[ \\t]*$`, 'u'),
    outdent: new RegExp(`^ {0,${String(width)}}`, 'u'),
    content: languageOf(info) === ACTION_CARD_FENCE ? [] : undefined,
  }
}

/**
 * Contents of the fenced code blocks whose language is {@link ACTION_CARD_FENCE}, in text order.
 * A fence opens with at least three backticks or tildes after at most three spaces, optionally followed by the marker of
 * the list item it starts. It closes at a line of the same character at least as long, indented at most three spaces
 * past the list item's content column or, outside a list item, the line start; an unclosed fence runs to the end of the
 * text. Content lines lose up to the opening's indentation, marker included. Fences in block quotes or indented four or
 * more spaces are not read.
 * @param text - one text block of an assistant message.
 * @returns the blocks' contents.
 */
export function actionCardFences(text: string): string[] {
  const found: string[] = []
  let fence: OpenFence | undefined
  for (const line of text.split(/\r?\n/u)) {
    if (fence === undefined) {
      fence = opened(line)
    } else if (fence.closing.test(line)) {
      if (fence.content !== undefined) found.push(fence.content.join('\n'))
      fence = undefined
    } else {
      fence.content?.push(line.replace(fence.outdent, ''))
    }
  }
  if (fence?.content !== undefined) found.push(fence.content.join('\n'))
  return found
}
