/** Isolated persistence providers sharing one test-owned storage directory. @module */
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { onTestFinished } from 'vitest'
import * as SqlitePersistence from '../../src/index.ts'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { JsonlCompression } from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionStore from '@deepseek-ai/dsh-session'

/**
 * Allocate private storage and close every mounted provider before removing it.
 * @returns storage root and factories for independently owned providers.
 */
export async function persistenceFixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sqlite-persistence-'))
  const contexts: Context[] = []
  onTestFinished(async () => {
    let failures: unknown[]
    try {
      const results = await Promise.allSettled(contexts.map(context => context.fiber.dispose()))
      failures = results.filter(result => result.status === 'rejected').map((result): unknown => result.reason)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Persistence fixture disposal failed')
  })
  async function mount(storage: 'sqlite' | 'jsonl', compression: JsonlCompression = 'none', frameEvents?: number) {
    const context = new Context()
    contexts.push(context)
    await context.plugin(SessionStore)
    const provider = storage === 'sqlite'
      ? await context.plugin(SqlitePersistence, { root, compression, ...(frameEvents === undefined ? {} : { frameEvents }) })
      : await context.plugin(JsonlPersistence, { root, compression })
    return { context, persistence: context.sessionPersistence, provider }
  }
  return { root, mount }
}
