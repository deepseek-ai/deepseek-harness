/**
 * Line annotations of one changes view: every source's annotations merged by path, and where each one shows in a
 * file's lines.
 */

import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChangesTarget } from './changes-address.ts'
import type { ForgeAnnotationSource, ForgeLineAnnotation } from './changes-service.ts'

/** One annotation with the source that draws it. */
export interface SourcedAnnotation {
  /** Identity of the source, the key of its `forge.diff.line.annotation` entry. */
  readonly source: string
  readonly annotation: ForgeLineAnnotation
}

/** Annotations of one view by path, in source order and then each source's order. */
export type ViewAnnotations = ReadonlyMap<string, readonly SourcedAnnotation[]>

const EMPTY: ViewAnnotations = new Map()

/** Whether two lists hold the same annotations of the same sources at the same versions in the same order. */
function sameList(a: readonly SourcedAnnotation[], b: readonly SourcedAnnotation[]): boolean {
  return a.length === b.length && a.every((item, index) => {
    const other = b[index]
    return other !== undefined && item.source === other.source && item.annotation.key === other.annotation.key
      && item.annotation.version === other.annotation.version
  })
}

/**
 * The merged annotations of one view. It observes each registered source while a reader subscribes, starting with
 * the first reader and stopping after the last; a file whose annotations did not change keeps its list, so its section
 * does not draw again.
 */
export class AnnotationView implements HostObservable<ViewAnnotations> {
  private snapshot: ViewAnnotations = EMPTY
  private readonly listeners = new Set<() => void>()
  /** The followed sources in stacking order, each with its observable for this view and its unsubscribe. */
  private followed: readonly { readonly source: ForgeAnnotationSource; readonly values: ReturnType<ForgeAnnotationSource['observe']>; readonly stop: () => void }[] = []
  private stopSources: (() => void) | undefined

  /**
   * @param sources - the registered sources.
   * @param target - the view's Session and source.
   */
  constructor(private readonly sources: HostObservable<readonly ForgeAnnotationSource[]>, private readonly target: ChangesTarget) {}

  readonly getSnapshot = (): ViewAnnotations => this.snapshot

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    if (this.listeners.size === 1) {
      this.stopSources = this.sources.subscribe(() => { this.sync() })
      this.sync()
    }
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size > 0) return
      this.stopSources?.()
      this.stopSources = undefined
      for (const entry of this.followed) entry.stop()
      this.followed = []
    }
  }

  /** Follow the sources registered now, observing each new one once and releasing each withdrawn one, then merge. */
  private sync(): void {
    const next = this.sources.getSnapshot().map(source => this.followed.find(entry => entry.source === source) ?? this.follow(source))
    for (const entry of this.followed) {
      if (!next.includes(entry)) entry.stop()
    }
    this.followed = next
    this.merge()
  }

  private follow(source: ForgeAnnotationSource): (typeof this.followed)[number] {
    const values = source.observe(this.target)
    return { source, values, stop: values.subscribe(() => { this.merge() }) }
  }

  private merge(): void {
    const lists = new Map<string, SourcedAnnotation[]>()
    for (const { source, values } of this.followed) {
      for (const [path, annotations] of values.getSnapshot()) {
        const list = lists.get(path) ?? []
        for (const annotation of annotations) list.push({ source: source.id, annotation })
        if (list.length > 0) lists.set(path, list)
      }
    }
    let changed = lists.size !== this.snapshot.size
    const next = new Map<string, readonly SourcedAnnotation[]>()
    for (const [path, list] of lists) {
      const previous = this.snapshot.get(path)
      if (previous !== undefined && sameList(previous, list)) next.set(path, previous)
      else {
        next.set(path, list)
        changed = true
      }
    }
    if (!changed) return
    this.snapshot = next
    for (const listener of [...this.listeners]) listener()
  }
}
