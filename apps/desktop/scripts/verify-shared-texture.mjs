/** Verify Desktop's frame receiver and shared-texture addons on macOS and Windows. */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { matchingArchitecture } from './native-package-builds.mjs'

/**
 * Addons required by Desktop's texture transport.
 * @param {string} platform - Electron execution platform.
 * @returns {readonly string[]} Addon basenames without `.node`; empty on unsupported platforms.
 */
export function sharedTextureAddonNames(platform) {
  return platform === 'darwin' || platform === 'win32' ? ['shared-texture-hop', 'shared-texture-ingress', 'frame-forwarding'] : []
}

async function verifyAddon(directory, name, target) {
  const platform = `${target.platform}-${target.arch}`
  const addon = join(directory, `${name}.node`)
  if (!existsSync(addon)) throw new Error(`shared-texture: ${addon} is missing; run pnpm --filter @deepseek-ai/dsh-desktop run build:native --arch ${target.arch}`)
  const bytes = await readFile(addon)
  const record = JSON.parse(await readFile(join(directory, `${name}.json`), 'utf8'))
  if (record.platform !== platform || record.sha256 !== createHash('sha256').update(bytes).digest('hex')) {
    throw new Error(`shared-texture: ${addon} differs from its build record`)
  }
  if (!['x64', 'arm64'].includes(target.arch) || !matchingArchitecture(bytes, target)) throw new Error(`shared-texture: ${name} addon is not ${platform}`)
}

/**
 * Require the target's built addons, their build records, and their architecture.
 * @param {string} appDir - Desktop application directory containing `lib/`.
 * @param {{ platform: string, arch: string }} target - Electron execution target.
 * @returns {Promise<void>} Completion after presence, record, hash, and architecture checks.
 */
export async function verifySharedTextureAddons(appDir, target) {
  const directory = join(appDir, 'lib', 'native', `${target.platform}-${target.arch}`)
  for (const name of sharedTextureAddonNames(target.platform)) await verifyAddon(directory, name, target)
}
