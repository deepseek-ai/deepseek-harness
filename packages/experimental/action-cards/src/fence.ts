/** Find the fenced blocks of answer text that offer action cards. */
import type { ActionCardFence } from './types.ts'

/** Language of a block that offers a card, matched after lowercasing, as the Chat client dispatches fences. */
export const ACTION_CARD_FENCE: ActionCardFence = 'action-card'

const OPENING = /^( {0,3})(`{3,}|~{3,})(.*)$/u
const CANDIDATE = new RegExp(ACTION_CARD_FENCE, 'iu')

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
  const marker = String(opening[2])
  const info = String(opening[3])
  if (marker.startsWith('`') && info.includes('`')) return undefined
  return {
    closing: new RegExp(`^ {0,3}${marker.charAt(0)}{${String(marker.length)},}[ \\t]*$`, 'u'),
    outdent: new RegExp(`^ {0,${String(indent.length)}}`, 'u'),
    content: languageOf(info) === ACTION_CARD_FENCE ? [] : undefined,
  }
}

/**
 * Contents of the top-level fenced code blocks whose language is {@link ACTION_CARD_FENCE}, in text order.
 * A fence opens with at least three backticks or tildes indented by at most three spaces, and closes at a line of the
 * same character at least as long, or at the end of the text; content lines lose up to the opening's indentation.
 * Fences inside lists or block quotes are not read.
 * @param text - one text block of an assistant message.
 * @returns the blocks' contents.
 */
export function actionCardFences(text: string): string[] {
  const found: string[] = []
  if (!CANDIDATE.test(text)) return found
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
