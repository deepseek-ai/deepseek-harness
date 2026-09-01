import type { ChatNode } from '../contract/chat-nodes.ts'
import type { ChatLocationNodeIndex, ChatNodeStore, TurnNavigationItem } from '../contract/snapshot.ts'

/**
 * Preview budgets, sized to the rail card's clamps (one prompt line, up to
 * three response lines) and mirrored by the turnOutline projection so a turn
 * shows the same words before and after its events load. Anything past a
 * budget is invisible; copying whole transcripts into navigation state would
 * otherwise grow with the loaded window on every structural update.
 */
const PROMPT_PREVIEW_LIMIT = 50
const RESPONSE_PREVIEW_LIMIT = 120

/** Join rendered text, collapse whitespace, and cap at `limit` with a trailing ellipsis when clipped. */
// Deliberate mirror of the turnOutline projection's preview(): the wire
// boundary forbids sharing code with the host package.
/* jscpd:ignore-start */
function preview(parts: Iterable<string>, limit: number): string {
  let text = ''
  let unread = false
  for (const part of parts) {
    if (text.length >= limit * 2) {
      unread = true
      break
    }
    // Per-part bound: this runs on every structural rail update, so one huge
    // text block must not be concatenated (and regex-normalized) whole for a
    // preview this short.
    const clipped = part.length > limit * 2
    const chunk = clipped ? part.slice(0, limit * 2) : part
    text += text === '' ? chunk : ` ${chunk}`
    if (clipped) {
      unread = true
      break
    }
  }
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length > limit - 1) return `${normalized.slice(0, limit - 1).trimEnd()}…`
  return unread ? `${normalized}…` : normalized
}
/* jscpd:ignore-end */

function promptText(node: ChatNode): string {
  if (node.kind !== 'user') return ''
  return preview(node.data.content.flatMap(block => block.type === 'text' ? [block.text] : []), PROMPT_PREVIEW_LIMIT)
}

function responseText(node: ChatNode): string {
  if (node.kind !== 'assistant-step') return ''
  return preview(
    node.data.blocks.flatMap(block => block.kind === 'text' ? [block.text] : []),
    RESPONSE_PREVIEW_LIMIT,
  )
}

/**
 * Whether two items carry the same rail state, so the reader can keep its array.
 * @param left - previously published item, when the Turn had one.
 * @param right - freshly derived item, when the Turn still has one.
 * @returns whether both sides describe the same mark.
 */
export function sameTurnNavigationItem(
  left: TurnNavigationItem | undefined,
  right: TurnNavigationItem | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right
  return left.turn === right.turn && left.anchorKey === right.anchorKey
    && left.prompt === right.prompt && left.response === right.response
}

/**
 * Project one loaded Turn into its rail item.
 * @param turn - Turn number the item addresses.
 * @param locations - live Location index supplying the Turn's node keys.
 * @param nodes - live Chat node store.
 * @returns the item, or undefined when the Turn has no visible loaded node.
 */
export function turnNavigationItem(
  turn: number,
  locations: ChatLocationNodeIndex,
  nodes: ChatNodeStore,
): TurnNavigationItem | undefined {
  const loaded = locations.getTurn(turn)
    .map(key => nodes.get(key))
    .filter((node): node is ChatNode => node !== undefined && node.visibility === 'visible')
  const user = loaded.find(node => node.kind === 'user')
  const anchor = user ?? loaded[0]
  if (anchor === undefined) return undefined
  const response = loaded.findLast(node => responseText(node) !== '')
  return {
    turn,
    anchorKey: anchor.key,
    prompt: user === undefined ? '' : promptText(user),
    response: response === undefined ? '' : responseText(response),
  }
}
