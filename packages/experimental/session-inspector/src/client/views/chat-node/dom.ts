/** DOM lookups owned by the experimental Inspector, using existing Slot and Chat attributes. */

import type { InspectorChatTarget } from '../objects.ts'

/**
 * Check an existing element's mounted and ancestor visibility without revealing it.
 * @param element - Candidate element.
 * @returns Whether CSS and hidden ancestors allow it to be displayed.
 */
export function displayed(element: HTMLElement): boolean {
  if (!element.isConnected || element.closest('[hidden]') !== null) return false
  for (let parent: HTMLElement | null = element; parent !== null; parent = parent.parentElement) {
    const style = getComputedStyle(parent)
    if (style.display === 'none' || style.visibility === 'hidden') return false
  }
  return true
}

/**
 * Find the displayed main Chat's outer flow column without entering a Sidebar or nested View.
 * @returns The current Chat column, or undefined while another View is selected.
 */
export function mainChatRoot(): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('[data-slot="main.conversation"] [data-slot="conversation.view"] [data-chat-flow]')]
    .find(element => element.closest('[data-sidebar-right-session], [data-step-process-body]') === null && displayed(element))
}

/**
 * Restrict a DOM match to the selected Chat column and its own Conversation View.
 * @param element - Candidate node, including SVG children.
 * @param root - Main Chat column.
 * @returns Whether the candidate belongs to that occurrence.
 */
export function inChat(element: Element, root: HTMLElement): boolean {
  return root.contains(element) && element.closest('[data-sidebar-right-session]') === null
    && element.closest('[data-slot="conversation.view"]') === root.closest('[data-slot="conversation.view"]')
}

/**
 * Enumerate exact and approximate occurrences without changing their display state.
 * @param root - Current main Chat column.
 * @param targets - Exact identities followed by nearby loaded Node identities.
 * @returns Unique candidates, with the requested Turn's occurrences before other Turns.
 */
export function findChatTargets(root: HTMLElement, targets: readonly InspectorChatTarget[]): readonly HTMLElement[] {
  const fields = ['chatCallId', 'chatNodeKey', 'chatGroupKey', 'chatTurn'] as const
  const indexed = {
    chatCallId: new Map<string, HTMLElement[]>(), chatNodeKey: new Map<string, HTMLElement[]>(),
    chatGroupKey: new Map<string, HTMLElement[]>(), chatTurn: new Map<string, HTMLElement[]>(),
  }
  for (const element of root.querySelectorAll<HTMLElement>('[data-chat-call-id], [data-chat-node-key], [data-chat-group-key], [data-chat-turn]')) {
    if (!inChat(element, root)) continue
    for (const field of fields) {
      const value = element.dataset[field]
      if (value === undefined) continue
      const matches = indexed[field].get(value)
      if (matches === undefined) indexed[field].set(value, [element])
      else matches.push(element)
    }
  }
  const found = new Set<HTMLElement>()
  const add = (field: typeof fields[number], value: string | undefined, part?: string): void => {
    if (value === undefined) return
    for (const element of indexed[field].get(value) ?? []) {
      if (part === undefined || element.dataset.chatGroupPart === part) found.add(element)
    }
  }
  const turns = new Set<number>()
  const preferredTurn = targets.find(target => target.turn !== undefined)?.turn
  let preferredTurnAdded = false
  for (const [index, target] of targets.entries()) {
    if (index > 0 && preferredTurn !== undefined && target.turn !== preferredTurn && !preferredTurnAdded) {
      add('chatTurn', String(preferredTurn))
      preferredTurnAdded = true
    }
    add('chatCallId', target.callId)
    add('chatNodeKey', target.nodeKey, target.groupPart)
    add('chatNodeKey', target.nodeKey)
    add('chatCallId', target.rootCallId)
    add('chatGroupKey', target.groupKey)
    if (target.turn !== undefined) turns.add(target.turn)
  }
  for (const turn of turns) {
    if (!preferredTurnAdded || turn !== preferredTurn) add('chatTurn', String(turn))
  }
  return [...found]
}
