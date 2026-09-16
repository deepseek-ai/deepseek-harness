/** Boot a test overlay over the shipped profile bundle layers. */

import { writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import {
  boot,
  healProfilesModuleFallback,
  loadOverlayPatches,
  loadProfile,
  PluginPackages,
  type ProfileLayer,
} from '@deepseek-ai/dsh-app-boot'

const installAnchor = fileURLToPath(new URL('../../../../../apps/cli/package.json', import.meta.url))

function insertedPluginNames(entries: readonly EntryOptions[]): string[] {
  return entries.flatMap((entry) => {
    const children = entry.group && Array.isArray(entry.config)
      ? insertedPluginNames(entry.config as EntryOptions[])
      : []
    return [entry.name, ...children]
  })
}

function packageName(specifier: string): string | undefined {
  if (specifier.startsWith('.') || specifier.startsWith('file:') || specifier.includes(':')) return undefined
  const segments = specifier.split('/')
  return specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]
}

function overlayModuleLayers(path: string, patches: readonly PatchOptions[]): ProfileLayer[] {
  const require = createRequire(path)
  const packages = new Map<string, string>()
  const inserted = patches.flatMap(patch => patch.insert ?? [])
  for (const specifier of insertedPluginNames(inserted)) {
    const name = packageName(specifier)
    if (name === undefined || packages.has(name)) continue
    packages.set(name, dirname(require.resolve(`${name}/package.json`)))
  }
  return [...packages].map(([name, packageDir], index) => ({
    packageName: `test-overlay:${index}:${name}`,
    packageDir,
    patchPath: path,
    patches: [],
  }))
}

/** Inputs for {@link bootProductionProfile}. */
export interface ProductionProfileOptions {
  /** Diagnostic prefix for profile and Loader failures. */
  readonly binName: string
  /** Shipped profile whose bundle layers form the test tree. */
  readonly profile: string
  /** Test overlay files, named `*.patch.yml`, applied above the shipped bundle layers in order. */
  readonly overlayPaths: readonly string[]
  /** Optional host setup before any composed entry mounts. */
  readonly prepare?: (ctx: Context) => Promise<void> | void
}

/**
 * Load and compose one shipped profile with narrow test overlays.
 *
 * The helper owns no Cordis rows or defaults. Each overlay owns only the
 * test's provider, model, persistence directory, and subject-specific changes.
 * @param options - profile, overlay files, and optional host setup.
 * @returns the settled Loader root context.
 */
export async function bootProductionProfile(options: ProductionProfileOptions): Promise<Context> {
  for (const path of options.overlayPaths) {
    if (!path.endsWith('.patch.yml')) {
      throw new Error(`${options.binName}: test overlay path must end in .patch.yml: ${path}`)
    }
  }
  const profile = loadProfile(options.binName, options.profile, installAnchor, undefined, { userLayer: false })
  const rootConfig = join(profile.dir, 'cordis.yml')
  await writeFile(rootConfig, '[]\n')

  const overlays = options.overlayPaths.map(path => loadOverlayPatches(options.binName, path))
  // Overlay-only packages need profile module visibility in plain-Node mode,
  // but these synthetic layers do not contribute Cordis patches.
  const moduleLayers = options.overlayPaths.flatMap((path, index) => (
    overlayModuleLayers(path, overlays[index] ?? [])
  ))
  await healProfilesModuleFallback({
    installAnchor,
    profile: { ...profile, layers: [...profile.layers, ...moduleLayers] },
  })
  return boot(
    options.binName,
    rootConfig,
    [
      ...profile.layers.flatMap(layer => layer.patches),
      ...overlays.flat(),
    ],
    async (ctx) => {
      await ctx.plugin(PluginPackages, {})
      await options.prepare?.(ctx)
    },
  )
}
