/**
 * Generic per-session projection value store (push model; see the
 * session-projection subsystem page, docs/subsystems/session-projection.md):
 * the host is the only computation site; the client holds finished whole
 * values per key in one of two row kinds. A `sequenced` row
 * (`{ value, seq }`) comes from the connected Host — a follow opening
 * baseline, a Session Controller `projection` frame, a list block the Host
 * computed for an attached Session — and merges under **higher seq wins**
 * against other sequenced rows. A `cached` row (`{ value }`) comes from the
 * session list's view of the persisted checkpoint, carries no comparable
 * seq, and yields to every sequenced write. No client-side domain folding
 * exists: a domain ships projection support with zero client code. Per-key
 * bare observable faces feed `useProjection` (ui-renderer binds them).
 */
import type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection/types'
import type { SessionSeqCursor } from '@deepseek-ai/dsh-session/types'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { Notifier } from './notifier.ts'

// The single projection type table, typed end to end (host unit, wire block,
// client store, React hook) — the Service Definition package's pure-type outlet
// (`/types`, zero imports), never the package root: the root's dsh-agent →
// dsh-session chain would drag the host `Context.sessions` merge into the
// client program (one program must not hold both sides). No second
// client-side "views" table (rejected in the Alternatives of
// .agents/notes/proposed/architecture/2026-07-27-session-projection-and-command-log.md).
export type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection/types'

/**
 * The fifth framework hook seat (see the session-projection subsystem page,
 * docs/subsystems/session-projection.md): key-addressed
 * projection reader delivered through the standard kit. `undefined` uniformly
 * means capability absent — host unit unmounted, or no baseline/frame has
 * carried the key yet. The selector overload mirrors useSession (per-key uSES
 * binding; reference stability holds because a key's value reference changes
 * only when a frame or baseline lands).
 */
export type UseProjection = {
  <K extends Extract<keyof SessionProjectionMap, string>>(key: K): SessionProjectionMap[K] | undefined
  <K extends Extract<keyof SessionProjectionMap, string>, S>(
    key: K,
    selector: (value: SessionProjectionMap[K] | undefined) => S,
    eq?: (a: S, b: S) => boolean,
  ): S
}

/**
 * Follow-opening projection baseline, restated here so the
 * React-free store depends only on the type table, not the wire package's
 * response vocabulary.
 */
export interface ProjectionsBaseline {
  /** The consistent-cut seq (equals the window tail seq by construction). */
  asOfSeq: SessionSeqCursor
  /** Whole current values by key; a registered key absent here means the capability is absent. */
  values: Readonly<Record<string, unknown>>
}

/**
 * One key's row. A `sequenced` row was computed by the Host for this Session
 * within the current connection generation and carries the seq it is
 * consistent with; seqs of sequenced rows are comparable with each other. A
 * `cached` row was viewed from the persisted projection checkpoint by a
 * header-only listing without a Session: its origin cannot vouch that its
 * stored seq is comparable with the log the client later opens, so it carries
 * none and yields to every sequenced write.
 */
type Row =
  | { kind: 'cached'; value: unknown }
  | { kind: 'sequenced'; value: unknown; seq: SessionSeqCursor }

/** Per-key notification channel: the bare face plus its batching notifier. */
interface Channel {
  face: ObservableSnapshot<unknown>
  notifier: Notifier
}

/**
 * One session's projection values. Framework semantics, uniform across every
 * key. Sequenced writes (a baseline seeds rows at its cut, a push frame
 * updates one row) compare seqs among themselves: a lower-or-equal seq within
 * the Host generation loses, so a replayed frame cannot regress a value and a
 * stale baseline cannot overwrite a newer frame. Cached writes (the session
 * list's zero-I/O block) only fill keys no sequenced row holds, and a baseline
 * discards every cached row before it seeds, regardless of seq: the connected
 * Session is the truth and a cached value never outranks it. A key the store
 * has never seen reads `undefined` (capability absent). Faces are identity-stable
 * per key (create-on-demand, cached) so the React side binds each exactly
 * once; the store-level channel (`subscribeAny`) serves coarse consumers (the
 * manager's list projection reads the `title` key).
 */
export class ProjectionValueStore {
  private readonly rows = new Map<string, Row>()
  private readonly channels = new Map<string, Channel>()
  private valuesCache: Readonly<Partial<SessionProjectionMap>> | undefined
  /** Coarse any-key channel (no snapshot cache to rebuild: reads hit rows directly). */
  private readonly anyNotifier = new Notifier(() => {})

  /**
   * Key-addressed bare observable face (the useProjection resolution path).
   * Always defined — absence is an `undefined` snapshot, never a missing
   * face, so a component may subscribe before the key ever carries a value.
   * @param key - projection key.
   * @returns the identity-stable face for this key.
   */
  faceOf(key: string): ObservableSnapshot<unknown> {
    return this.channel(key).face
  }

