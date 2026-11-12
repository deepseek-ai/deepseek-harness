/** Logical Session snapshot collection through the configured persistence provider. @module */
import { Context } from '@deepseek-ai/cordis'
import * as persistencePlugin from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { snapshotSessionFormatJson } from '@deepseek-ai/dsh-session-format'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import type { HarvestedLog } from './harness.ts'

/**
 * Read every listed Session through read handles; first-open legacy imports follow provider ownership rules.
 * Call after writers settle; each returned log contains the complete inherited prefix.
 * @param persistence - provider for the storage being observed.
 * @returns current-format JSONL logs in the provider's listing order.
 */
export async function collectSessionLogs(persistence: SessionPersistence): Promise<HarvestedLog[]> {
  const logs: HarvestedLog[] = []
  for (const snapshot of await persistence.list()) {
    const handle = await persistence.open(snapshot.header.id, 'read')
    try {
      const header = sessionFormatCatalog.encodeCurrentHeader(
        { ...handle.header, delegationDepth: handle.header.delegationDepth ?? 0 }, handle.inheritedEventCount,
      )
      const { events } = await handle.read()
      const content = [header, ...events.map(event => sessionFormatCatalog.encodeCurrentEvent({
        ...event, data: snapshotSessionFormatJson(event.data),
      }))]
        .map(record => JSON.stringify(record)).join('\n') + '\n'
      logs.push({ id: handle.id, createdAt: handle.header.createdAt,
        ...handle.header.parentSession === undefined ? {} : { parentSession: handle.header.parentSession }, content })
    } finally { await handle.close() }
  }
  return logs
}

/**
 * Collect logical histories from a snapshot fixture's persistence root using its normal provider.
 * @param root - isolated Session storage root using the default SQLite location and raw legacy files.
 * @returns complete histories after observational handles and the provider have closed.
 */
export async function collectStoredSessionLogs(root: string): Promise<HarvestedLog[]> {
  const ctx = new Context()
  try {
    await ctx.plugin(persistencePlugin, { root, compression: 'none' })
    return await collectSessionLogs(ctx.sessionPersistence)
  } finally { await ctx.fiber.dispose() }
}
