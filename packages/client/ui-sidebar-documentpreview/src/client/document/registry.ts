/** File-extension preview registrations; component dispatch belongs to the keyed document slot. */
import { notifySubscribers } from '@deepseek-ai/dsh-client-store'
import { documentFileName, matchedSuffixLength, normalizeSuffix } from './suffix.ts'

/** How the document owner delivers file contents to a renderer. */
export type DocumentLoadMode = 'text-pages' | 'bytes-complete'

/** One renderer implementation, independent of its component registration. */
export interface DocumentPreviewDefinition {
  /** Unique implementation name, also used as the document slot key. */
  readonly id: string
  /** File suffixes without a leading dot; compound suffixes such as tar.gz are accepted. */
  readonly extensions: readonly string[]
  /**
   * Suffixes among `extensions` whose bytes are not readable text; a file
   * matching one loses the plain-text fallback among its viewer choices.
   * Every entry must appear in `extensions`; `register` rejects strays.
   */
  readonly binaryExtensions?: readonly string[]
  /** External implementations win over product implementations; defaults to extension. */
  readonly priority?: 'builtin' | 'extension'
  /** Localized implementation label, evaluated when the toolbar renders. @returns the visible name. */
  readonly title: () => string
  /** Content delivery mode supplied by the document owner. */
  readonly loading: DocumentLoadMode
  /** Whether the implementation consumes the document's wrap preference. */
  readonly wrap?: boolean
}

/**
 * Rank an observed definition snapshot without consulting mutable service state.
 * @param definitions - registered implementations in registration order.
 * @param path - decoded filename or file path.
 * @returns matching implementations, external band first, then longest suffix.
 */
export function matchingDocumentPreviews(
  definitions: readonly DocumentPreviewDefinition[],
  path: string,
): readonly DocumentPreviewDefinition[] {
  const name = documentFileName(path)
  return definitions.map((definition, order) => ({
    definition, order,
    rank: definition.priority === 'builtin' ? 0 : 1,
    length: matchedSuffixLength(name, definition.extensions),
  }))
    .filter(candidate => candidate.length > 0)
    .sort((left, right) => right.rank - left.rank || right.length - left.length || left.order - right.order)
    .map(candidate => candidate.definition)
}

/**
 * Whether any registered implementation declares the filename's suffix binary.
 * @param definitions - registered implementations.
 * @param path - decoded filename or file path.
 * @returns true when a declared binary suffix matches the filename.
 */
export function binaryDocumentPath(
  definitions: readonly DocumentPreviewDefinition[],
  path: string,
): boolean {
  const name = documentFileName(path)
  return definitions.some(definition => matchedSuffixLength(name, definition.binaryExtensions ?? []) > 0)
}

/** Observable registry of all live implementations, including lower-priority alternatives. */
export class DocumentPreviewRegistry {
  private readonly registered = new Map<string, DocumentPreviewDefinition>()
  private readonly listeners = new Set<() => void>()
  private snapshot: readonly DocumentPreviewDefinition[] = []

  /**
   * Read the current registrations.
   * @returns the same snapshot until a registration changes.
   */
  readonly getSnapshot = (): readonly DocumentPreviewDefinition[] => this.snapshot

  /**
   * Observe registration changes.
   * @param listener - registration-change observer.
   * @returns its disposer.
   */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Register metadata separately from the matching keyed slot component.
   * @param definition - unique implementation and recognized suffixes; every
   * `binaryExtensions` entry must appear in `extensions`.
   * @returns an idempotent disposer; duplicate live implementation names and
   * binary suffixes outside `extensions` throw.
   */
  register(definition: DocumentPreviewDefinition): () => void {
    if (this.registered.has(definition.id)) {
      throw new Error(`documentPreviews: duplicate implementation "${definition.id}"`)
    }
    const declared = new Set(definition.extensions.map(normalizeSuffix))
    for (const extension of definition.binaryExtensions ?? []) {
      if (!declared.has(normalizeSuffix(extension))) {
        throw new Error(`documentPreviews: "${definition.id}" declares binary suffix "${extension}" outside its extensions`)
      }
    }
    this.registered.set(definition.id, definition)
    this.publish()
    let active = true
    return () => {
      if (!active) return
      active = false
      this.registered.delete(definition.id)
      this.publish()
    }
  }

  /**
   * List every matching implementation in automatic-selection order.
   * @param path - decoded file path; matching never resolves filesystem access.
   * @returns extension band first, then longest suffix, then registration order.
   */
  candidates(path: string): readonly DocumentPreviewDefinition[] {
    return matchingDocumentPreviews(this.snapshot, path)
  }

  private publish(): void {
    this.snapshot = [...this.registered.values()]
    notifySubscribers(this.listeners, '[document-previews] registry')
  }
}
