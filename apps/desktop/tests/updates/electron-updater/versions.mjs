/** Installed dependency versions and platform-specific qualification records. */
import { createRequire } from 'node:module'
import { readFile, writeFile, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

const require = createRequire(import.meta.url)
const recordUrl = new URL('./verified-versions.json', import.meta.url)

/** @returns The actual installed versions, without loading the Electron binary. */
export function installedVersions() {
  const updaterRequire = createRequire(require.resolve('electron-updater/package.json'))
  return {
    electron: require('electron/package.json').version,
    'electron-updater': require('electron-updater/package.json').version,
    'builder-util-runtime': updaterRequire('builder-util-runtime/package.json').version,
  }
}

/**
 * @param records - Parsed platform records.
 * @param installed - Actual installed dependency versions.
 * @returns Missing or mismatched platform records.
 */
export function versionFailures(records, installed) {
  return ['windows', 'macos'].filter(platform => {
    const record = records?.[platform]
    return !record || Object.keys(record).length !== Object.keys(installed).length
      || Object.entries(installed).some(([name, version]) => record[name] !== version)
  })
}

/** @returns Persisted platform qualification records. */
export async function readVerifiedVersions() {
  return JSON.parse(await readFile(recordUrl, 'utf8'))
}

/**
 * Record only the current platform after successful native qualification.
 * @returns After atomically replacing the record file.
 */
export async function recordVerifiedVersions() {
  const platform = { win32: 'windows', darwin: 'macos' }[process.platform]
  if (!platform) throw new Error('Qualification records require Windows or macOS')
  const records = await readVerifiedVersions()
  records[platform] = installedVersions()
  const temporary = new URL(`./verified-versions.${randomUUID()}.tmp`, import.meta.url)
  try {
    await writeFile(temporary, `${JSON.stringify(records, null, 2)}\n`, { flag: 'wx' })
    await rename(temporary, recordUrl)
  } finally {
    await rm(temporary, { force: true })
  }
}
