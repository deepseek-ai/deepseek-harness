/** Host Loader composition behavior. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import type { BrowserAuth } from '@deepseek-ai/dsh-client-connection/src/browser-auth.ts'
import open from 'open'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Inspector from '../src/index.ts'
import { INSPECTOR_BOOTSTRAP_PATH } from '../src/shared/web.ts'

vi.mock('open', () => ({ default: vi.fn(async () => undefined), apps: { chrome: 'chrome' } }))

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  vi.clearAllMocks()
})

describe('experimental Inspector through a real Loader composition', () => {
  it.each([false, true])('starts inspection with --inspect=%s and opens Chrome only when requested', async (flag) => {
    root = await mkdtemp(join(tmpdir(), 'dsh-inspector-loader-'))
    const configPath = join(root, 'cordis.yml')
    const entries = composeEntries([loadOverlayPatches('dsh', fileURLToPath(
      new URL('../../inspector-profile/cordis.patch.yml', import.meta.url),
    ))])
    const inspector = entries.find(entry => entry.id === 'experimental-inspector')!
    await writeFile(configPath, JSON.stringify([
      { name: '@deepseek-ai/dsh-host-webserver', config: { host: '127.0.0.1', port: 0 } },
      { name: 'fixture:connection' },
    ]))

    context = new Context()
    context.provide('cmdlineArgs', { get: () => flag ? ['--inspect'] : [] })
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    expect('default' in Inspector).toBe(false)
    const plugin = context.loader.unwrapExports(Inspector) as Record<string, unknown>
    expect(plugin).toMatchObject({
      name: Inspector.name,
      inject: Inspector.inject,
      Config: Inspector.Config,
      apply: Inspector.apply,
    })
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-host-webserver', WebServer],
      ['fixture:connection', (ctx: Context) => { new HostConnectionService(ctx, [], {} as BrowserAuth) }],
      ['@deepseek-ai/dsh-experimental-inspector', Inspector],
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
      config: {
        path: pathToFileURL(configPath).href,
        patches: [{ insert: [inspector] }, { id: 'experimental-inspector', config: { port: 0, captureFetch: false } }],
      },
    })
    await context.loader.await()

    expect([...context.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled))
      .toEqual([])
    const inspectorEntry = [...context.loader.entries()]
      .find(entry => entry.options.name === '@deepseek-ai/dsh-experimental-inspector')
    expect(inspectorEntry?.disabled).toBe(false)
    expect(open).toHaveBeenCalledTimes(flag ? 1 : 0)
    const api = (context.connection as HostConnectionService).createSharedFetchHandler('/api')
    expect(inspectorEntry?.fiber).toBeDefined()
    await vi.waitFor(async () => {
      expect((await context!.inspector.cordis.getTree()).host?.source.kind).toBe('host')
    })
    const bootstrap = await api.fetch(new Request(`http://localhost${INSPECTOR_BOOTSTRAP_PATH}`))
    expect(await bootstrap.json()).toHaveProperty('endpoint', expect.stringContaining('/ingest'))

    await inspectorEntry!.fiber!.dispose()
    expect(context.get('inspector')).toBeUndefined()
  })
})
