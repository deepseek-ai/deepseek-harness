/**
 * Config-dump entry for `dsh --profile <name> --dump-config`: compose the
 * profile's patch layers through the include plugin's patch algorithm without
 * booting or evaluating `!!js`, with one source layer per bundle, the
 * profile's own patch file, and each `--patch` overlay.
 * @module @deepseek-ai/dsh/dump-config
 */

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  loadOptionalPatches,
  loadOverlayPatches,
  renderConfigDump,
  type ConfigDumpLayer,
} from '@deepseek-ai/dsh-app-boot'
import { homePatchPath, prepareProfile, PROFILE_ROOT_FILENAME } from './profile-boot.ts'

const NAME = 'dsh'

/* v8 ignore start -- built-bin acceptance drives this boot-free dispatch */
/**
 * Print a profile composition with comments naming each source file and patch layer.
 * @param profile - the profile name.
 * @param defaultOnly - omit the profile's user layer and `--patch` overlays
 * (the recovery diagnostic for a broken `cordis.patch.yml`, which is then
 * never parsed).
 * @param patches - `--patch` overlay paths, in argv order.
 * @param fromDefaultProfile - shipped template used once to initialize a missing profile.
 */
export function runDumpConfig(
  profile: string,
  defaultOnly: boolean,
  patches: readonly string[],
  fromDefaultProfile?: string,
): void {
  const loaded = prepareProfile(profile, !defaultOnly, fromDefaultProfile)
  const layers: ConfigDumpLayer[] = loaded.layers.map(layer => ({
    label: layer.packageName,
    patches: layer.patches,
  }))
  if (!defaultOnly) {
    if (existsSync(loaded.patchPath)) {
      layers.push({ label: loaded.patchPath, patches: loaded.patches })
    }
    const homePatchFile = homePatchPath()
    const homePatches = loadOptionalPatches(NAME, homePatchFile)
    if (homePatches !== undefined) {
      layers.push({ label: homePatchFile, patches: homePatches })
    }
    for (const file of patches) {
      const absolute = resolve(file)
      layers.push({ label: absolute, patches: loadOverlayPatches(NAME, absolute) })
    }
  }
  // The dump anchors on the same empty root file the boot includes.
  process.stdout.write(renderConfigDump(NAME, join(loaded.dir, PROFILE_ROOT_FILENAME), layers))
}
/* v8 ignore stop */
