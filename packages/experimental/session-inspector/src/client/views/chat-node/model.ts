/** Chat table order follows root references and group membership, independently of row data. */

import type { ChatSnapshot, ChatConversationViewNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ConversationBinding, ConversationGroupedView, GroupKey, GroupSnapshot, NodeReference, RenderEntry } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { InspectorRecordSource, type InspectorRecord, type InspectorRow } from '../table-model.ts'
import { inspectorPreview } from '../format.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { InspectorChatTarget, InspectorObjects, InspectorObjectReference } from '../objects.ts'
import { ChatObjectIndex } from './objects.ts'
import { matchChatNodeRow, type InspectorPickTarget } from './pick-match.ts'

const EMPTY: readonly InspectorRow[] = []
const COLUMN_FIELDS = ['key', 'kind']

function nodeRecord(node: ChatConversationViewNode): InspectorRecord {
  const location = node.location
  return { type: node.kind, identity: node.key,
    location: location.kind === 'step' ? `${location.turn.turn}/${location.step.step}`
      : location.kind === 'turn' ? String(location.turn.turn) : location.kind,
    value: node, summary: inspectorPreview(node, COLUMN_FIELDS) }
}

/** Observes structural Chat changes while visible rows observe their own Node or Group. */
export class ChatNodeModel implements ObservableSnapshot<readonly InspectorRow[]> {
  private readonly rows = createSnapshotStore<readonly InspectorRow[]>(EMPTY)
  private readonly sources = new Map<string, ObservableSnapshot<InspectorRecord | undefined>>()
  private readonly groups = new Map<GroupKey, () => void>()
  private entries: readonly RenderEntry[] | undefined
  private order: readonly string[] | undefined
  private keys: readonly string[] | undefined
  private anchors: readonly number[] | undefined
  private nodeStore: ChatSnapshot['nodes'] | undefined
  private grouped: ConversationGroupedView<unknown> | undefined
  private subscribers = 0
  private disconnect: (() => void) | undefined
  private queued = false
  private readonly targets = new Map<string, InspectorChatTarget>()
  private readonly objectIndex: ChatObjectIndex

  /** @param binding - Existing target-neutral Conversation binding for the inspected Session. */
  constructor(private readonly binding: ConversationBinding) { this.objectIndex = new ChatObjectIndex(binding); this.refresh() }

  /**
   * Bind object references and publication updates to the inspected Session.
   * @param sessionId - Session displayed by this model.
   * @returns Weak object lookup and row navigation for its details.
   */
  objects(sessionId: SessionId): InspectorObjects {
    const reference = (value: object): InspectorObjectReference | undefined => {
      const found = this.objectIndex.reference(value)
      if (found === undefined) return undefined
      const row = [...this.targets].find(([, target]) => found.target.nodeKey !== undefined
        ? target.nodeKey === found.target.nodeKey && (found.target.groupPart === undefined || target.groupPart === found.target.groupPart)
        : found.target.groupKey !== undefined && target.groupKey === found.target.groupKey)
      return { ...found, ...(row === undefined ? {} : { rowKey: row[0] }) }
    }
    return { sessionId, updates: this.binding.snapshot, reference, row: (key) => {
      const value = this.row(key)?.getSnapshot()?.value
      if (value === null || typeof value !== 'object') return undefined
      const found = reference(value)
      const target = this.targets.get(key)
      return found === undefined || target === undefined ? undefined : { ...found, rowKey: key, target }
    } }
  }

  /** @returns Stable flattened group/node order. */
  getSnapshot = (): readonly InspectorRow[] => this.rows.getSnapshot()

  /**
   * Match a picked Chat object against the current table, including folded children.
   * @param target - Picked Chat identities.
   * @returns Closest current Node or Group row, or undefined without a match.
   */
  pick(target: InspectorPickTarget): string | undefined {
    this.refresh(true)
    return matchChatNodeRow(target, this.targets)
  }

  /** @param listener - Structural invalidation callback. @returns Its disposer. */
  subscribe = (listener: () => void): (() => void) => {
    const stop = this.rows.subscribe(listener)
    if (this.subscribers++ === 0) {
      this.disconnect = this.binding.snapshot.subscribe(() => { this.refresh() })
      this.binding.activate('chat')
      this.refresh(true)
    }
    return () => {
      stop()
      if (--this.subscribers === 0) {
        this.disconnect?.()
        this.disconnect = undefined
        for (const stop of this.groups.values()) stop()
        this.groups.clear()
      }
    }
  }

  /**
   * Read a loaded row without adding a subscription.
   * @param key - Stable table position.
   * @returns Cached Node or Group metadata source, or undefined outside the loaded rows.
   */
  row = (key: string): ObservableSnapshot<InspectorRecord | undefined> | undefined => this.sources.get(key)

