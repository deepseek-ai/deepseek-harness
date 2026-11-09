/**
 * The subset of LSP wire types this generic host reads and writes: initialize capabilities, the four
 * request results (`Location`, `LocationLink`, `Hover`), and the `textDocumentSync` shapes used to
 * decide transient-open support. Types only. Fields absent from a real server payload stay optional;
 * the translation layer normalizes them into the seam's closed unions.
 * @module @deepseek-ai/dsh-lsp-stdio/protocol
 */

/** A zero-based UTF-16 position on the wire (the protocol's `Position`). */
export interface WirePosition {
  readonly line: number
  readonly character: number
}

/** A wire range (`Range`). */
export interface WireRange {
  readonly start: WirePosition
  readonly end: WirePosition
}

/** A `Location`: a document URI plus a range. */
export interface WireLocation {
  readonly uri: string
  readonly range: WireRange
}

/** A `LocationLink`: the target uri plus the selection range to focus. */
export interface WireLocationLink {
  readonly targetUri: string
  readonly targetSelectionRange: WireRange
  readonly targetRange?: WireRange
}

/** A `MarkupContent` hover body (`markdown` or `plaintext`). */
export interface WireMarkupContent {
  readonly kind: 'markdown' | 'plaintext'
  readonly value: string
}

/** A `MarkedString` object form (`{ language, value }`); the string form is a bare `string`. */
export interface WireMarkedStringObject {
  readonly language: string
  readonly value: string
}

/** One `MarkedString`: a raw string or a language-tagged code block. */
export type WireMarkedString = string | WireMarkedStringObject

/** A `Hover`: contents in any of the protocol's three encodings, plus an optional range. */
export interface WireHover {
  readonly contents: WireMarkupContent | WireMarkedString | readonly WireMarkedString[]
  readonly range?: WireRange
}

/** The legacy enum form of `textDocumentSync` (`0` None, `1` Full, `2` Incremental). */
export type WireTextDocumentSyncKind = 0 | 1 | 2

/** The options form of `textDocumentSync` (`{ openClose, change }`). */
export interface WireTextDocumentSyncOptions {
  readonly openClose?: boolean
  readonly change?: WireTextDocumentSyncKind
}

/** A `ServerCapabilities.provider` slot: a boolean or an options object (both mean "supported"). */
export type WireProviderCapability = boolean | Record<string, unknown> | undefined

/** The `ServerCapabilities` fields this host inspects. */
export interface WireServerCapabilities {
  readonly positionEncoding?: string
  readonly textDocumentSync?: WireTextDocumentSyncKind | WireTextDocumentSyncOptions
  readonly definitionProvider?: WireProviderCapability
  readonly referencesProvider?: WireProviderCapability
  readonly implementationProvider?: WireProviderCapability
  readonly hoverProvider?: WireProviderCapability
}
