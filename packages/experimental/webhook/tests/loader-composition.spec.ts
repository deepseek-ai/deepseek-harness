import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { afterEach, describe, expect, it } from 'vitest'
import WebhookRuntime, {
  WebhookDeliveryId,
  WebhookRuleId,
  WebhookSourceId,
} from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('real Loader composition', () => {
  it('loads the default Service export and an effect-scoped rule', { timeout: 60_000 }, async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-webhook-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      '- name: fixture-dependencies',
      "- name: '@deepseek-ai/dsh-webhook'",
      '- name: fixture-rule',
      '',
    ].join('\n'))

    const called = Promise.withResolvers<boolean>()
    const dependencies = {
      name: 'fixture-dependencies',
      apply(ctx: Context) {
        for (const service of [
          'agents', 'agentDefaultModel', 'agentPresets', 'permissionPresets', 'sessionTitle', 'workspaceRegistry',
        ]) {
          ctx.provide(service as never, {} as never)
        }
      },
    }
    const rule = {
      name: 'fixture-rule',
      inject: ['webhookRuntime'],
      apply(ctx: Context) {
        ctx.webhookRuntime.register({
          id: WebhookRuleId('loader-rule'),
          kind: 'fixture',
          run() {
            called.resolve(true)
            return null
          },
        })
      },
    }

    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['fixture-dependencies', dependencies],
      ['@deepseek-ai/dsh-webhook', WebhookRuntime],
      ['fixture-rule', rule],
    ])
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await context.loader.await()
    expect([...context.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])
    context.webhookRuntime.dispatch({
      kind: 'fixture',
      source: WebhookSourceId('loader'),
      deliveryId: WebhookDeliveryId('loader-delivery'),
      event: {},
      receivedAt: 1,
    })
    await called.promise
  })
})
