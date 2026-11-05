/** Catalog vocabulary shared by the Session surfaces and Host task management. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ScheduleCatalogEntry, RRuleScheduleRecord } from '@deepseek-ai/dsh-schedule/client'

/** Earliest scheduled delivery after applying the Host's current admission interval.
 * @param task - Catalog entry with its scheduled occurrence and optional delivery floor.
 * @returns The later of the occurrence and delivery floor, without changing the stored rule.
 */
export function taskNextRunAt(task: Pick<ScheduleCatalogEntry, 'scheduledAt' | 'deliveryFloorEndsAt'>): string {
  return task.deliveryFloorEndsAt !== undefined
    && Date.parse(task.deliveryFloorEndsAt) > Date.parse(task.scheduledAt)
    ? task.deliveryFloorEndsAt : task.scheduledAt
}

/** The reusable target Session, or the latest per-execution Session when one exists.
 * @param task - Task whose conversation link is shown.
 * @returns Destination identity, if a delivery or reservation names one.
 */
export function taskSessionId(task: Pick<ScheduleCatalogEntry, 'target' | 'lastDelivery'>): SessionId | undefined {
  return task.target.kind === 'new' ? task.lastDelivery?.targetSessionId : task.target.sessionId
}

/** Whether one Session should expose this task in its existing clock entry.
 * @param task - Catalog entry being inspected.
 * @param sessionId - Session owning the entry.
 * @returns Whether the task targets or involves this Session.
 */
export function taskInvolvesSession(task: ScheduleCatalogEntry, sessionId: SessionId): boolean {
  return task.involvedSessionIds.includes(sessionId) || taskSessionId(task) === sessionId
}

/** RRULE fields read for presentation; dispatch remains owned by the Host.
 * @param rrule - Host-validated recurrence text.
 * @returns Fields from its RRULE content line.
 */
export function ruleFields(rrule: string): ReadonlyMap<string, string> {
  const line = /^RRULE:(.+)$/m.exec(rrule)?.[1] ?? ''
  return new Map(line.split(';').map(field => field.split('=') as [string, string]))
}

/** Guided timing choices; rules that cannot round-trip through the form stay custom.
 * @param task - Authoritative timing record.
 * @returns Guided choice, or custom for an unsupported rule.
 */
export function hostFrequencyKind(task: RRuleScheduleRecord):
  'once' | 'minutely' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'custom' {
  const anchor = /^DTSTART(?:;TZID=[^:]+)?:\d{8}T\d{4}(\d{2})Z?$/m.exec(task.rrule)
  if (anchor === null) return 'custom'
  const fields = ruleFields(task.rrule)
  const freq = fields.get('FREQ')
  if (fields.get('COUNT') === '1' && fields.size === 2 && freq === 'DAILY') return 'once'
  if (fields.has('COUNT') || fields.has('UNTIL') || fields.has('BYSECOND')) return 'custom'
  const keys = [...fields.keys()]
  const allowed = (names: readonly string[]): boolean => keys.every(key => names.includes(key))
  if (freq === 'MINUTELY' && allowed(['FREQ', 'INTERVAL'])) return 'minutely'
  if (freq === 'HOURLY' && allowed(['FREQ', 'INTERVAL'])) return 'hourly'
  if (freq === 'DAILY' && anchor[1] === '00'
    && allowed(['FREQ', 'INTERVAL', 'BYHOUR', 'BYMINUTE', 'BYSETPOS'])
    && (!fields.has('BYHOUR') && !fields.has('BYMINUTE') && !fields.has('BYSETPOS')
      || /^\d{1,2}$/.test(fields.get('BYHOUR') ?? '') && /^\d{1,2}$/.test(fields.get('BYMINUTE') ?? '')
        && (!fields.has('BYSETPOS') || fields.get('BYSETPOS') === '1'))) return 'daily'
  if (freq === 'WEEKLY' && allowed(['FREQ', 'INTERVAL', 'BYDAY'])
    && (fields.get('BYDAY') ?? '').split(',').every(day => /^(MO|TU|WE|TH|FR|SA|SU)$/.test(day))) return 'weekly'
  if (freq === 'MONTHLY' && allowed(['FREQ', 'INTERVAL', 'BYMONTHDAY', 'BYSETPOS'])
    && fields.get('BYSETPOS') === '1' && /^\d{1,2},-1$/.test(fields.get('BYMONTHDAY') ?? '')) return 'monthly'
  return 'custom'
}
