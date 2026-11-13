/**
 * The changes view's face for other Client plugins, which the forge panel provides as `ctx.forgeChanges`: the
 * changes tab's addresses and kinds, opening a view, the titles of Host lenses, and line annotation sources.
 */

import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ForgeExtensionState, ForgeLensId } from '../types.ts'
import { changesAddress, parseChangesAddress, type ChangesParams, type ChangesTarget } from './changes-address.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The changes view's face for other Client plugins. */
    forgeChanges: ForgeChangesService
  }
}

/** The title of a filter lens a Host plugin registers, which a Client plugin describes. */
export interface ForgeLensDescription {
  /** Identity of the Host lens. */
  readonly id: ForgeLensId
  /** Title in the current language, read whenever the view draws. */
  readonly title: () => string
  /** Position among the lenses, lower first; equal positions keep registration order. Default 0. */
  readonly order?: number
}

/** Where one line annotation sits in a file of a changes view. */
export interface ForgeLineAnnotation {
  /** Identity within its source, stable across updates; it keys the drawn entry. */
  readonly key: string
  /** Inclusive 1-based lines on the old (`L`) or new (`R`) side, or `file` for the whole file. */
  readonly place: { readonly side: 'L' | 'R'; readonly startLine: number; readonly endLine: number } | 'file'
  /** Digest of the file change it was written on; a file whose `digest` differs shows it in its outdated section. */
  readonly digest?: string
  /** Changes whenever the entry should draw again; equal keys and versions keep the drawn entry's props. */
  readonly version: string | number
}

/** A Client plugin's line annotations, drawn through its `forge.diff.line.annotation` entry. */
export interface ForgeAnnotationSource {
  /** Unique source identity, also the key of its `forge.diff.line.annotation` entry. */
  readonly id: string
  /** Position among sources in one stack, lower first; equal positions keep registration order. Default 0. */
  readonly order?: number
  /**
   * Observe the annotations of one view, by path. The changes view calls it once per view and source registration;
   * the source republishes through the same observable whenever the annotations change.
   * @param target - the view's Session and source.
   * @returns annotations by repository-relative path.
   */
  observe(target: ChangesTarget): HostObservable<ReadonlyMap<string, readonly ForgeLineAnnotation[]>>
}

/** What the service needs from the right sidebar. */
export interface ForgeChangesSidebar {
  /** Session whose sidebar shows, or undefined without one. */
  readonly mounted: () => SessionId | undefined
  /** Open a resource address in the shown Session's sidebar. */
  readonly openResource: (address: string, params: ChangesParams | undefined) => void
}

/** The position of an ordered entry, 0 without an `order`. */
function positionOf(entry: { readonly order?: number }): number {
  return entry.order ?? 0
}

/** Entries kept by identity in registration order, published sorted by `order`. */
class OrderedEntries<T extends { readonly id: string; readonly order?: number }> implements HostObservable<readonly T[]> {
  private entries: readonly T[] = []
  private readonly listeners = new Set<() => void>()

  constructor(private readonly what: string) {}

  readonly getSnapshot = (): readonly T[] => this.entries

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  add(entry: T): () => void {
    if (this.entries.some(item => item.id === entry.id)) throw new Error(`forge-panel: a ${this.what} "${entry.id}" is already registered`)
    // A stable sort keeps registration order among equal positions.
    this.publish([...this.entries, entry].sort((a, b) => positionOf(a) - positionOf(b)))
    return () => { this.publish(this.entries.filter(item => item !== entry)) }
  }

  private publish(next: readonly T[]): void {
    if (next.length === this.entries.length && next.every((item, index) => item === this.entries[index])) return
    this.entries = next
    for (const listener of [...this.listeners]) listener()
  }
}

/**
 * The changes view's face for other Client plugins. Registrations return their disposer, which the registering plugin
 * holds in its own `ctx.effect` so a registration lives exactly as long as that plugin.
 */
export class ForgeChangesService {
  /** Titles of Host lenses in display order. */
  readonly lenses: HostObservable<readonly ForgeLensDescription[]>
  /** Annotation sources in stacking order. */
  readonly annotationSources: HostObservable<readonly ForgeAnnotationSource[]>
  private readonly lensEntries = new OrderedEntries<ForgeLensDescription>('lens description')
  private readonly sourceEntries = new OrderedEntries<ForgeAnnotationSource>('annotation source')

  /**
   * @param sidebar - the right sidebar's open path.
   * @param extensions - the Host's registered lenses and annotation limit, or null before the Host reports them.
   * @param kinds - tab kinds of the changes view and the change request panel.
   */
  constructor(
    private readonly sidebar: ForgeChangesSidebar,
    readonly extensions: HostObservable<ForgeExtensionState | null>,
    readonly kinds: { readonly changes: string; readonly panel: string },
  ) {
    this.lenses = this.lensEntries
    this.annotationSources = this.sourceEntries
  }

  /**
   * Mint the address of a changes view.
   * @param target - Session and source.
   * @returns the `dsh-resource://forge-changes/…` address.
   */
  address(target: ChangesTarget): string {
    return changesAddress(target)
  }

  /**
   * Read the Session and source back out of a changes address.
   * @param address - a resource address.
   * @returns the target, or undefined for an address the forge panel did not mint.
   */
  parse(address: string): ChangesTarget | undefined {
    return parseChangesAddress(address)
  }

  /**
   * Open or reveal a changes view in the shown Session's right sidebar, scrolled to `params.path` with the lens
   * `params.lens` chosen.
   * @param target - Session and source; the Session must be the one the sidebar shows.
   * @param params - file to scroll to and lens to choose.
   * @throws when `target.sessionId` is not the Session the sidebar shows.
   */
  open(target: ChangesTarget, params?: ChangesParams): void {
    if (this.sidebar.mounted() !== target.sessionId) {
      throw new Error(`forge-panel: Session ${target.sessionId} is not the Session the sidebar shows`)
    }
    this.sidebar.openResource(changesAddress(target), params)
  }

  /**
   * Describe the title of a Host lens. A lens the Host registers without a description shows its identity.
   * @param description - the lens identity, title, and position.
   * @returns the disposer that withdraws the description.
   * @throws when another description holds the identity.
   */
  describeLens(description: ForgeLensDescription): () => void {
    return this.lensEntries.add(description)
  }

  /**
   * Register a line annotation source; its `forge.diff.line.annotation` entry, keyed by `source.id`, draws each one.
   * @param source - the source.
   * @returns the disposer that withdraws the source and its annotations.
   * @throws when another source holds the identity.
   */
  registerAnnotations(source: ForgeAnnotationSource): () => void {
    return this.sourceEntries.add(source)
  }
}
