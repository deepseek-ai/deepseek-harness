/** Profile schema generation: composition diagnostics, runtime resolution, and boot-free discovery. */

import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { composeEntries, createRuntimeResolution, type Profile } from '../profile.ts'
import { collectConfigSchemas } from './collect.ts'
import type { ConfigSchemaDiagnostic, ConfigSchemaDump } from './types.ts'
export type { ConfigSchemaDump, NativeConfigSchema } from './types.ts'

/**
 * Generate JSON Schema for a prepared profile's ordered patch layers without mounting plugins or evaluating expressions.
 * Imports, Config getters, and lazy builders execute trusted code. Native validators and
 * transform callbacks are not executed. Calls must not overlap another profile-resolution interception; collection
 * releases its interception on success or rejection, while Node retains imported modules. Supplied layers are not mutated.
 * Profile preparation, layer selection, process streams, and exit policy belong to the caller.
 * @param profile - prepared on-disk profile whose directory anchors root module and include resolution.
 * @param layers - already parsed patch lists in application order, including caller-selected home and argv overlays.
 * @param installAnchor - package manifest anchoring the installation's runtime dependencies.
 * @returns a JSON Schema document with declaration references, partial results, and diagnostics under `x-cordis`.
 * @throws when composition or runtime resolution cannot be prepared.
 */
export async function generateConfigSchema(
  profile: Profile,
  layers: readonly PatchOptions[][],
  installAnchor: string,
): Promise<ConfigSchemaDump> {
  const diagnostics: ConfigSchemaDiagnostic[] = []
  for (const { packageName } of profile.skippedBundles) {
    diagnostics.push({
      level: 'error',
      message: `Selected profile bundle ${JSON.stringify(packageName)} could not be loaded; repair or remove its bundle selection.`,
    })
  }
  const entries = composeEntries(layers, message => diagnostics.push({ level: 'warning', message }))
  const resolution = await createRuntimeResolution({ installAnchor, profile })
  return collectConfigSchemas(profile, entries, resolution, diagnostics)
}
