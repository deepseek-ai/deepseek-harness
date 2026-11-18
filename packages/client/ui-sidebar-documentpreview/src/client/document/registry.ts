/** File-extension and media-type preview registrations; component dispatch belongs to the keyed document slot. */
import { notifySubscribers } from '@deepseek-ai/dsh-client-store'
import { documentFileName, matchedSuffixLength, normalizeSuffix } from './suffix.ts'

/** Shared text or byte reads, or content loading owned by the renderer. */
export type DocumentLoadMode = 'text-pages' | 'bytes-complete' | 'renderer'

/** One renderer implementation, independent of its component registration. */
export interface DocumentPreviewDefinition {
  /** Unique implementation name, also used as the document slot key. */
  readonly id: string
  /** File suffixes without a leading dot; compound suffixes such as tar.gz are accepted. */
  readonly extensions: readonly string[]
  /**
   * Media types this implementation accepts from a content source that is not
   * a file, such as `text/markdown`; file previews select by `extensions` only.
   * Matching ignores case and parameters. `register` rejects a definition that
   * declares media types with `loading: 'renderer'`, whose implementation reads
   * a file itself.
   */
  readonly mediaTypes?: readonly string[]
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
  /**
   * Whether a `text-pages` body exposes source-line anchors for line navigation;
   * without it, a navigation to a line is answered without moving the body.
   */
  readonly sourceLines?: boolean
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
 * Normalize a media type for comparison.
 * @param mediaType - media type, optionally with parameters such as `; charset=utf-8`.
 * @returns the essence before any `;`, trimmed and lowercased.
 */
function mediaTypeEssence(mediaType: string): string {
  const parameters = mediaType.indexOf(';')
  return (parameters === -1 ? mediaType : mediaType.slice(0, parameters)).trim().toLowerCase()
}

/**
 * Rank an observed definition snapshot by declared media type.
 * @param definitions - registered implementations in registration order.
 * @param mediaType - content media type; parameters and case are ignored.
 * @returns implementations declaring the type, external band first, then registration order.
 */
export function matchingMediaTypePreviews(
  definitions: readonly DocumentPreviewDefinition[],
  mediaType: string,
): readonly DocumentPreviewDefinition[] {
  const essence = mediaTypeEssence(mediaType)
  const matched = definitions.filter(definition => (definition.mediaTypes ?? []).some(declared => mediaTypeEssence(declared) === essence))
  return [
    ...matched.filter(definition => definition.priority !== 'builtin'),
    ...matched.filter(definition => definition.priority === 'builtin'),
  ]
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
   * `binaryExtensions` entry must appear in `extensions`, and `mediaTypes`
   * require a loading mode other than `renderer`.
   * @returns an idempotent disposer; duplicate live implementation names,
   * binary suffixes outside `extensions`, and media types on a `renderer`
   * implementation throw.
   */
  register(definition: DocumentPreviewDefinition): () => void {
    if (this.registered.has(definition.id)) {
      throw new Error(`documentPreviews: duplicate implementation "${definition.id}"`)
    }
    if (definition.mediaTypes !== undefined && definition.loading === 'renderer') {
      throw new Error(`documentPreviews: "${definition.id}" declares media types but loads its own file content`)
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

  /**
   * List every implementation accepting a media type in automatic-selection order.
   * @param mediaType - content media type; parameters after `;` and case are ignored.
   * @returns extension band first, then builtin, each in registration order.
   */
  mediaTypeCandidates(mediaType: string): readonly DocumentPreviewDefinition[] {
    return matchingMediaTypePreviews(this.snapshot, mediaType)
  }

  private publish(): void {
    this.snapshot = [...this.registered.values()]
    notifySubscribers(this.listeners, '[document-previews] registry')
  }
}
