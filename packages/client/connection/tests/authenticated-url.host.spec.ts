/** The launch URL Connection publishes on behalf of its authentication provider. */
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { afterEach, expect, it } from 'vitest'
import * as Connection from '../src/index.ts'

const roots: Context[] = []
afterEach(async () => { for (const root of roots.splice(0)) await root.fiber.dispose() })

const CLEAN = 'http://127.0.0.1:3080/'

async function mounted() {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(Connection)
  return { ctx, authentication: ctx.connection.authentication }
}

/**
 * Ask for the launch URL the way a consumer does: from a plugin that injects
 * `connection` and nothing else. A service method invoked through the traceable
 * proxy resolves a property named after a nested service against that caller.
 * @param ctx - root context to mount the consumer in.
 * @returns the consumer's answer, once its fiber has activated.
 */
async function asked(ctx: Context): Promise<string> {
  const answers: string[] = []
  await ctx.plugin({
    inject: ['connection'],
    apply(consumer: Context) { answers.push(consumer.connection.authenticatedUrl(CLEAN)) },
  }).await()
  return answers[0] as string
}

it('keeps the clean URL until a provider announces a launch URL', async () => {
  const { ctx, authentication } = await mounted()
  expect(await asked(ctx)).toBe(CLEAN)
  const silent = authentication.register({ authenticate: () => undefined })
  expect(await asked(ctx)).toBe(CLEAN)
  const announcing = authentication.register({
    authenticate: () => undefined,
    authenticatedUrl: baseUrl => `${baseUrl}launch?token=fixture`,
  })
  expect(await asked(ctx)).toBe(`${CLEAN}launch?token=fixture`)
  await announcing()
  await silent()
  expect(await asked(ctx)).toBe(CLEAN)
})

it('announces no launch URL once its registry unloads', async () => {
  const ctx = new Context()
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(Connection)
  const authentication = ctx.connection.authentication
  authentication.register({ authenticate: () => undefined, authenticatedUrl: baseUrl => `${baseUrl}?token=fixture` })
  expect(authentication.authenticatedUrl(CLEAN)).toBe(`${CLEAN}?token=fixture`)
  await ctx.fiber.dispose()
  expect(authentication.authenticatedUrl(CLEAN)).toBeUndefined()
})
