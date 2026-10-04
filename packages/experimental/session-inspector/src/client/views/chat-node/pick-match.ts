/** Replaceable element-to-record matching rules for the Inspector's Chat picker. */

import type { InspectorChatTarget } from '../objects.ts'
import { displayed, inChat } from './dom.ts'

/** Chat identities enriched with the Node's loaded log coordinates before row lookup. */
export interface InspectorPickTarget extends InspectorChatTarget {
  readonly anchorSeq?: number
  readonly nodeKind?: string
}

/** A visible Chat box and its most specific available identity. */
export interface InspectorElementMatch {
  readonly element: HTMLElement
  readonly target: InspectorPickTarget
}

/**
 * Match tool-call boxes and Node parts before Group or Turn containers; never compare rendered text.
 * @param element - Pointer target in the main Chat.
 * @param root - Inspected Session's displayed main Chat column.
 * @returns Candidate identities and the box to preview, or undefined outside matching content.
 */
export function matchChatElement(element: Element, root: HTMLElement): InspectorElementMatch | undefined {
  if (!inChat(element, root) || !displayed(root) || element.closest('[hidden]') !== null) return undefined
  const closest = (selector: string): HTMLElement | undefined => {
    const found = element.closest<HTMLElement>(selector)
    return found !== null && inChat(found, root) && displayed(found) ? found : undefined
  }
  const node = closest('[data-chat-node-key]')
  const call = closest('[data-chat-call-id]')
  const group = closest('[data-chat-group-key]')
  const turnElement = closest('[data-chat-turn]')
  const box = call ?? node ?? group ?? turnElement
  if (box === undefined) return undefined
  const turnValue = turnElement?.dataset.chatTurn
  const turn = turnValue === undefined || turnValue === '' ? undefined : Number(turnValue)
  return { element: box, target: {
    ...node?.dataset.chatNodeKey === undefined ? {} : { nodeKey: node.dataset.chatNodeKey },
    ...node?.dataset.chatGroupPart === undefined ? {} : { groupPart: node.dataset.chatGroupPart },
    ...node?.dataset.chatFlowKind === undefined ? {} : { nodeKind: node.dataset.chatFlowKind },
    ...call?.dataset.chatCallId === undefined ? {} : { callId: call.dataset.chatCallId },
    ...group?.dataset.chatGroupKey === undefined ? {} : { groupKey: group.dataset.chatGroupKey },
    ...turn !== undefined && Number.isSafeInteger(turn) && turn >= 0 ? { turn } : {},
  } }
}

/**
 * Prefer an exact Node part, then its Node, Group, Step, or Turn table row.
 * @param target - Picked identities.
 * @param rows - Current row identities, including members of folded Inspector groups.
 * @returns The closest materialized table row, or undefined when none matches.
 */
export function matchChatNodeRow(target: InspectorPickTarget, rows: ReadonlyMap<string, InspectorChatTarget>): string | undefined {
  const entries = [...rows]
  if (target.nodeKey !== undefined) {
    const nodes = entries.filter(([, row]) => row.nodeKey === target.nodeKey)
    const exact = nodes.find(([, row]) => row.groupPart === target.groupPart) ?? nodes[0]
    if (exact !== undefined) return exact[0]
  }
  if (target.groupKey !== undefined) {
    const group = entries.find(([, row]) => row.groupKey === target.groupKey && row.nodeKey === undefined)
    if (group !== undefined) return group[0]
  }
  if (target.turn === undefined) return undefined
  const turn = entries.filter(([, row]) => row.turn === target.turn)
  return (target.step === undefined ? turn[0] : turn.find(([, row]) => row.step === target.step) ?? turn[0])?.[0]
}
