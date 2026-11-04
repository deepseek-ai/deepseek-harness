/** Manager configuration through a real profile, ConfigEditor, and Loader. */
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { onTestFinished } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { initProfile, mountRootInclude, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import Settings from '@deepseek-ai/dsh-settings'
import McpServerManager from '../src/index.ts'

/**
 * Mount the manager from an inherited bundle and optional user patch.
 * @param ctx - Test context carrying tools and optional credentials.
 * @param options - Manager entry id, base configuration, and user overrides.
 * @returns The profile and manager entry owned by the test.
 */
export async function managerProfile(ctx: Context, options: { id?: string; base?: unknown; user?: unknown } = {}) {
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
  ] }]))
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  const profile: ProfileContext = {
    name: 'test', startedBundles: ['test-mcp-bundle'], dir, patchPath: join(dir, 'cordis.patch.yml'),
    installAnchor: join(home, 'package.json'), cwd: home, home, overlays: [], telemetryDisabledEnv: undefined,
  }
  if (options.user !== undefined) writeFileSync(profile.patchPath, JSON.stringify([{ id, config: options.user }]))
  const start = async (context: Context) => {
    contexts.push(context)
    context.baseUrl = pathToFileURL(home).href + '/'
    context.provide('profileContext', profile)
    await context.plugin(Loader)
    context.loader.builtins['mcp-manager'] = McpServerManager
    await context.plugin(ConfigEditor)
    await context.plugin(Settings)
    await mountRootInclude(context, join(dir, 'cordis.yml'), readProfilePatches('test', profile))
    await context.loader.await()
    return context.configEditor.entries().find(entry => entry.options.id === id)!
  }
  return { profile, entry: await start(ctx), start }
}
