/** Keyed group publication and incremental validation of rendering positions. */
import { createSnapshotStore, type ObservableSnapshot, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { ConversationViewNode } from '../contract/conversation.ts'
import type {
  ConversationGroupedView, GroupKey, GroupSnapshot, GroupUpdate, NodeKey, NodeReference, RenderEntry,
} from '../contract/groups.ts'

type Parts = Set<string | undefined>

interface GroupSource<Data> {
  readonly observable: ObservableSnapshot<GroupSnapshot<Data> | undefined>
  readonly publication: SnapshotStore<GroupSnapshot<Data> | undefined>
}

interface GroupChanges<Data> {
  readonly upserts: Map<GroupKey, GroupSnapshot<Data>>
  readonly removes: Set<GroupKey>
}

function sameNodeReference(left: NodeReference, right: NodeReference): boolean {
  return left.key === right.key && left.groupPart === right.groupPart
}

function sameEntry(left: RenderEntry, right: RenderEntry): boolean {
  return left.kind === right.kind && left.key === right.key
    && (left.kind === 'group' || (right.kind === 'node' && left.groupPart === right.groupPart))
}

function reuseReferences<Value>(
  previous: readonly Value[],
  next: readonly Value[],
  equal: (left: Value, right: Value) => boolean,
): readonly Value[] {
  return previous === next || (previous.length === next.length
    && previous.every((value, index) => equal(value, next[index] as Value)))
    ? previous
    : next
}

/** Validates a complete batch before installing its group and root-list changes. */
export class ConversationGroupStore<Data> implements ConversationGroupedView<Data> {
  private root: readonly RenderEntry[] = []
  private rootGroups = new Set<GroupKey>()
  private readonly groups = new Map<GroupKey, GroupSnapshot<Data>>()
  private readonly placements = new Map<NodeKey, Parts>()
  private readonly sources = new Map<GroupKey, GroupSource<Data>>()
  private readonly dirty = new Set<GroupKey>()

  /** @returns the identity-stable ordered root references. */
  get entries(): readonly RenderEntry[] {
    return this.root
  }

  groupSource(key: GroupKey): ObservableSnapshot<GroupSnapshot<Data> | undefined> {
    let source = this.sources.get(key)
    if (source === undefined) {
      const publication = createSnapshotStore(this.groups.get(key))
      source = {
        publication,
        observable: {
          getSnapshot: () => this.groups.get(key),
          subscribe: listener => publication.subscribe(listener),
        },
      }
      this.sources.set(key, source)
    }
    return source.observable
  }

  /**
   * Install one validated update without notifying readers.
   * @param update - root replacement and complete or incremental group records.
   * @param readNode - synchronous reader of the current target Nodes.
   */
  prepareAndInstall(
    update: GroupUpdate<Data>,
    readNode: (key: NodeKey) => ConversationViewNode | undefined,
  ): void {
    const nextRoot = update.entries === undefined
      ? this.root
      : reuseReferences(this.root, update.entries, sameEntry)
    const nextRootGroups = nextRoot === this.root ? this.rootGroups : this.collectRootGroups(nextRoot)
    const { upserts, removes } = this.collectChanges(update)
    const replaceReferences = update.groups.kind === 'replace'
    const size = this.groups.size - removes.size
      + [...upserts.keys()].filter(key => !this.groups.has(key)).length
    if (size !== nextRootGroups.size) {
      throw new Error('conversation group records and root references must correspond one-to-one')
    }
    for (const key of removes) {
      if (nextRootGroups.has(key)) throw new Error(`conversation group "${key}" is still referenced`)
    }
    for (const key of upserts.keys()) {
      if (!nextRootGroups.has(key)) throw new Error(`conversation group "${key}" has no root reference`)
    }
    if (nextRootGroups !== this.rootGroups) {
      for (const key of nextRootGroups) {
        if (!upserts.has(key) && !this.groups.has(key)) {
          throw new Error(`conversation root references missing group "${key}"`)
        }
      }
    }

    const affectedParts = new Map<NodeKey, Parts>()
    const partsOf = (key: NodeKey): Parts => {
      let parts = affectedParts.get(key)
      if (parts === undefined) {
        parts = new Set(this.placements.get(key))
        affectedParts.set(key, parts)
      }
      return parts
    }
    const removeReference = (reference: NodeReference): void => {
      partsOf(reference.key).delete(reference.groupPart)
    }
    const addReference = (reference: NodeReference): void => {
      if (readNode(reference.key) === undefined) {
        throw new Error(`conversation group references missing Node "${reference.key}"`)
      }
      const parts = partsOf(reference.key)
      if (parts.has(reference.groupPart)
        || (reference.groupPart === undefined && parts.size > 0)
        || parts.has(undefined)) {
        throw new Error(`conversation Node "${reference.key}" has overlapping rendering positions`)
      }
      parts.add(reference.groupPart)
    }

    if (replaceReferences || nextRoot !== this.root) {
      for (const entry of this.root) if (entry.kind === 'node') removeReference(entry)
    }
    for (const key of removes) {
      for (const member of (this.groups.get(key) as GroupSnapshot<Data>).members) removeReference(member)
    }
    for (const [key, next] of upserts) {
      const previous = this.groups.get(key)
      if (previous !== undefined && (replaceReferences || previous.members !== next.members)) {
        for (const member of previous.members) removeReference(member)
      }
    }
    if (replaceReferences || nextRoot !== this.root) {
      for (const entry of nextRoot) if (entry.kind === 'node') addReference(entry)
    }
    for (const [key, next] of upserts) {
      if (replaceReferences || this.groups.get(key)?.members !== next.members) {
        for (const member of next.members) addReference(member)
      }
    }

    for (const [key, parts] of affectedParts) {
      if (parts.size === 0) this.placements.delete(key)
      else this.placements.set(key, parts)
    }
    for (const key of removes) {
      this.groups.delete(key)
      this.dirty.add(key)
    }
    for (const [key, next] of upserts) {
      if (this.groups.get(key) === next) continue
      this.groups.set(key, next)
      this.dirty.add(key)
    }
    this.root = nextRoot
    this.rootGroups = nextRootGroups
  }

  /** Publish changed group sources after all related target data has been installed. */
  publish(): void {
    const keys = [...this.dirty]
    this.dirty.clear()
    for (const key of keys) this.sources.get(key)?.publication.set(this.groups.get(key))
  }

  /** Remove grouping without deleting its source Nodes; publication remains deferred. */
  clear(): void {
    this.prepareAndInstall(
      { entries: [], groups: { kind: 'replace', snapshots: [] } },
      /* v8 ignore next -- an empty replacement never reads a Node reference. */
      () => undefined,
    )
  }

  private collectRootGroups(entries: readonly RenderEntry[]): Set<GroupKey> {
    const keys = new Set<GroupKey>()
    for (const entry of entries) {
      if (entry.kind !== 'group') continue
      if (keys.has(entry.key)) throw new Error(`conversation group "${entry.key}" has duplicate root references`)
      keys.add(entry.key)
    }
    return keys
  }

  private collectChanges(update: GroupUpdate<Data>): GroupChanges<Data> {
    const upserts = new Map<GroupKey, GroupSnapshot<Data>>()
    const removes = new Set<GroupKey>()
    const add = (snapshot: GroupSnapshot<Data>): void => {
      if (upserts.has(snapshot.key)) throw new Error(`conversation group "${snapshot.key}" has duplicate upserts`)
      const previous = this.groups.get(snapshot.key)
      if (previous === undefined) {
        upserts.set(snapshot.key, snapshot)
        return
      }
      const members = reuseReferences(previous.members, snapshot.members, sameNodeReference)
      upserts.set(snapshot.key, previous.data === snapshot.data && previous.members === members
        ? previous
        : { ...snapshot, members })
    }
    switch (update.groups.kind) {
      case 'replace':
        for (const snapshot of update.groups.snapshots) add(snapshot)
        for (const key of this.groups.keys()) if (!upserts.has(key)) removes.add(key)
        break
      case 'apply':
        for (const snapshot of update.groups.upserts) add(snapshot)
        for (const key of update.groups.removes) {
          if (removes.has(key)) throw new Error(`conversation group "${key}" has duplicate removals`)
          if (!this.groups.has(key)) throw new Error(`conversation group "${key}" cannot be removed because it is absent`)
          if (upserts.has(key)) throw new Error(`conversation group "${key}" cannot be upserted and removed together`)
          removes.add(key)
        }
        break
      /* v8 ignore next 2 -- closed update union; TypeScript rejects other operation tags. */
      default:
        assertNever(update.groups)
    }
    return { upserts, removes }
  }
}
