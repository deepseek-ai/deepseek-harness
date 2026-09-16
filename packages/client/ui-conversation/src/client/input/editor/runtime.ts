/** The Composer model's private Lexical editor, projections, and node operations. */
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { LexicalEditor, NodeKey } from 'lexical'
import {
  $addUpdateTag, $createParagraphNode, $createTextNode, $getRoot, $getSelection, $isRangeSelection,
  CLEAR_HISTORY_COMMAND, createEditor, HISTORY_MERGE_TAG, PASTE_TAG,
} from 'lexical'
import { registerPlainText } from '@lexical/plain-text'
import { createEmptyHistoryState, registerHistory } from '@lexical/history'
import { mergeRegister } from '@lexical/utils'
import type { Occurrence, ReferenceInsert } from '../../contract/draft-editor.ts'
import { registerReferenceActivation } from './reference-activation.ts'
import { ReferenceChipNode, $createReferenceChipNode } from './chip-node.tsx'
import { refreshClaimDecoration, registerClaimDecoration } from './claim-decor.ts'
import { registerTextRefDecoration, rescanTextRefs, TextRefNode } from './text-ref.ts'
import type { EditorProjection } from './projection.ts'
import { $composerLayout, $projectComposer, detectOffsetOfClipboardOffset } from './projection.ts'
import { $replaceDetectSpanWithNodes, $replaceDetectSpanWithText } from './span-map.ts'
import type { DetectSpan } from './span-map.ts'

type Lexicon = ReadonlyMap<'/' | '@', readonly string[]>

/** Model callbacks read at the same editor registration and update points. */
interface DraftEditorRuntimeDeps {
  readonly onUpdate: () => void
  readonly openReference: (source: string | undefined, reference: Pick<ReferenceInsert, 'ref' | 'appearance'>) => boolean
  readonly activeClaimToken: () => string | null
  readonly lexicon: () => Lexicon
  readonly resolveLexicon: () => ObservableSnapshot<Lexicon> | undefined
}

/**
 * Detect-projection and legacy reference placeholders stripped from every
 * external text entering the document (paste, persisted-draft seed): a chip
 * is the only legitimate source of U+FFFC in the detect projection, so a
 * literal one in text would forge chip positions.
 */
const REFERENCE_PLACEHOLDER_RE = /[\uE100-\uE11D\uFFFC]/gu

/** Undo merge window for contiguous typing, in ms (the old machine's mergeWindowMs). */
const HISTORY_MERGE_DELAY_MS = 1000

/** One model-owned editor; registration and disposal remain with its model. */
export class DraftEditorRuntime {
  /** The editor bound by the Composer's contenteditable host. */
  readonly editor: LexicalEditor
  private projected: EditorProjection = { detectText: '', clipboardText: '', occurrences: [], selection: null, caret: null }
  /** Stable occurrence ids per chip NodeKey (undo restores keys, so ids survive it too). */
  private readonly occurrenceIds = new Map<NodeKey, number>()
  private occurrenceSeq = 0
  /** Live lexicon subscription disposer; undefined until the controller resolves. */
  private lexiconOff: (() => void) | undefined

  /** @param deps - model callbacks used by editor listeners and transforms. */
  constructor(private readonly deps: DraftEditorRuntimeDeps) {
    this.editor = createEditor({
      namespace: 'dsh-composer',
      nodes: [ReferenceChipNode, TextRefNode],
      onError: (error) => { throw error },
    })
  }

  /**
   * Install editor behavior after the model holds this runtime.
   * @returns unregister callback that also detaches the editor root.
   */
  register(): () => void {
    const unregister = mergeRegister(
      registerPlainText(this.editor),
      registerReferenceActivation(this.editor, (source, reference) =>
        this.deps.openReference(source, reference)),
      registerHistory(this.editor, createEmptyHistoryState(), HISTORY_MERGE_DELAY_MS),
      this.editor.registerUpdateListener(() => { this.deps.onUpdate() }),
      registerClaimDecoration(this.editor, () => this.deps.activeClaimToken()),
      registerTextRefDecoration(this.editor, () => this.deps.lexicon(), () => this.deps.activeClaimToken()),
      () => { this.lexiconOff?.() },
    )
    return () => {
      unregister()
      this.editor.setRootElement(null)
    }
  }

