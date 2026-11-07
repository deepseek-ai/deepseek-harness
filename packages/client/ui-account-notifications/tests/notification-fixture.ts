/** Complete account notification values shared by presentation tests. */
import type { AccountNotification, AccountNotificationId } from '@deepseek-ai/dsh-deepseek-account/types'

/**
 * Create one notification without wire parsing or account lifecycle effects.
 * @param id - stable notification identity.
 * @param fields - scenario-specific notification fields.
 * @returns localized display content with no actions or deadline unless supplied.
 */
export function notification(id: string, fields: Partial<Omit<AccountNotification, 'id'>> = {}): AccountNotification {
  return {
    id: id as AccountNotificationId, createdAt: '2026-10-21T08:00:00Z',
    displayUntil: null, title: 'Bonus credited', body: 'Server copy 5.00', actions: [], ...fields,
  }
}
