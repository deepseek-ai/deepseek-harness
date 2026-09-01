import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as applyLocale, inject as localeInject } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '../src/client/index.ts'
import { apply as applyNode } from '../src/index.ts'
import { en, NS, zh } from '../src/client/locales.ts'

const Empty = () => null

function headerEntryIds(ctx: Context): (string | undefined)[] {
  return ctx.slots
    .entries('conversation.session.header.actions')
    .map(entry => entry.options.id)
}

async function baseContext(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('connection', { api: { settings: {} }, isLoopback: false } as never)
  ctx.provide('remote', { $on: () => () => {} } as never)
  ctx.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
  await ctx.plugin({ inject: localeInject, apply: applyLocale }).await()
  return ctx
}

function declareHeader(ctx: Context): () => void {
  return ctx.slots.register({
    name: 'root',
    children: {
      'conversation.session.header.actions': { kind: 'list', scope: 'session' },
    },
  } as never, Empty)
}

describe('ui-schedule browser half', () => {
  it('declares only the services used by registration', () => {
    expect(inject).toEqual(['slots', 'locale'])
  })

  it('waits for the header declaration, orders between static context and Jobs, and tears down', async () => {
    const ctx = await baseContext()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(headerEntryIds(ctx)).toEqual([])

    const header = declareHeader(ctx)
    ctx.slots.register({
      name: 'conversation.session.header.actions', id: 'agent-preset', order: -10,
    }, Empty)
    ctx.slots.register({
      name: 'conversation.session.header.actions', id: 'job-list', order: 20,
    }, Empty)
    expect(headerEntryIds(ctx)).toEqual(['agent-preset', 'schedule-catalog', 'job-list'])

    await fiber.dispose()
    expect(headerEntryIds(ctx)).toEqual(['agent-preset', 'job-list'])
    header()
    await ctx.fiber.dispose()
  })

  it('registers both dictionaries and releases them with its fiber', async () => {
    const ctx = await baseContext()
    declareHeader(ctx)
    ctx.locale.setLocale('zh')
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const translate = ctx.locale.bind(NS)
    expect(translate('list.aria')).toBe(zh['list.aria'])
    ctx.locale.setLocale('en')
    expect(translate('list.aria')).toBe(en['list.aria'])
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())

    await fiber.dispose()
    expect(translate('list.aria')).not.toBe(en['list.aria'])
    await ctx.fiber.dispose()
  })
})

describe('ui-schedule node half', () => {
  it('keeps the node half inert', () => {
    expect(applyNode).not.toThrow()
  })
})
