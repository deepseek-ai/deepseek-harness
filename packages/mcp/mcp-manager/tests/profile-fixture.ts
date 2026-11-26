/** Manager configuration and server rows through a real profile, ConfigEditor, and Loader. */
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { onTestFinished } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import Loader, { type Entry, type EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { initProfile, mountRootInclude, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import Settings from '@deepseek-ai/dsh-settings'
import McpServerManager from '../src/index.ts'
import * as McpServerRow from '../src/server-row.ts'

/**
 * Build the Loader row that declares one managed server.
 * @param serverName - Server name; the row id is `mcp-server-<serverName>`.
 * @param entry - The server's entry fields.
 * @returns Row options for a bundle patch or a profile patch `insert`.
 */
export function serverRow(serverName: string, entry: object): EntryOptions {
  return { id: `mcp-server-${serverName}`, name: 'cordis:mcp-manager-server', config: { ...entry, serverName } }
}

/**
 * Find one row of the booted profile.
 * @param ctx - Context a {@link managerProfile} start booted.
 * @param id - Row id.
 * @returns The row's Loader entry.
 */
export function profileRow(ctx: Context, id: string): Entry {
  return ctx.configEditor.entries().find(entry => entry.options.id === id)!
}

/**
 * Mount the manager and inherited server rows from a bundle, under an optional profile patch.
 * @param ctx - Test context carrying tools and optional credentials.
 * @param options - Manager entry id, its base configuration and profile override, inherited server rows by name, and
 *   further profile patch items written after the override.
 * @returns The profile, the manager entry owned by the test, and a second boot of the same profile.
 */
export async function managerProfile(
  ctx: Context,
  options: { id?: string; base?: unknown; user?: unknown; rows?: Record<string, object>; patch?: unknown[] } = {},
) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-mcp-manager-')))
  const contexts: Context[] = []
  onTestFinished(async () => {
    for (const context of contexts) await context.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  })
  const dir = join(home, 'profile')
  initProfile(dir, ['test-mcp-bundle'])
  const bundle = join(dir, 'node_modules', 'test-mcp-bundle')
  mkdirSync(bundle, { recursive: true })
  writeFileSync(join(home, 'package.json'), '{"name":"test-installation"}\n')
  writeFileSync(join(bundle, 'package.json'), JSON.stringify({ name: 'test-mcp-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
  const id = options.id ?? 'mcp'
  writeFileSync(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id, name: 'cordis:mcp-manager', config: options.base ?? {} },
    ...Object.entries(options.rows ?? {}).map(([serverName, entry]) => serverRow(serverName, entry)),
  ] }]))
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  const profile: ProfileContext = {
    name: 'test', startedBundles: ['test-mcp-bundle'], dir, patchPath: join(dir, 'cordis.patch.yml'),
    installAnchor: join(home, 'package.json'), cwd: home, home, overlayPaths: [], telemetryDisabledEnv: undefined,
  }
  const patches = [...options.user === undefined ? [] : [{ id, config: options.user }], ...options.patch ?? []]
  if (patches.length > 0) writeFileSync(profile.patchPath, JSON.stringify(patches))
  const start = async (context: Context) => {
    contexts.push(context)
    context.baseUrl = pathToFileURL(home).href + '/'
    context.provide('profileContext', profile)
    await context.plugin(Loader)
    context.loader.builtins['mcp-manager'] = McpServerManager
    context.loader.builtins['mcp-manager-server'] = McpServerRow
    await context.plugin(ConfigEditor)
    await context.plugin(Settings)
    await mountRootInclude(context, join(dir, 'cordis.yml'), readProfilePatches('test', profile))
    await context.loader.await()
    return profileRow(context, id)
  }
  return { profile, entry: await start(ctx), start }
}
