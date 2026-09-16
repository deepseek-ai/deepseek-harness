/** Editor-facing ranges, reference projections, and the composer keyboard interface. */
import type { LexicalEditor } from 'lexical'
import type { InputState } from './input.ts'
import type { InputSubmitMode } from './composer-submission.ts'

/** Pick-time draft span guarded by the input revision. */
export interface TokenSpan {
  readonly start: number
  readonly end: number
  readonly draftRev: number
}

/** Structured reference inserted by an input-trigger source. */
export interface ReferenceInsert {
  readonly source: string
  readonly ref: string
  readonly label: string
  readonly appearance?: 'session' | 'file' | 'folder'
  readonly clipboardText: string
}

/** Keyboard keys intercepted by an open trigger menu. */
export type ArbitrateKey = 'up' | 'down' | 'enter' | 'escape' | 'tab'

/** Trigger-menu keyboard routing result. */
export type ArbitrateOutcome = 'consumed' | 'pick-highlighted' | 'pass'

/**
 * The InputBar-exclusive keyboard/DOM command face: synchronous
 * returns and event-handler semantics that must not enter the public provide
 * channel. Handed to the composer-bar entry through its own inject —
 * package-internal, never across a plugin boundary. The session shell
 * satisfies it structurally. Text editing itself rides the shell's Lexical
 * editor (exposed here for the contenteditable binding); the members below
 * are the submit-plane and trigger-pipeline verbs the editor does not own.
 */
export interface ComposerKeyboard {
  /** Live machine state for event-handler reads (render reads go through useInput). */
  readonly snapshot: InputState
  /** The shell-owned Lexical editor the composer binds its contenteditable to. */
  readonly editor: LexicalEditor
  /** Submit with an explicit delivery mode resolved by the submission policy (Enter gestures and the primary Send button). */
  submit(mode: InputSubmitMode): void
  /**
   * Steer every still-pending queued message into the running turn (the
   * empty-draft accelerated-Enter gesture; the queue dock's per-row steer
   * button is the same operation applied to the whole queue).
   */
  steerQueue(): void
  /** Insert pasted plain text over the current editor selection (reference-placeholder-sanitized). */
  paste(text: string): void
  /**
   * The live selection as a detect-coordinate span (menu-launcher synthetic
   * hits replace it on pick); an absent selection answers a collapsed span at
   * the document end.
   */
  caretSpan(): EditSelection
  /** Keyboard arbitration while the menu is open ('pass' when no pipeline). */
  arbitrate(key: ArbitrateKey, composing: boolean): ArbitrateOutcome
  /** Space adjudication; true = the input applied a claim — caller preventDefaults. */
  space(): boolean
  /** Dismiss the popupSelect shell (any interaction outside the box). */
  dismissPopup(): void
  /**
   * Bind the mounted composer's file action and live intake availability.
   * @param picker - availability query and native file-dialog opener.
   * @returns the unbind disposer.
   */
  bindFilePicker(picker: { available(): boolean; open(): void }): () => void
}

/** Half-open [start, end) range/selection in detect-projection coordinates. */
export interface EditSelection {
  readonly start: number
  readonly end: number
}

/**
 * One reference occurrence projected from the editor's chip nodes, in
 * clipboard-text coordinates. Identity is occurrenceId — a stable per-shell
 * assignment per chip NodeKey, so same-named references stay independently
 * addressable and survive undo. label/appearance/clipboardText are the
 * owner's insert-time projections cached on the node (invalid flips instead
 * of dropping the occurrence).
 */
export interface Occurrence {
  /** Shell-assigned stable identity (monotonic per shell, keyed by NodeKey). */
  readonly occurrenceId: number
  /** Owning source name (serializer routing key). */
  readonly source: string
  /** Owner-scoped reference id. */
  readonly ref: string
  /** Offset in the clipboard-text projection. */
  readonly offset: number
  /** Length in the clipboard-text projection; the occurrence occupies exactly [offset, offset+length). */
  readonly length: number
  /** Inline display label (insert-time cache). */
  readonly label: string
  /** Optional domain glyph (insert-time cache). */
  readonly appearance?: ReferenceInsert['appearance']
  /** Clipboard / persistence projection, e.g. `/name` (insert-time cache, never the model form). */
  readonly clipboardText: string
  /** Owner-resolution failure flag: the chip renders the failure treatment. */
  readonly invalid?: boolean
}