  /** The latest committed editor projection. */
  get projection(): EditorProjection {
    return this.projected
  }

  /**
   * Run one editor edit whose result is observable on return. At the top
   * level this is a discrete update. Inside this editor's own update —
   * command handlers land here synchronously (space/enter picks, paste) —
   * $-functions are already legal, and wrapping them in update() would DEFER
   * them past the synchronous bail answer (and a nested discrete throws);
   * the body runs directly and the outer update commits it.
   * @param fn - the $-edit body.
   */
  private applyEdit(fn: () => void, tag?: string): void {
    if (this.editor._updating) {
      // Nested application joins the enclosing update (the PASTE_COMMAND
      // dispatch path always lands here), so the tag attaches to that update.
      if (tag !== undefined) $addUpdateTag(tag)
      fn()
      return
    }
    this.editor.update(fn, { discrete: true, ...(tag === undefined ? {} : { tag }) })
  }

  /**
   * Subscribe the text-ref re-scan to the controller's lexicon once the
   * controller resolves. The deps thunk cannot resolve at construction (the
   * shell is created inside the sessions provide materialization), so the
   * first interactive updates retry until it can.
   */
  private ensureLexiconSubscription(): void {
    if (this.lexiconOff !== undefined) return
    const lexicon = this.deps.resolveLexicon()
    if (lexicon === undefined) return
    this.lexiconOff = lexicon.subscribe(() => { rescanTextRefs(this.editor) })
  }

  /**
   * Re-project inside the existing editor update callback.
   * @returns the projection preceding this read.
   */
  refreshProjection(): EditorProjection {
    this.ensureLexiconSubscription()
    const prev = this.projected
    this.projected = this.editor.getEditorState().read(() =>
      $projectComposer(key => this.occurrenceIdOf(key)))
    return prev
  }

  private occurrenceIdOf(key: NodeKey): number {
    const existing = this.occurrenceIds.get(key)
    if (existing !== undefined) return existing
    this.occurrenceSeq += 1
    this.occurrenceIds.set(key, this.occurrenceSeq)
    return this.occurrenceSeq
  }

  /**
   * Replace the whole draft (persisted-draft seed and programmatic writes).
   * Placeholder-sanitized; newlines split paragraphs; the caret lands at the
   * end. Merged into history so a seed is not an undoable step of its own.
   * @param text - the full next draft.
   */
  setDraft(text: string): void {
    const clean = text.replace(REFERENCE_PLACEHOLDER_RE, '')
    if (clean === this.projection.clipboardText) return
    this.editor.update(() => {
      const root = $getRoot()
      root.clear()
      for (const line of clean.split('\n')) {
        const paragraph = $createParagraphNode()
        if (line !== '') paragraph.append($createTextNode(line))
        root.append(paragraph)
      }
      root.selectEnd()
    }, { discrete: true, tag: HISTORY_MERGE_TAG })
  }

  /**
   * Insert pasted plain text over the current editor selection
   * (placeholder-sanitized). The paste event's own default is suppressed by
   * the caller; PASTE_TAG makes the paste its own history boundary, so one
   * undo never removes both the paste and typing inside the merge window.
   * @param text - pasted plain text.
   */
  paste(text: string): void {
    const clean = text.replace(REFERENCE_PLACEHOLDER_RE, '')
    if (clean === '') return
    this.applyEdit(() => {
      const selection = $getSelection()
      if ($isRangeSelection(selection)) {
        selection.insertText(clean)
        return
      }
      // No selection yet (never-focused surface): land at the document end,
      // growing the first paragraph when the tree is empty.
      const root = $getRoot()
      if (root.getChildrenSize() === 0) root.append($createParagraphNode())
      root.selectEnd().insertText(clean)
    }, PASTE_TAG)
  }

