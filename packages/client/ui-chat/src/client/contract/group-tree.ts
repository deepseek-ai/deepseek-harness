import type { ChatConversationViewNode } from './chat-nodes.ts'

/**
 * Chat group-tree positions from the outermost inward; a Node at a position
 * also has the effect of every inner position.
 * - `exchange`: the Node's Turn opens an exchange, the run of Turns that lasts
 *   until the next opening Turn.
 * - `input`: the Node is an input of its Turn. An input before the Turn's
 *   process is the Turn's opening input; a later one is interleaved and keeps
 *   the whole Turn open.
 * - `turn`: the Node stays in its Turn outside the Turn's process disclosure.
 * - `process`: the Node stays in the process disclosure outside step runs.
 * - absent: the Node joins the step run around it.
 *
 * The Definition that builds a Node chooses its position, and step runs, the
 * process disclosure, and Turn inputs are selected by position. An
 * `assistant-step` Node places its rows without one: its reasoning row joins
 * the step run and its reply row stands outside it.
 *
 * Whole-Turn folding also exempts the finalized answer's reply. That exemption
 * comes from the Turn's process specification (`answerAnchorSeq` and
 * `answerStep`), not from a position, because which step answers changes as
 * later steps arrive.
 */
export type ChatGroupTree = 'exchange' | 'input' | 'turn' | 'process'

const DEPTH: Readonly<Record<ChatGroupTree, number>> = { exchange: 0, input: 1, turn: 2, process: 3 }

/**
 * Test whether a Node stands at a group-tree position or outside it.
 * @param node - Chat Node.
 * @param position - group-tree position to compare against.
 * @returns whether the Node's position is `position` or an outer one.
 */
export function isAtOrOutside(node: Pick<ChatConversationViewNode, 'groupTree'>, position: ChatGroupTree): boolean {
  return node.groupTree !== undefined && DEPTH[node.groupTree] <= DEPTH[position]
}
