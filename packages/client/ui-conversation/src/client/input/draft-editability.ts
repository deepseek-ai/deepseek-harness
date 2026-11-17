/** Session conditions under which features outside the composer may edit a Session draft. */
import type { SessionFace } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ComposerBlock } from '../contract/composer-blocks.ts'

/**
 * Observe whether a Session accepts draft insertions from outside the composer.
 * Removed Sessions, non-continuable subagent Sessions, and composer blocks refuse.
 * @param session - live Session face.
 * @param blocks - resolves the Session's composer-block store at each read and subscription.
 * @returns a boolean snapshot that notifies on Session and composer-block changes.
 */
export function sessionDraftEditable(
  session: SessionFace,
  blocks: () => ObservableSnapshot<ComposerBlock | undefined>,
): ObservableSnapshot<boolean> {
  return {
    getSnapshot: () => {
      const state = session.getSnapshot()
      return !state.removed && (state.subagent === null || state.subagent.address.mode === 'continuable')
        && blocks().getSnapshot() === undefined
    },
    subscribe: (fn) => {
      const offSession = session.subscribe(fn)
      const offBlocks = blocks().subscribe(fn)
      return () => {
        offSession()
        offBlocks()
      }
    },
  }
}
