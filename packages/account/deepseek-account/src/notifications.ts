/** Validated, localized notification queries through the account API. */
import { z } from 'zod'
import type { AccountNotification, AccountNotificationBatch, AccountNotificationEvent, AccountNotificationId } from './types.ts'
import { PlatformAuthError, requestNotificationContent, requestNotificationEvent, requestNotifications } from './protocol.ts'

const action = z.object({
  label: z.string(),
  style: z.enum(['primary', 'secondary']),
  target: z.discriminatedUnion('type', [
    z.object({ type: z.literal('app_route'), name: z.literal('account') }),
    z.object({ type: z.literal('dismiss') }),
  ]),
})
// The HTTP reader supplies JSON values; business data has no notification-specific fields.
const notification = z.object({
  id: z.string(), created_at: z.iso.datetime({ offset: true }),
  display_until: z.iso.datetime({ offset: true }).nullable(),
  title: z.string(), body: z.string(), actions: z.array(action), data: z.json().optional(),
})
const list = z.object({
  next_poll_after: z.number().positive().max(2_147_483_647 / 1_000),
  notifications: z.array(z.unknown()),
})

function project(value: z.infer<typeof notification>): AccountNotification {
  return {
    id: value.id as AccountNotificationId, createdAt: value.created_at,
    displayUntil: value.display_until, title: value.title, body: value.body, actions: value.actions,
    ...(value.data === undefined ? {} : { data: value.data }),
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    console.error('[deepseek-account] notification schema rejected', {
      issues: parsed.error.issues.map(issue => ({ path: issue.path, code: issue.code })),
    })
    throw new PlatformAuthError('protocol')
  }
  return parsed.data
}

/**
 * Read unconsumed notifications for one captured account credential.
 * @param origin - configured account API origin.
 * @param token - captured account grant.
 * @param signal - credential lifetime and request timeout.
 * @param headers - deployment and client identity headers.
 * @returns supported notifications in server order and the next query delay in seconds; malformed entries are skipped,
 * while HTTP and list-envelope failures reject.
 */
export async function readNotifications(origin: string, token: string,
  signal: AbortSignal, headers: Record<string, string>): Promise<AccountNotificationBatch> {
  const value = parse(list, await requestNotifications(origin, token, signal, headers))
  const notifications = value.notifications.flatMap((entry, index) => {
    const parsed = notification.safeParse(entry)
    if (!parsed.success) {
      console.error('[deepseek-account] skipping unsupported notification', {
        index, issues: parsed.error.issues.map(issue => ({ path: issue.path, code: issue.code })),
      })
      return []
    }
    return [project(parsed.data)]
  })
  return { nextPollAfterSeconds: value.next_poll_after, notifications }
}

/**
 * Read localized content without changing notification consumption.
 * @param origin - configured account API origin.
 * @param token - captured token for this request's credential lifetime.
 * @param id - notification whose content is requested.
 * @param signal - credential lifetime and request timeout.
 * @param headers - deployment and client identity headers.
 * @returns content with the requested identity; mismatched IDs and malformed responses reject.
 */
export async function readNotificationContent(origin: string, token: string, id: AccountNotificationId,
  signal: AbortSignal, headers: Record<string, string>): Promise<AccountNotification> {
  const value = parse(notification, await requestNotificationContent(origin, token, id, signal, headers))
  if (value.id !== id) throw new PlatformAuthError('protocol')
  return project(value)
}

/**
 * Report an interaction; the response's consumption decision never closes the local card.
 * @param origin - configured account API origin.
 * @param token - captured token for this request's credential lifetime.
 * @param id - notification the user interacted with.
 * @param event - displayed frame, business-action click, or explicit dismissal.
 * @param signal - credential lifetime and request timeout.
 * @param headers - deployment and client identity headers.
 * @returns after the server accepts the event; HTTP and malformed responses reject.
 */
export async function sendNotificationEvent(origin: string, token: string, id: AccountNotificationId,
  event: AccountNotificationEvent, signal: AbortSignal, headers: Record<string, string>): Promise<void> {
  parse(z.object({ acked: z.boolean() }), await requestNotificationEvent(origin, token, id, event, signal, headers))
}
