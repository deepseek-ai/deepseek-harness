/** Precise and nearby Chat reveal candidates from the Inspector's loaded Chat snapshot. */

import type { InspectorChatTarget } from '../objects.ts'
import type { ChatConversationViewNode, ToolChatData } from '@deepseek-ai/dsh-client-ui-chat/client'

function nearest(nodes: readonly ChatConversationViewNode[], seq: number): ChatConversationViewNode | undefined {
  let best: ChatConversationViewNode | undefined
  for (const node of nodes) {
    if (best === undefined || Math.abs(node.anchorSeq - seq) < Math.abs(best.anchorSeq - seq)) best = node
  }
  return best
}

function primaryTarget(target: InspectorChatTarget, visible: readonly ChatConversationViewNode[]): InspectorChatTarget {
  if (target.nodeKey !== undefined || target.anchorSeq === undefined) return target
  const inTurn = target.turn === undefined ? visible : visible.filter(node =>
    (node.location.kind === 'turn' || node.location.kind === 'step') && node.location.turn.turn === target.turn)
  const inStep = target.step === undefined ? inTurn
    : inTurn.filter(node => node.location.kind === 'step' && node.location.step.step === target.step)
  const rootCallId = target.rootCallId ?? target.callId
  const tool = rootCallId === undefined ? undefined
    : visible.find(node => node.kind === 'tool-call' && (node.data as ToolChatData).root.callId === rootCallId)
  const exact = inStep.find(node => node.anchorSeq === target.anchorSeq)
  const kind = target.nodeKind === undefined ? undefined : inStep.find(node => node.kind === target.nodeKind)
  const node = tool ?? exact ?? kind ?? nearest(inStep, target.anchorSeq) ?? nearest(inTurn, target.anchorSeq)
  if (node === undefined) return target
  const turn = target.turn ?? (node.location.kind === 'turn' || node.location.kind === 'step' ? node.location.turn.turn : undefined)
  return { ...target, nodeKey: node.key, ...turn === undefined ? {} : { turn } }
}

function nodeTarget(node: ChatConversationViewNode) {
  const location = node.location
  return {
    nodeKey: node.key,
    anchorSeq: node.anchorSeq,
    ...location.kind === 'turn' || location.kind === 'step' ? { turn: location.turn.turn } : {},
    ...location.kind === 'step' ? { step: location.step.step } : {},
  }
}

function targetKey(target: InspectorChatTarget): string {
  return JSON.stringify([
    target.anchorSeq, target.callId, target.rootCallId, target.nodeKey, target.nodeKind,
    target.groupKey, target.groupPart, target.turn, target.step,
  ])
}

/**
 * Preserve the primary identity or tool/exact/kind/nearest placement, then rank visible neighbors.
 * Explicit-node primaries include missing model coordinates, even when the node is hidden.
 * Request coordinates take precedence over the node's position.
 * Without a known anchor sequence, only the original target is returned.
 * @param target - Object identity or original event coordinates supplied by another View.
 * @param nodes - Current Session's loaded Chat nodes; equal-distance candidates retain input order.
 * @returns Primary target followed by distinct Step, Turn, and Session neighbors with only node coordinates.
 */
export function resolveChatRevealTargets(
  target: InspectorChatTarget,
  nodes: readonly ChatConversationViewNode[],
): readonly InspectorChatTarget[] {
  const visible = nodes.filter(node => node.visibility === 'visible')
  const explicit = target.nodeKey === undefined ? undefined : nodes.find(node => node.key === target.nodeKey)
  const position = explicit === undefined ? undefined : nodeTarget(explicit)
  const referenceSeq = target.anchorSeq ?? position?.anchorSeq
  const turn = target.turn ?? position?.turn
  const step = target.step ?? position?.step
  const primary = position === undefined ? primaryTarget(target, visible) : {
    ...target,
    anchorSeq: target.anchorSeq ?? position.anchorSeq,
    ...turn === undefined ? {} : { turn },
    ...step === undefined ? {} : { step },
  }
  if (referenceSeq === undefined) return [primary]
  const rank = (candidate: ReturnType<typeof nodeTarget>): number => {
    const sameTurn = turn === undefined || candidate.turn === turn
    if (sameTurn && step !== undefined && candidate.step === step) return 0
    return sameTurn && turn !== undefined ? 1 : 2
  }
  const neighbors = visible.map(nodeTarget).sort((left, right) =>
    rank(left) - rank(right) || Math.abs(left.anchorSeq - referenceSeq) - Math.abs(right.anchorSeq - referenceSeq))
  const candidates = [primary]
  const seen = new Set([targetKey(primary)])
  for (const candidate of neighbors) {
    const key = targetKey(candidate)
    if (seen.has(key)) continue
    seen.add(key)
    candidates.push(candidate)
  }
  return candidates
}
