/** Notices that report the outcome of an action on a change request, shared by the Session panel and the review page. */

import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ForgePanelKey } from './locales.ts'
import type { NoticeSource } from './source.ts'
import type { ChangeRequestEntry } from './status.ts'

/** Notice keys of one action: success, a head that moved, and any other refusal. */
export interface ActionNoticeKeys {
  /** Success; its text names the change request as `{name}`. */
  readonly done: ForgePanelKey
  /** The head moved since the action was confirmed, for actions that check it; its text names the change request. */
  readonly stale?: ForgePanelKey
  /** Any other refusal; its text names the code host's reason as `{message}`. */
  readonly failed: ForgePanelKey
}

/** Reports one action's outcome. */
export type ActionReporter = (
  entry: ChangeRequestEntry, result: RemoteResult<unknown>, keys: ActionNoticeKeys, params?: Readonly<Record<string, string>>,
) => void

/**
 * Create the reporter of action outcomes. An action whose outcome the code host did not confirm asks the reader to
 * check the change request there.
 * @param notices - the notice store.
 * @param nameOf - how notices name a change request.
 * @returns the reporter.
 */
export function actionReporter(notices: NoticeSource, nameOf: (entry: ChangeRequestEntry) => string): ActionReporter {
  return (entry, result, keys, params = {}) => {
    const name = nameOf(entry)
    if (result.ok) notices.report(keys.done, { tone: 'success', params: { name, ...params } })
    else if (keys.stale !== undefined && result.error.code === 'forgePanel/stale-head') notices.report(keys.stale, { params: { name } })
    else if (result.error.code === 'forgePanel/action-unknown') notices.report('toast.actionUnknown', { params: { name } })
    else notices.report(keys.failed, { params: { message: result.error.message } })
  }
}
