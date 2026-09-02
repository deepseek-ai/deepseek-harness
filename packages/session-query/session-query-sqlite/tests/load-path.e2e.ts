import { createUserMessage } from '@deepseek-ai/dsh-llm'
/**
 * Keyless real-Loader-path smoke for the combined SQLite session-query service.
 *
 * @module @deepseek-ai/dsh-session-query-sqlite/tests/load-path
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SessionStore, { SessionSeq, SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SqliteSessionQueryEngine, * as queryModule from '@deepseek-ai/dsh-session-query-sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

async function temporaryPath(name: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-session-search-loader-'))
  temporaryDirectories.push(directory)
  return join(directory, name)
}

describe('dsh-session-query-sqlite real Loader path', () => {
  it('unwraps, mounts, and searches the real persistence backend', async () => {
    const persistenceRoot = await temporaryPath('canonical')
    const searchPath = await temporaryPath('derived.db')
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SessionStore)
    const persistence = await ctx.plugin(JsonlSessionPersistence, {
      root: persistenceRoot,
      compression: 'none',
    })

    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(queryModule) as Parameters<Context['plugin']>[0]
    expect(unwrapped).toBe(SqliteSessionQueryEngine)
    const query = await ctx.plugin(unwrapped, { path: searchPath })

    const id = SessionId('loader-path')
    const writer = await ctx.sessionPersistence.create({ version: SESSION_FORMAT_VERSION, id, createdAt: 10, isSeeded: false })
    await writer.append([{
      type: 'user/message',
      seq: SessionSeq(0),
      time: 10,
      data: createUserMessage({
        content: [{ type: 'text', text: 'real Loader needle' }], source: { kind: 'user' },
      }),
      surfaceOp: 'append',
    }])
    await writer.close()

    await expect(ctx.sessionQuery.searchSessions({ query: 'Loader needle' }))
      .resolves.toMatchObject({ items: [{ header: { id }, persisted: true, live: false }] })
    await expect(ctx.sessionQuery.listSessions())
      .resolves.toMatchObject([{ header: { id }, persisted: true, live: false }])
    await query.dispose()
    await persistence.dispose()
  })
})
