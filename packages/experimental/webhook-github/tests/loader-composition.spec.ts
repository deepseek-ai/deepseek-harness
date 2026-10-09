import { createHmac } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as GitHubAdapter from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('real Loader composition', () => {
  it('registers on a real WebServer and dispatches a signed request', { timeout: 60_000 }, async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-webhook-github-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      '- name: fixture-dependencies',
      "- name: '@deepseek-ai/dsh-host-webserver'",
      '  config:',
      "    host: '127.0.0.1'",
      '    port: 0',
      "- name: '@deepseek-ai/dsh-webhook-github'",
      '  config:',
      '    source: loader',
      '    path: /github',
      '    secretEnv: DSH_GITHUB_WEBHOOK_SECRET',
      '    maxBodyBytes: 1024',
      '',
    ].join('\n'))

    const dispatch = vi.fn()
    const dependencies = {
      name: 'fixture-dependencies',
      apply(ctx: Context) {
        ctx.provide('webhookRuntime', { dispatch } as never)
        ctx.provide('credentials', {
          resolve: async () => ({ value: 'loader-secret', source: 'environment' }),
        } as never)
      },
    }
    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['fixture-dependencies', dependencies],
      ['@deepseek-ai/dsh-host-webserver', WebServer],
      ['@deepseek-ai/dsh-webhook-github', GitHubAdapter],
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

    const body = JSON.stringify({ action: 'ready_for_review' })
    const signature = `sha256=${createHmac('sha256', 'loader-secret').update(body).digest('hex')}`
    const response = await fetch(`http://127.0.0.1:${String(context.webServer.port)}/github`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signature,
        'x-github-event': 'pull_request',
        'x-github-delivery': 'loader-delivery',
      },
      body,
    })
    expect(response.status).toBe(202)
    expect(dispatch).toHaveBeenCalledOnce()
  })
})
