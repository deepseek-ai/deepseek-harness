/** Compose the adapter through a real profile: Loader, bundle, profile and home patches, reload coordination, and Settings. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import Loader, { type EntryOptions, type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include, { stringifyEntryYaml, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { readProfilePatches, reconcileProfilePatches } from '@deepseek-ai/dsh-app-boot'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import * as ProviderRow from '@deepseek-ai/dsh-llm-pi-ai/provider'
import { profileComposition } from '../../../settings/settings/tests/profile-composition.ts'

/** Module name of the adapter row. */
export const ADAPTER = '@deepseek-ai/dsh-llm-pi-ai'
/** Module name of a provider row. */
export const PROVIDER = '@deepseek-ai/dsh-llm-pi-ai/provider'
/** Entry id of the adapter row, which is the settings namespace of its `providers` dict. */
export const NS = 'llm-pi-ai'

/** A Loader module importer that answers the given module names with source modules and refuses every other one.
 * @param modules Source modules by the name a row gives them.
 * @returns The importer to install as `ctx.loader.internal`.
 */
export function sourceModules(modules: ReadonlyMap<string, unknown>): ModuleLoaderV2 {
  return {
    version: 'v2',
    loadCache: new Map(),
    import: (specifier: string) => {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return Promise.resolve(modules.get(specifier))
    },
    register(): never { throw new Error('unexpected module hook registration') },
    getOrCreateModuleJob(): never { throw new Error('unexpected module job creation') },
    resolveSync(): never { throw new Error('unexpected synchronous module resolution') },
    load(): never { throw new Error('unexpected module load') },
  }
}

/** Mount a profile whose bundle holds the adapter row, over the patch files a test stores first.
 * @param ctx Fresh context; services mounted on it before this call are visible to the rows.
 * @param home Empty directory for the profile, which also stands for the Harness home.
 * @param files The profile's own patch, the home patch, and bundle rows placed before the adapter row.
 * @returns The two patch paths and a reload that applies their current content.
 */
export async function composeProfile(
  ctx: Context, home: string,
  files: { profile?: PatchOptions[]; deployment?: PatchOptions[]; rows?: readonly Omit<EntryOptions, 'id'>[] } = {},
) {
  const homePatch = join(home, 'cordis.patch.yml')
  if (files.deployment !== undefined) await writeFile(homePatch, stringifyEntryYaml(files.deployment))
  const baseFile = join(home, 'cordis.yml')
  await writeFile(baseFile, stringifyEntryYaml([...files.rows ?? [], { id: NS, name: ADAPTER }]))
  ctx.baseUrl = pathToFileURL(home).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = sourceModules(new Map<string, unknown>([[ADAPTER, LlmPiAi], [PROVIDER, ProviderRow]]))
  // The profile runtime keeps a patch file it finds, so the stored patch is written before the profile mounts.
  const stored = join(home, 'profile', 'cordis.patch.yml')
  await mkdir(join(home, 'profile'), { recursive: true })
  await writeFile(stored, stringifyEntryYaml(files.profile ?? []))
  const patchPath = await profileComposition(ctx, home, baseFile)
  if (patchPath !== stored) throw new Error(`the profile mounted ${patchPath}, not the stored patch ${stored}`)
  return {
    patchPath,
    homePatch,
    /** Apply the stored patch files to the running composition, as the reload coordinator does after a file changes. */
    reload: (): Promise<void> =>
      ctx.hmr.runExclusive(async () => { await reconcileProfilePatches(ctx, readProfilePatches('test', ctx.profileContext), 'test') }),
  }
}
