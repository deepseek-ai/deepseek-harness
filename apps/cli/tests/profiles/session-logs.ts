/** Logical persisted history inspection for shipped-profile acceptance tests. @module */
import { Context } from '@deepseek-ai/cordis'
import { snapshotSessionFormatJson } from '@deepseek-ai/dsh-session-format'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import * as SessionPersistencePlugin from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { JsonlCompression } from '@deepseek-ai/dsh-session-persistence-jsonl'

/**
 * Read logical history after the profile process has settled its writes.
 * @param root - the exact persistence directory configured by the profile process.
 * @param compression - encoding of any retained JSONL import sources.
 * @returns current-format logs, with parent Sessions ordered before children.
 */
export async function persistedSessionLogs(root: string, compression: JsonlCompression): Promise<{
  readonly content: string
  readonly header: SessionHeader
}[]> {
  const ctx = new Context()
  try {
    await ctx.plugin(SessionPersistencePlugin, { root, compression })
    const logs = []
    for (const snapshot of await ctx.sessionPersistence.list()) {
      await using handle = await ctx.sessionPersistence.open(snapshot.header.id, 'read')
      const { events } = await handle.read()
      const header = sessionFormatCatalog.encodeCurrentHeader(
        { ...handle.header, delegationDepth: handle.header.delegationDepth ?? 0 }, handle.inheritedEventCount,
      )
      const content = [header, ...events.map(event => sessionFormatCatalog.encodeCurrentEvent({
        ...event, data: snapshotSessionFormatJson(event.data),
      }))].map(record => JSON.stringify(record)).join('\n') + '\n'
      logs.push({ header: handle.header, content })
    }
    return logs.sort((a, b) => Number(a.header.parentSession !== undefined) - Number(b.header.parentSession !== undefined)
      || a.header.createdAt - b.header.createdAt || a.header.id.localeCompare(b.header.id))
  } finally { await ctx.fiber.dispose() }
}
