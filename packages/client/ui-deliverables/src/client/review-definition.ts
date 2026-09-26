/**
 * What the `changes-review` tab type IS: the right-Sidebar review of one
 * turn's changed files, showing one file's turn-start and turn-end
 * comparison at a time. It claims the `dsh-resource://changes-review/session/…`
 * addresses the changed-files card mints; the Session and the event sequence
 * in the address identify the content, and the turn they carry names the tab.
 * A row opens the tab with the file's index as its navigation parameter.
 */
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import { parseChangesReviewAddress } from '../changes.ts'
import type { NS } from './locales.ts'

/** The tab kind this package owns. */
export const CHANGES_REVIEW_KIND = 'changes-review'

/** This implementation's identity in the tab system, and the key its body registers under. */
export const CHANGES_REVIEW_ID = '@deepseek-ai/dsh-client-ui-deliverables'

/** The file a review opens on. */
export interface ChangesReviewParams {
  /** Original index in the summary's files array. */
  index?: number
}

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightResourceParamsMap {
    /** The file a review tab opens on. */
    'changes-review': ChangesReviewParams
  }
}

/**
 * The review type's registry definition.
 * @param t - namespace-bound translate, read fresh on every title call.
 * @returns the definition to register.
 */
export function changesReviewDefinition(t: TranslateNS<typeof NS>): SidebarRightTabDefinition {
  return {
    id: CHANGES_REVIEW_ID,
    kind: CHANGES_REVIEW_KIND,
    patterns: ['dsh-resource://changes-review/**'],
    priority: 'builtin',
    canOpen: address => parseChangesReviewAddress(address) !== undefined,
    title: (address) => {
      const turn = parseChangesReviewAddress(address)?.turn
      return turn === undefined ? address : t('review.title', { turn: String(turn) })
    },
  }
}
