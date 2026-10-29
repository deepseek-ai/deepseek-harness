/** Fields, recorded data and user actions of `create_personalized_page` cards. */
import type { ChangeResult } from '@deepseek-ai/dsh-plugin-manager/types'

/** Placements: page is a Session view tab; sidebar-left combines a global page and its left entry. */
export type CreationSlot = 'sidebar-right' | 'page' | 'sidebar-left'

/** Card fields the skill asks the model to write in `details`. */
export interface PageDetails {
  /** Recommended location; the user can change it on the card. */
  readonly slot: CreationSlot
  /** Omitted for a new empty page; otherwise the existing content passed to the Creator, separate from the short brief. */
  readonly initialContent?: string | undefined
}

/** Phases a page card records besides the shared `dismissed`. */
export type PagePhase = 'creating' | 'installing' | 'cancelled' | 'installed' | 'kept' | 'removed' | 'failed' | 'interrupted' | 'unconfirmed'

/** Data each page decision records; profile files own the installed bundle. */
export interface PageData {
  /** Location chosen when the user created or dismissed the card. */
  readonly slot: CreationSlot
  /** Omitted: use slot. Present: Creator resolves this human-authored placement instead. */
  readonly customLocation?: string | undefined
  /** Host-reserved name of the created bundle. */
  readonly bundleName?: string | undefined
  /** Outcome of the latest installation or removal. */
  readonly application?: ChangeResult['application'] | undefined
}

/** User actions a page card offers besides the shared `dismiss`. */
export type PageVerb = 'create' | 'keep' | 'undo' | 'cancel' | 'restore'

/** Fields the card sends with Create and Not now; Create requires a valid location. */
export interface PageLocation {
  readonly slot: CreationSlot
  /** Human-written placement of at most 1,000 characters; omitted for a listed location. */
  readonly customLocation?: string | undefined
}
