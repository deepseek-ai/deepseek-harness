/** Host Loader composition behavior. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Inspector from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('experimental Inspector through a real Loader composition', () => {
  it('mounts the bundle patch over a Web server row and releases its endpoint', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-inspector-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-host-webserver'",
      '  config:',
      "    host: '127.0.0.1'",
      '    port: 0',
      '',
    ].join('\n'))
    // The shipped bundle patch inserts the row by package name under a stable id; a later
    // profile patch configures that id, as the Plugins page and a `--patch` overlay do.
    const bundlePatches = loadOverlayPatches('test', fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)))
    expect(bundlePatches.flatMap(patch => patch.insert ?? [])).toEqual([
      { id: 'experimental-inspector', name: '@deepseek-ai/dsh-experimental-inspector' },
    ])

    context = new Context()
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
        patches: [...bundlePatches, { id: 'experimental-inspector', config: { port: 0, captureFetch: false } }],
      },
    })
    await context.loader.await()

    expect([...context.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled))
      .toEqual([])
    await vi.waitFor(async () => {
      expect((await context!.inspector.cordis.getTree()).host?.source.kind).toBe('host')
    })

    const inspectorEntry = [...context.loader.entries()]
      .find(entry => entry.options.name === '@deepseek-ai/dsh-experimental-inspector')
    expect(inspectorEntry?.fiber).toBeDefined()
    await inspectorEntry!.fiber!.dispose()
    expect(context.get('inspector')).toBeUndefined()
  })
})
