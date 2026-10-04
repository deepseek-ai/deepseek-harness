/** Weak identity index for materialized Nodes, Groups, Turn/Step locations, and their Data readers. */

import type { ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ConversationBinding, GroupKey, StepLocation, TurnLocation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InspectorChatTarget, InspectorObjectReference } from '../objects.ts'

type Reference = Omit<InspectorObjectReference, 'rowKey'>

/** Indexes each immutable publication once, without retaining its objects or node arrays. */
export class ChatObjectIndex {
  private readonly identities = new WeakMap<object, Reference>()
  private readonly indexed = new WeakSet<object>()

  /** @param binding - Existing Session-owned Conversation reader. */
  constructor(private readonly binding: ConversationBinding) {}

  /**
   * Resolve an original object without retaining replaced publications.
   * @param value - Original object identity.
   * @returns Its named reference, including older identities, or undefined when unregistered.
   */
  reference(value: object): Reference | undefined {
    this.refresh()
    return this.identities.get(value)
  }

  private chat(): ChatSnapshot | undefined { return this.binding.snapshot.getSnapshot().views.get('chat') }

  private register(value: unknown, reference: Reference): void {
    if (value !== null && typeof value === 'object' && !this.identities.has(value)) this.identities.set(value, reference)
  }

  private location(value: TurnLocation | StepLocation, step?: number): void {
    const turn = value.turn
    const identity = step === undefined ? String(turn) : `${turn}/${step}`
    const kind = step === undefined ? 'turn' : 'step'
    const read = (): TurnLocation | StepLocation | undefined => {
      const current = this.chat()?.timeline.turns.get(turn)
      return step === undefined ? current : current?.steps.find(value => value.step === step)
    }
    const firstNode = step === undefined ? this.chat()?.locations.getTurn(turn)[0] : this.chat()?.locations.getStep(turn, step)[0]
    const target: InspectorChatTarget = { turn, ...(firstNode === undefined ? {} : { nodeKey: firstNode }) }
    this.register(value, { id: `${kind}:${identity}`, kind, identity, target, read })
    this.register(value.data, { id: `${kind}-data:${identity}`, kind: step === undefined ? 'turnData' : 'stepData',
      identity, target, read: () => read()?.data })
  }

  private refresh(): void {
    const chat = this.chat()
    if (chat === undefined) return
    const nodes = chat.nodes.values()
    if (!this.indexed.has(nodes)) {
      this.indexed.add(nodes)
      for (const node of nodes) {
        const { key, location } = node
        const turn = location.kind === 'turn' || location.kind === 'step' ? location.turn.turn : undefined
        const target: InspectorChatTarget = { nodeKey: key, ...(turn === undefined ? {} : { turn }) }
        this.register(node, { id: `node:${key}`, kind: 'node', identity: key, target, read: () => this.chat()?.nodes.get(key) })
        this.register(node.data, { id: `node-data:${key}`, kind: 'nodeData', identity: key, target,
          read: () => this.chat()?.nodes.get(key)?.data })
      }
    }
    if (!this.indexed.has(chat.timeline)) {
      this.indexed.add(chat.timeline)
      for (const turn of chat.timeline.turns.values()) {
        this.location(turn)
        for (const step of turn.steps) this.location(step, step.step)
      }
    }
    const groups = this.binding.snapshot.getSnapshot().views.grouped('chat')
    for (const entry of groups?.entries ?? []) {
      if (entry.kind !== 'group') continue
      const key: GroupKey = entry.key
      // oxlint-disable-next-line typescript/no-non-null-assertion -- This entry came from the current group source.
      const group = groups!.groupSource(key).getSnapshot()
      if (group === undefined || this.indexed.has(group)) continue
      this.indexed.add(group)
      const target = { groupKey: key }
      const read = () => this.binding.snapshot.getSnapshot().views.grouped('chat')?.groupSource(key).getSnapshot()
      this.register(group, { id: `group:${key}`, kind: 'group', identity: key, target, read })
      this.register(group.data, { id: `group-data:${key}`, kind: 'groupData', identity: key, target, read: () => read()?.data })
      for (const member of group.members) {
        const nodeKey = member.key
        this.register(member, { id: `node:${nodeKey}`, kind: 'node', identity: nodeKey,
          target: { nodeKey, ...member.groupPart === undefined ? {} : { groupPart: member.groupPart } },
          read: () => this.chat()?.nodes.get(nodeKey) })
      }
    }
  }
}
