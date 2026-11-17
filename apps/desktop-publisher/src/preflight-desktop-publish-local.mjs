/** Reject missing local publication configuration before dependency installation; never open credential files. */
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

async function readJson(path, subject) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    throw new Error(`desktop publish: ${subject} is missing, unreadable or invalid JSON: ${path}. Restore this file on the original runner, then retry publication; repackaging is not required.`)
  }
}

/**
 * Check the selected machine configuration without authorizing publication or reading secrets.
 * @param {NodeJS.ProcessEnv} env Selected package or approved route and machine directories.
 * @returns {Promise<void>} Resolves when the selected configuration is a readable JSON object; full validation remains in the publisher.
 */
export async function preflightDesktopPublishLocal(env) {
  const root = env.DSH_PACKAGING_CONFIG_DIR
  if (!root || !isAbsolute(root)) throw new Error('desktop publish: set DSH_PACKAGING_CONFIG_DIR to the absolute machine packaging configuration directory')
  let preset
  if (env.DESKTOP_PUBLISH_ROUTE) {
    preset = JSON.parse(env.DESKTOP_PUBLISH_ROUTE).preset
  } else {
    const selection = JSON.parse(env.DESKTOP_PACKAGE_SELECTION || '{}')
    const run = selection?.run
    if (!Number.isSafeInteger(run?.id) || run.id <= 0 || !Number.isSafeInteger(run?.run_attempt) || run.run_attempt <= 0) {
      throw new Error('desktop publish: selected package must identify a positive run ID and attempt')
    }
    const releases = env.DSH_DESKTOP_RELEASES_DIR || join(dirname(root), 'releases')
    if (!isAbsolute(releases)) throw new Error('desktop publish: DSH_DESKTOP_RELEASES_DIR must be absolute')
    const manifest = await readJson(join(releases, String(run.id), String(run.run_attempt), 'manifest.json'), 'retained package manifest')
    preset = manifest?.source?.preset
  }
  if (preset !== 'test' && preset !== 'production') throw new Error('desktop publish: selected package preset must be test or production')
  const path = join(root, 'publishing', `${preset}.json`)
  const config = await readJson(path, 'publication configuration')
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error(`desktop publish: publication configuration must be a JSON object: ${path}`)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  await preflightDesktopPublishLocal(process.env)
}
