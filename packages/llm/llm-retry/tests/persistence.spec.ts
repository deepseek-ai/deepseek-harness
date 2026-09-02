import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { RetryId } from '@deepseek-ai/dsh-llm-retry'
import type {} from '../src/index.ts'

const dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function backend(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const root = await mkdtemp(join(tmpdir(), 'dsh-llm-retry-jsonl-'))
  dirs.push(root)
  await ctx.plugin(JsonlSessionPersistence, { root })
  return ctx
}

describe('JSONL retry-event persistence', () => {
  it('round-trips the event losslessly without adding a model message', async () => {
    const ctx = await backend()
    try {
      const session = ctx.sessions.create(SessionId('retry-jsonl'))
      const handle = await ctx.sessionPersistence.create(session.header)
      session.append('turn/start', { turn: 1 })
      session.append('step/start', { turn: 1, step: 1 })
      session.append('request/header', {
        header: { config: { provider: 'mock', model: 'mock' } },
        reason: 'initial',
      })
      const event = session.append('llm/retry', {
        retryId: RetryId('retry-jsonl-chain'),
        turn: 1,
        step: 1,
        provider: 'mock',
        mode: 'always',
        policyKey: '["always",500,10000,0.1]',
        retry: 1,
        delayMs: 750,
        failure: { message: 'provider busy', code: 'RATE_LIMIT', status: 429 },
      })
      session.append('step/end', { turn: 1, step: 1 })
      session.append('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'provider busy', code: 'RATE_LIMIT', status: 429 },
      },
      })

      expect(session.deriveMessages()).toEqual([])
      await ctx.sessions.flush(session)
      await handle.close()
      const reader = await ctx.sessionPersistence.open(session.id, 'read')
      try {
        const loaded = await reader.read()
        expect(loaded.find(item => item.type === 'llm/retry')).toEqual(event)
      } finally {
        await reader.close()
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
