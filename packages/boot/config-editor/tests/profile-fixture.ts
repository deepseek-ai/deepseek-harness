/** A real profile directory, root Include, Loader, and ConfigEditor, with probe plugins for rows. */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type Entry, type EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { initProfile, mountRootInclude, PROFILE_PATCH_FILENAME, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '../src/index.ts'

/** Module name of the probe row plugin: its `Config` rejects a config that sets `invalid`, and its start throws a config's `fail` text. */
export const PROBE = 'cordis:probe'

/** Module name of a row plugin that waits for a service no plugin provides. */
export const WAITING = 'cordis:waiting'

/** The profile patch of a new profile: the header comment above an empty patch list. */
export const TEMPLATE = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]
`

/** The header comment of {@link TEMPLATE}, which a profile patch with items keeps above its first item. */
export const HEADER = TEMPLATE.slice(0, -'[]\n'.length)

type ProbeConfig = Record<string, unknown>

/**
 * Boot a profile whose bundle inserts the given rows.
 * @param options - Bundle rows, and the texts of the profile patch and of the home patch written before boot; an
 * omitted profile patch is {@link TEMPLATE}.
 * @returns The booted context, the profile, the configs the probe plugin started with in start order, and readers
 * for one row, for the warnings logged so far, and for the profile patch.
 */
export async function editorProfile(options: { bundle?: EntryOptions[]; patch?: string; home?: string } = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-config-editor-')))
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  })
  const dir = join(home, 'profile')
  initProfile(dir, ['test-bundle'])
  const bundle = join(dir, 'node_modules', 'test-bundle')
  mkdirSync(bundle, { recursive: true })
  writeFileSync(join(home, 'package.json'), '{"name":"test-installation"}\n')
  writeFileSync(join(bundle, 'package.json'), JSON.stringify({ name: 'test-bundle', version: '1.0.0', dsh: { bundle: { patch: PROFILE_PATCH_FILENAME } } }))
  writeFileSync(join(bundle, PROFILE_PATCH_FILENAME), JSON.stringify([{ insert: options.bundle ?? [] }]))
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  const profile: ProfileContext = {
    name: 'test', startedBundles: ['test-bundle'], dir, patchPath: join(dir, PROFILE_PATCH_FILENAME),
    installAnchor: join(home, 'package.json'), cwd: home, home, overlayPaths: [], telemetryDisabledEnv: undefined,
  }
  writeFileSync(profile.patchPath, options.patch ?? TEMPLATE)
  if (options.home !== undefined) writeFileSync(join(home, PROFILE_PATCH_FILENAME), options.home)
  const starts: ProbeConfig[] = []
  ctx.baseUrl = pathToFileURL(home).href + '/'
  ctx.provide('profileContext', profile)
  await ctx.plugin(Loader)
  ctx.loader.builtins.probe = {
    name: 'probe',
    Config: { '~standard': {
      version: 1,
      vendor: 'dsh-config-editor-tests',
      validate: (value: ProbeConfig) => value.invalid === undefined ? { value } : { issues: [{ message: 'invalid is not a probe field' }] },
    } },
    apply(_ctx: Context, config: ProbeConfig) {
      if (typeof config.fail === 'string') throw new Error(config.fail)
      starts.push(config)
    },
  }
  ctx.loader.builtins.waiting = { name: 'waiting', inject: ['absentService'], apply() {} }
  await ctx.plugin(ConfigEditor)
  await mountRootInclude(ctx, join(dir, 'cordis.yml'), readProfilePatches('test', profile))
  await ctx.loader.await()
  return {
    ctx,
    profile,
    starts,
    row: (id: string): Entry => ctx.configEditor.entries().find(entry => entry.options.id === id)!,
    warnings: (): unknown[][] => ctx.logger.buffer.filter(message => message.type === 'warn').map((message): unknown[] => message.args),
    read: (): string => readFileSync(profile.patchPath, 'utf8'),
  }
}
