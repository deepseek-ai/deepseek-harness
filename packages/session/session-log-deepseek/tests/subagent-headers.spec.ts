import { afterEach, expect, it } from 'vitest'
import { Context, LoggerLevel } from '@deepseek-ai/cordis'
import SessionStore, { type SessionId } from '@deepseek-ai/dsh-session'
import DeepSeekLlmApiExtensionRegistry from '@deepseek-ai/dsh-deepseek-llm-api-extensions'
import { brandString } from '@deepseek-ai/dsh-brand'
import * as SessionLogDeepSeek from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function harness(enabled = true): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(DeepSeekLlmApiExtensionRegistry)
  await ctx.plugin(SessionLogDeepSeek, { enabled })
  return ctx
}

it('marks only subagent Sessions, even when other Sessions record a parent', async () => {
  const ctx = await harness()
  const parent = ctx.sessions.create()
  const fork = ctx.sessions.create(undefined, { meta: { parentSession: parent.id } })
  const side = ctx.sessions.create(undefined, { meta: { origin: 'side', parentSession: parent.id } })
  for (const sessionId of [parent.id, fork.id, side.id, 'unloaded']) {
    expect(ctx.deepseekLlmApiExtensions.headers({ sessionId })).toEqual({})
  }
  expect(ctx.deepseekLlmApiExtensions.headers({})).toEqual({})
})

it.each([true, false])('sends a recorded direct parent that need not be live when log upload enabled is %s', async (enabled) => {
  const ctx = await harness(enabled)
  const child = ctx.sessions.create(undefined, {
    meta: { origin: 'subagent', parentSession: brandString<SessionId>('offline parent') },
  })
  expect(ctx.deepseekLlmApiExtensions.headers({ sessionId: child.id, purpose: 'compaction' })).toEqual({
    'x-deepseek-harness-session-type': 'subagent',
    'x-deepseek-harness-subagent-parent-session-id': 'offline parent',
  })
})

it('keeps the subagent marker when its parent id is absent or cannot be sent verbatim', async () => {
  const ctx = await harness()
  const warnings: unknown[][] = []
  ctx.logger.exporter({ levels: { default: LoggerLevel.WARN }, export: (message) => { if (message.type === 'warn') warnings.push(message.args) } })
  for (const parent of [undefined, '', ' leading', 'trailing\t', 'a\r\nb', '父']) {
    const child = ctx.sessions.create(undefined, {
      meta: { origin: 'subagent', ...parent === undefined ? {} : { parentSession: brandString<SessionId>(parent) } },
    })
    expect(ctx.deepseekLlmApiExtensions.headers({ sessionId: child.id })).toEqual({ 'x-deepseek-harness-session-type': 'subagent' })
  }
  expect(warnings).toEqual([[
    'deepseek-llm-api-extensions: omitting header "x-deepseek-harness-subagent-parent-session-id" from this request'
    + ' because its value cannot be sent verbatim as an HTTP field value',
  ]])
})