  /**
   * Current whole value for a key (erased framework read; typed reads go
   * through `useProjection`'s map lookup).
   * @param key - projection key.
   * @returns the value, or undefined while the key is absent.
   */
  get(key: string): unknown {
    return this.rows.get(key)?.value
  }

  /**
   * Read the accepted Host watermark without subscribing or copying a value.
   * @param key - projection key.
   * @returns the current sequence, or undefined for absent and cached values.
   */
  seqOf(key: string): SessionSeqCursor | undefined {
    const row = this.rows.get(key)
    return row?.kind === 'sequenced' ? row.seq : undefined
  }

  /**
   * Read every current projection value as one reference-stable snapshot.
   * @returns The same frozen value map until a row changes.
   */
  values(): Readonly<Partial<SessionProjectionMap>> {
    if (this.valuesCache === undefined) {
      this.valuesCache = Object.freeze(Object.fromEntries(
        [...this.rows].map(([key, row]) => [key, row.value]),
      ))
    }
    return this.valuesCache
  }

  /**
   * Subscribe to any-key changes (microtask-batched) — the manager's list
   * rebuild channel.
   * @param listener - change callback.
   * @returns the unsubscribe function.
   */
  subscribeAny(listener: () => void): () => void {
    return this.anyNotifier.subscribe(listener)
  }

  /**
   * Apply one finished value from the Session control stream.
   * @param key - projection key.
   * @param value - whole value computed by the host unit.
   * @param seq - the unit's watermark at emission.
   */
  apply(key: string, value: unknown, seq: SessionSeqCursor): void {
    const row = this.rows.get(key)
    // higher seq wins among sequenced rows; replays and stale frames drop. A
    // cached row has no comparable seq and always yields.
    if (row?.kind === 'sequenced' && seq <= row.seq) return
    this.rows.set(key, { kind: 'sequenced', value, seq })
    this.changed(key)
  }

  /**
   * Fill keys from a session-list block the Host labeled `cached`: a zero-I/O
   * view of the persisted checkpoint. A cached value lands only where no
   * sequenced row exists: a connected Session has already answered for such
   * a key, and the list's view of the persisted checkpoint cannot be newer
   * than it.
   * @param values - whole values by key viewed from the persisted checkpoint.
   */
  applyCached(values: Readonly<Record<string, unknown>>): void {
    for (const key of Object.keys(values)) {
      if (this.rows.get(key)?.kind === 'sequenced') continue
      this.rows.set(key, { kind: 'cached', value: values[key] })
      this.changed(key)
    }
  }

  /**
   * Seed from a history tail page's projections block. Every cached row is
   * discarded first, regardless of seq: the block comes from the connected
   * Session, and a value viewed from the persisted checkpoint never outranks
   * it. Then every carried key lands under the same seq rule as frames, and a
   * key the block omits is capability-absent as of the cut — its row clears
   * unless a newer frame already superseded the cut (a stale baseline can
   * neither overwrite nor clear newer sequenced values).
   * @param baseline - the response's projections block.
   */
  seed(baseline: ProjectionsBaseline): void {
    for (const [key, row] of this.rows) {
      if (row.kind !== 'cached') continue
      this.rows.delete(key)
      this.changed(key)
    }
    // Erased walk: the framework crosses the open key space; per-key typing
    // is re-established at the consumer (useProjection's map lookup).
    const values = baseline.values as Record<string, unknown>
    for (const key of Object.keys(values)) this.apply(key, values[key], baseline.asOfSeq)
    for (const [key, row] of this.rows) {
      if (Object.hasOwn(values, key)) continue
      // Every cached row was deleted above; the kind test only narrows the
      // type so `row.seq` is readable.
      if (row.kind === 'sequenced' && row.seq > baseline.asOfSeq) continue
      this.rows.delete(key)
      this.changed(key)
    }
  }

  /** Discard one Host generation's values and watermarks while preserving subscribed faces. */
  clear(): void {
    for (const key of this.rows.keys()) {
      this.rows.delete(key)
      this.changed(key)
    }
  }

  private changed(key: string): void {
    this.valuesCache = undefined
    this.channels.get(key)?.notifier.markDirty()
    this.anyNotifier.markDirty()
  }

  private channel(key: string): Channel {
    let channel = this.channels.get(key)
    if (channel === undefined) {
      // The notifier only batches (no snapshot cache to rebuild: faces read rows directly).
      const notifier = new Notifier(() => {})
      channel = {
        notifier,
        face: {
          getSnapshot: () => this.rows.get(key)?.value,
          subscribe: listener => notifier.subscribe(listener),
        },
      }
      this.channels.set(key, channel)
    }
    return channel
  }
}
