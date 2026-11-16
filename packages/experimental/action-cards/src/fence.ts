/** Find the `action-card` blocks of answer text with the Markdown grammar the Chat client renders settled answers with. */
import type { Nodes } from 'mdast'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { mathFromMarkdown } from 'mdast-util-math'
import { gfm } from 'micromark-extension-gfm'
import { math } from 'micromark-extension-math'
import type { ActionCardFence } from './types.ts'

/** Language of a block that offers a card, compared as the Chat client dispatches fences. */
export const ACTION_CARD_FENCE: ActionCardFence = 'action-card'

/**
 * Three backticks or tildes, then spaces or tabs, then a first info-string character that can decode to the card
 * language: `a`, `A`, or the `&` of a character reference. Text without this opening holds no card block.
 */
const CARD_FENCE_OPENING = /(?:`{3}|~{3})[\t ]*[a&]/iu

/** Append, in document order, the content of every non-empty code block at any depth whose language is the card language. */
function collect(node: Nodes, found: string[]): string[] {
  const language = /^[\w-]+/u.exec(node.type === 'code' ? node.lang ?? '' : '')?.[0].toLowerCase()
  if (node.type === 'code' && node.value !== '' && language === ACTION_CARD_FENCE) found.push(node.value)
  if ('children' in node) for (const child of node.children) collect(child, found)
  return found
}

/**
 * Contents of the fenced code blocks whose language is {@link ACTION_CARD_FENCE}, at any depth and in text order.
 * The text is parsed with the GFM and math grammar of the Chat client's settled answers, so a block counts exactly when
 * the client dispatches it to the card language: the leading letters, digits, `_` and `-` of the info string's first
 * word after escapes and character references are decoded, compared case-insensitively. An empty block offers nothing.
 * @param text - one text block of an assistant message.
 * @returns the blocks' contents.
 */
export function actionCardFences(text: string): string[] {
  if (!CARD_FENCE_OPENING.test(text)) return []
  return collect(fromMarkdown(text, {
    extensions: [gfm({ singleTilde: false }), math()],
    mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()],
  }), [])
}