  /**
   * The live selection as a detect-coordinate span (menu-launcher synthetic
   * hits replace it on pick); an absent selection answers a collapsed span at
   * the document end.
   * @returns the ordered [start, end) span in detect coordinates.
   */
  caretSpan(): { start: number; end: number } {
    if (this.projection.selection !== null) return this.projection.selection
    const at = this.projection.detectText.length
    return { start: at, end: at }
  }

  /**
   * Replace a mapped span without applying the model's phase or revision guards.
   * @param span - detect-coordinate range.
   * @param text - inserted text.
   * @returns whether the range mapped and the edit applied.
   */
  replaceText(span: DetectSpan, text: string): boolean {
    let applied = false
    this.applyEdit(() => {
      applied = $replaceDetectSpanWithText(span, text)
    })
    return applied
  }

  /**
   * Insert a reference chip with the existing trailing-space rule.
   * @param span - detect-coordinate range.
   * @param ref - reference fields.
   * @param tail - the character following the range before editing.
   * @returns whether the range mapped and the edit applied.
   */
  insertReference(span: DetectSpan, ref: ReferenceInsert, tail: string): boolean {
    let applied = false
    this.applyEdit(() => {
      const nodes = tail === ' '
        ? [$createReferenceChipNode(ref)]
        : [$createReferenceChipNode(ref), $createTextNode(' ')]
      applied = $replaceDetectSpanWithNodes(span, nodes)
    })
    return applied
  }

  /** Refresh claim-token decoration after the model's claim changes. */
  refreshClaimDecoration(): void {
    refreshClaimDecoration(this.editor)
  }

  /**
   * Clear committed content using the model's suffix decision inside the editor update.
   * @param prefixLength - returns the clipboard-prefix length to remove, or null to clear the root.
   */
  clearCommittedDraft(prefixLength: (clipboardText: string) => number | null): void {
    this.editor.update(() => {
      const layout = $composerLayout()
      const length = prefixLength(layout.clipboardText)
      if (length !== null) {
        $replaceDetectSpanWithText(
          { start: 0, end: detectOffsetOfClipboardOffset(layout, length) }, '',
        )
        return
      }
      const root = $getRoot()
      root.clear()
      root.selectEnd()
    }, { discrete: true, tag: HISTORY_MERGE_TAG })
  }

  /**
   * Rebuild one model-selected failure snapshot, creating fresh reference nodes.
   * @param draft - clipboard text.
   * @param occurrences - reference occurrences in clipboard order.
   */
  restoreDraft(draft: string, occurrences: readonly Occurrence[]): void {
    this.editor.update(() => {
      const root = $getRoot()
      root.clear()
      let paragraph = $createParagraphNode()
      root.append(paragraph)
      const appendText = (text: string): void => {
        const lines = text.split('\n')
        for (let i = 0; i < lines.length; i += 1) {
          const line = lines[i]
          if (line !== '') paragraph.append($createTextNode(line))
          if (i < lines.length - 1) {
            paragraph = $createParagraphNode()
            root.append(paragraph)
          }
        }
      }
      let cursor = 0
      for (const occurrence of occurrences) {
        appendText(draft.slice(cursor, occurrence.offset))
        paragraph.append(new ReferenceChipNode({
          source: occurrence.source,
          ref: occurrence.ref,
          label: occurrence.label,
          ...(occurrence.appearance === undefined ? {} : { appearance: occurrence.appearance }),
          clipboardText: occurrence.clipboardText,
        }, occurrence.invalid === true))
        cursor = occurrence.offset + occurrence.length
      }
      appendText(draft.slice(cursor))
      root.selectEnd()
    }, { discrete: true, tag: HISTORY_MERGE_TAG })
  }

  /** Cut the editor's undo history after a committed clear or restoration. */
  clearHistory(): void {
    this.editor.dispatchCommand(CLEAR_HISTORY_COMMAND, undefined)
  }
}
