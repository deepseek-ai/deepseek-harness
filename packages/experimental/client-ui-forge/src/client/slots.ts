/** The forge panel's extension slots and the props their owners pass. */

import type { ChangeRequestRef, ChangeRequestState } from '@deepseek-ai/dsh-experimental-forge/types'
import type { ForgeLensFile } from '../types.ts'
import type { ChangesTarget } from './changes-address.ts'
import type { ForgeLineAnnotation } from './changes-service.ts'

/** Owner props of `forge.changes.toolbar`. */
export interface ForgeChangesToolbarProps {
  /** The view the toolbar belongs to. */
  readonly target: ChangesTarget
  /** `bar`: a 28px tool in the toolbar row; `menu`: `MenuItemButton` rows of the More menu a narrow toolbar folds entries into. */
  readonly form: 'bar' | 'menu'
  /** Close the More menu after a row acted; a no-op in the toolbar row. */
  readonly close: () => void
}

/** Owner props of `forge.changes.file.menu`. */
export interface ForgeChangesFileMenuProps {
  /** The view the file belongs to. */
  readonly target: ChangesTarget
  /** The file whose menu opened. */
  readonly file: ForgeLensFile
  /** Close the menu after a row acted. */
  readonly dismiss: () => void
}

/** Owner props of `forge.diff.line.annotation`. */
export interface ForgeLineAnnotationProps {
  /** The view the annotation shows in. */
  readonly target: ChangesTarget
  /** Repository-relative path of the annotated file. */
  readonly path: string
  /** The annotation its source reported. */
  readonly annotation: ForgeLineAnnotation
}

/** Owner props of `forge.diff.comment.actions`. */
export interface ForgeCommentActionsProps {
  /** The view the comment form belongs to. */
  readonly target: ChangesTarget
  /** The lines the comment is on. */
  readonly selection: { readonly path: string; readonly side: 'L' | 'R'; readonly startLine: number; readonly endLine: number }
  /** Whether the comment has no text, so actions stay disabled. */
  readonly empty: boolean
  /** Whether a send runs, so actions stay disabled. */
  readonly busy: boolean
  /**
   * Hand the comment's text to `deliver`. The form shows itself busy until `deliver` settles, closes when it resolves
   * to undefined, and keeps the text with the message it resolves to otherwise.
   * @param deliver - receives the text.
   */
  readonly send: (deliver: (body: string) => Promise<string | undefined>) => void
}

/** Owner props of `forge.change-request.card.actions`. */
export interface ForgeChangeRequestCardActionsProps {
  /** Binding URL of the change request. */
  readonly url: string
  /** Parsed reference, or null when no provider serves the URL. */
  readonly ref: ChangeRequestRef | null
  /** Head commit of the latest status, or null before one. */
  readonly headSha: string | null
  /** Lifecycle state of the latest status, or null before one. */
  readonly state: ChangeRequestState | null
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Tools a plugin adds to the changes toolbar, after its flexible space and before the thread list toggle. */
    'forge.changes.toolbar': { kind: 'list'; scope: 'session'; owner: ForgeChangesToolbarProps }
    /** Rows a plugin adds to a file's menu, below the built-in rows. */
    'forge.changes.file.menu': { kind: 'list'; scope: 'session'; owner: ForgeChangesFileMenuProps }
    /** The content of one line annotation, keyed by its source; the changes view draws the frame around it. */
    'forge.diff.line.annotation': { kind: 'keyed'; scope: 'session'; owner: ForgeLineAnnotationProps }
    /** Buttons a plugin adds to the line comment form, between Add to input and the code host actions. */
    'forge.diff.comment.actions': { kind: 'list'; scope: 'session'; owner: ForgeCommentActionsProps }
    /** Icon buttons a plugin adds to a change request card's head, before Open in browser. */
    'forge.change-request.card.actions': { kind: 'list'; scope: 'session'; owner: ForgeChangeRequestCardActionsProps }
  }
}