  private refresh(force = false): void {
    const snapshot = this.binding.snapshot.getSnapshot()
    const chat = snapshot.views.get('chat')
    const grouped = snapshot.views.grouped('chat')
    const nodes = chat?.nodes.values()
    const sameKeys = nodes === undefined ? this.keys === undefined
      : nodes.length === this.keys?.length && nodes.every((node, index) => node.key === this.keys?.[index]
        && node.anchorSeq === this.anchors?.[index])
    if (!force && chat?.order === this.order && chat?.nodes === this.nodeStore
      && sameKeys && grouped === this.grouped && grouped?.entries === this.entries) return
    this.order = chat?.order
    this.entries = grouped?.entries
    this.keys = nodes?.map(node => node.key)
    this.anchors = nodes?.map(node => node.anchorSeq)
    if (grouped !== this.grouped) {
      for (const stop of this.groups.values()) stop()
      this.groups.clear()
      this.sources.clear()
    }
    this.grouped = grouped
    if (chat?.nodes !== this.nodeStore) this.sources.clear()
    this.nodeStore = chat?.nodes
    const activeGroups = new Set<GroupKey>()
    this.targets.clear()
    const rows: InspectorRow[] = []
    const addNode = (entry: { readonly key: string; readonly groupPart?: NodeReference['groupPart'] }, parent?: string): void => {
      const key = `node:${entry.key}:${entry.groupPart ?? ''}`
      const location = chat?.nodes.get(entry.key)?.location
      const turn = location?.kind === 'turn' || location?.kind === 'step' ? location.turn.turn : undefined
      const step = location?.kind === 'step' ? location.step.step : undefined
      this.targets.set(key, { nodeKey: entry.key, ...entry.groupPart === undefined ? {} : { groupPart: entry.groupPart },
        ...turn === undefined ? {} : { turn }, ...step === undefined ? {} : { step } })
      rows.push({ key, depth: parent === undefined ? 0 : 1, ...(parent === undefined ? {} : { parent }) })
      if (!this.sources.has(key) && chat !== undefined) {
        this.sources.set(key, new InspectorRecordSource(chat.nodes.source(entry.key), (node) => {
          const record = nodeRecord(node)
          return entry.groupPart === undefined ? record : { ...record, identity: `${node.key}#${entry.groupPart}` }
        }))
      }
    }
    const entries = grouped?.entries ?? chat?.order.map(key => ({ kind: 'node' as const, key })) ?? []
    const included = new Set<string>()
    const entryAnchors = entries.map((entry) => {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- Group entries exist only when grouped is present.
      const members = entry.kind === 'node' ? [entry] : grouped!.groupSource(entry.key).getSnapshot()?.members ?? []
      let anchor: number | undefined
      for (const member of members) {
        included.add(member.key)
        const seq = chat?.nodes.get(member.key)?.anchorSeq
        if (seq !== undefined) anchor = anchor === undefined ? seq : Math.min(anchor, seq)
      }
      return anchor
    })
    const unlisted = (nodes ?? []).filter(node => !included.has(node.key))
      .sort((left, right) => left.anchorSeq - right.anchorSeq || left.key.localeCompare(right.key))
    let nextUnlisted = 0
    const addUnlistedBefore = (anchor: number): void => {
      let node = unlisted[nextUnlisted]
      while (node !== undefined && node.anchorSeq <= anchor) {
        addNode({ key: node.key })
        node = unlisted[++nextUnlisted]
      }
    }
    for (const [index, entry] of entries.entries()) {
      const anchor = entryAnchors[index]
      if (anchor !== undefined) addUnlistedBefore(anchor)
      if (entry.kind === 'node') { addNode(entry); continue }
      activeGroups.add(entry.key)
      const key = `group:${entry.key}`
      this.targets.set(key, { groupKey: entry.key })
      // oxlint-disable-next-line typescript/no-non-null-assertion -- The non-grouped fallback contains only node entries.
      const source = grouped!.groupSource(entry.key)
      const group = source.getSnapshot()
      rows.push({ key, depth: 0 })
      if (!this.sources.has(key)) this.sources.set(key, new InspectorRecordSource(source, (value: GroupSnapshot<unknown>) => ({
        type: 'group', identity: value.key, location: '', value, summary: inspectorPreview(value, COLUMN_FIELDS),
      })))
      for (const member of group?.members ?? []) addNode(member, key)
      if (this.subscribers > 0 && !this.groups.has(entry.key)) {
        let members = group?.members
        const stop = source.subscribe(() => {
          const next = source.getSnapshot()?.members
          if (next === members) return
          members = next
          this.schedule()
        })
        this.groups.set(entry.key, stop)
      }
    }
    addUnlistedBefore(Infinity)
    for (const [key, stop] of this.groups) {
      if (!activeGroups.has(key)) { stop(); this.groups.delete(key) }
    }
    const rowKeys = new Set(rows.map(row => row.key))
    for (const key of this.sources.keys()) if (!rowKeys.has(key)) this.sources.delete(key)
    this.rows.set(rows)
  }

  private schedule(): void {
    if (this.queued) return
    this.queued = true
    queueMicrotask(() => {
      this.queued = false
      if (this.subscribers > 0) this.refresh(true)
    })
  }
}
