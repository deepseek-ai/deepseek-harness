/** Select local test defaults or platform release settings without changing the caller's environment. */

import { accessSync, constants, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'
import { resolveDesktopAppId, resolveMacOSNotarizationEnvironment, resolveMacOSSigningEnvironment, resolveNpmRegistry } from './desktop-release-environment.mjs'
import { resolveDesktopAutoUpdateConfig } from './desktop-auto-update-environment.mjs'
import { createWindowsTokenSigner } from './windows-sign.mjs'
import { resolveDesktopPolicyEnvironment } from './desktop-policy-environment.mjs'
import { validateMacOSSignatureCacheDirectory } from './macos-signature-cache-directory.mjs'
import { resolveMacOSPackageSettings } from './macos-package-settings.mjs'
import { resolveWindowsSignatureCacheDirectory } from './windows-signature-cache-directory.mjs'
import { resolveWindowsPackageSettings } from './windows-package-settings.mjs'
import { resolveDesktopTargetBuildPaths } from './desktop-build-paths.mjs'

const APP_ROOT = fileURLToPath(new URL('..', import.meta.url))
const SHARED_SETTING = /^(?:DSH_DESKTOP_(?:APP_ID|AUTO_UPDATE_ENV|NPM_REGISTRY|MANDATORY_UPDATE_(?:CONFIG|(?:TEST|PROD)_ORIGIN))|DOWNLOAD_TEST_RELEASE_ID|DOWNLOAD_PROD_EO_ZONE_ID|DOWNLOAD_(?:TEST|PROD)_(?:ORIGIN|COS_BUCKET|COS_SECRET_ID|COS_SECRET_KEY))$/u
const WINDOWS_SETTING = /^DSH_DESKTOP_WINDOWS_(?:CER_FILE|SIGNTOOL|KEY_CONTAINER|TOKEN_PIN|SIGNATURE_CACHE_DIR|SIGNATURE_CACHE_CONCURRENCY|PACK_CONCURRENCY|COMPRESSION_LEVEL)$/u
const MACOS_SETTING = /^(?:DSH_DESKTOP_MACOS_(?:SIGNING_IDENTITY|TEAM_ID|SIGNATURE_CACHE_DIR|PACK_CONCURRENCY|ZIP_COMPRESSION_LEVEL|DOWNLOAD_PROXY|NOTARIZATION_PROXY)|APPLE_(?:API_KEY|API_KEY_ID|API_ISSUER|ID|APP_SPECIFIC_PASSWORD|TEAM_ID|KEYCHAIN|KEYCHAIN_PROFILE)|CSC_(?:LINK|KEY_PASSWORD))$/u
const AMBIENT_RELEASE_SETTING = /^(?:DSH_DESKTOP_(?:APP_ID|AUTO_UPDATE_ENV|MANDATORY_UPDATE_.*|WINDOWS_.*|MACOS_.*)|APPLE_.*|(?:WIN_)?CSC_.*|DOWNLOAD_(?:TEST|PROD)_.*)$/iu
const FILE_SETTINGS = ['DSH_DESKTOP_WINDOWS_CER_FILE', 'DSH_DESKTOP_WINDOWS_SIGNTOOL', 'APPLE_API_KEY', 'APPLE_KEYCHAIN', 'CSC_LINK']

/**
 * Select local macOS test defaults without reading dotenv files or inheriting release settings.
 * @param {NodeJS.ProcessEnv} environment Parent environment, retained for build tools and networking.
 * @returns {NodeJS.ProcessEnv} Unsigned build environment with the standard application identifier and no update policy.
 */
export function localMacOSPackageEnvironment(environment = process.env) {
  return {
    ...Object.fromEntries(Object.entries(environment).filter(([name]) => !AMBIENT_RELEASE_SETTING.test(name))),
    DSH_DESKTOP_APP_ID: 'com.deepseek.harness',
    DSH_DESKTOP_UNSIGNED: '1',
  }
}

/**
 * Read a machine preset when selected, otherwise the target's required dotenv; no ambient release fallback.
 * PACKAGE_MACOS_ZIP_COMPRESSION_LEVEL overrides the Mac file setting with 3 or 7; an empty value is invalid.
 * Any defined Mac ZIP override rejects Windows, including an empty value; nonempty Windows overrides reject macOS.
 * PACKAGE_TEST_RELEASE_ID overrides the test preset only; blank retains its configured ID.
 * PACKAGE_WINDOWS_COMPRESSION_LEVEL selects 3 or 7 for Windows workflow builds; blank retains the file setting.
 * @param {'win32' | 'darwin'} platform Target platform.
 * @param {NodeJS.ProcessEnv} environment Parent environment, retained only for unrelated build tools.
 * @param {string} appRoot Desktop application directory; relative credential paths resolve here.
 * @param {{ unsigned?: boolean, prepareOnly?: boolean }} options Unsigned presets and Windows preparation-only presets never read signing credentials.
 * @returns {NodeJS.ProcessEnv} Isolated environment with file-owned release settings.
 */
export function loadDesktopPackageEnvironment(platform, environment = process.env, appRoot = APP_ROOT, options = {}) {
  const compression = environment.PACKAGE_WINDOWS_COMPRESSION_LEVEL
  if (compression !== undefined && compression !== '') {
    if (platform !== 'win32' || !['3', '7'].includes(compression)) {
      throw new Error('desktop package: PACKAGE_WINDOWS_COMPRESSION_LEVEL requires Windows and a choice of 3 or 7')
    }
  }
  const zipCompression = environment.PACKAGE_MACOS_ZIP_COMPRESSION_LEVEL
  if (zipCompression !== undefined) {
    if (platform !== 'darwin') throw new Error('desktop package: PACKAGE_MACOS_ZIP_COMPRESSION_LEVEL requires macOS')
    if (!['3', '7'].includes(zipCompression)) throw new Error('desktop package: workflow ZIP compression must be 3 or 7')
  }
  const preset = environment.DSH_PACKAGING_PRESET
  let path = join(appRoot, platform === 'win32' ? '.env.windows' : '.env.macos')
  if (preset !== undefined) {
    if (preset !== 'test' && preset !== 'production') throw new Error('desktop package: preset must be test or production')
    const root = environment.DSH_PACKAGING_CONFIG_DIR
    if (!root || !isAbsolute(root)) throw new Error('desktop package: DSH_PACKAGING_CONFIG_DIR must be an absolute directory')
    path = join(root, 'presets', `${preset}.env`)
  }
  const platformSetting = platform === 'win32' ? WINDOWS_SETTING : MACOS_SETTING
  const publicPlatformSetting = platform === 'win32'
    ? /^DSH_DESKTOP_WINDOWS_(?:SIGNATURE_CACHE_(?:DIR|CONCURRENCY)|PACK_CONCURRENCY|COMPRESSION_LEVEL)$/u
    : /^DSH_DESKTOP_MACOS_(?:SIGNATURE_CACHE_DIR|PACK_CONCURRENCY|ZIP_COMPRESSION_LEVEL|DOWNLOAD_PROXY|NOTARIZATION_PROXY)$/u
  const settings = readSettings(path, name => preset === undefined
    ? SHARED_SETTING.test(name) || platformSetting.test(name)
    : /^(?:DSH_DESKTOP_(?:APP_ID|AUTO_UPDATE_ENV|NPM_REGISTRY|MANDATORY_UPDATE_(?:CONFIG|(?:TEST|PROD)_ORIGIN))|DOWNLOAD_TEST_(?:ORIGIN|RELEASE_ID))$/u.test(name) || publicPlatformSetting.test(name))
  if (preset !== undefined) {
    if (settings.DSH_DESKTOP_AUTO_UPDATE_ENV !== preset) throw new Error('desktop package: preset deployment must match its name')
    if (!options.unsigned && (platform === 'darwin' || !options.prepareOnly)) {
      const filename = platform === 'win32' ? 'windows-signing.env' : 'macos-signing.env'
      Object.assign(settings, readSettings(join(dirname(dirname(path)), 'secrets', filename),
        name => platform === 'win32'
          ? /^DSH_DESKTOP_WINDOWS_(?:CER_FILE|SIGNTOOL|KEY_CONTAINER|TOKEN_PIN)$/u.test(name)
          : MACOS_SETTING.test(name) && !publicPlatformSetting.test(name)))
    }
  }
  if (compression !== undefined && compression !== '') settings.DSH_DESKTOP_WINDOWS_COMPRESSION_LEVEL = compression
  if (zipCompression !== undefined) {
    settings.DSH_DESKTOP_MACOS_ZIP_COMPRESSION_LEVEL = zipCompression
  }
  const releaseId = environment.PACKAGE_TEST_RELEASE_ID?.trim()
  if (releaseId) {
    if (preset !== 'test') throw new Error('desktop package: test release ID override requires the test preset')
    if (!/^[a-f0-9]{32}$/u.test(releaseId)) throw new Error('desktop package: test release ID must contain 32 lowercase hexadecimal characters')
    settings.DOWNLOAD_TEST_RELEASE_ID = releaseId
  }
  return {
    ...Object.fromEntries(Object.entries(environment).filter(([name]) => !AMBIENT_RELEASE_SETTING.test(name))),
    ...settings,
    ...(environment.DSH_DESKTOP_UPDATE_CHANNEL === undefined ? {} : { DSH_DESKTOP_UPDATE_CHANNEL: environment.DSH_DESKTOP_UPDATE_CHANNEL }),
    ...(preset === undefined ? {} : { DSH_PACKAGING_PRESET: preset }),
  }
}

/**
 * Read an explicitly selected dotenv without exposing credential-bearing parser errors.
 * @param {string} path Selected file; relative file settings resolve beside it.
 * @param {(name: string) => boolean} accepts Whether this file may declare a setting.
 * @returns {NodeJS.ProcessEnv} Validated file settings.
 */
function readSettings(path, accepts) {
  let contents
  try {
    contents = readFileSync(path, 'utf8')
  }
  catch {
    throw new Error(`desktop package: cannot read ${path}; copy ${path}.example and fill in the local settings`)
  }
  let settings
  try {
    settings = parseEnv(contents.replace(/^\uFEFF/u, ''))
  }
  catch {
    // Parser diagnostics can contain credential-bearing input.
    throw new Error(`desktop package: invalid dotenv syntax in ${path}`)
  }
  for (const name of Object.keys(settings)) {
    if (!accepts(name)) {
      throw new Error(`desktop package: unsupported setting ${name} in ${path}; use the platform template`)
    }
    if (settings[name].includes('\0')) throw new Error(`desktop package: ${name} cannot contain a NUL character`)
  }
  for (const name of FILE_SETTINGS) {
    if (settings[name]?.trim()) settings[name] = resolve(dirname(path), settings[name].trim())
  }
  return settings
}

function requireReadableFile(environment, name) {
  try {
    if (!statSync(environment[name]).isFile()) throw new Error('not a file')
    accessSync(environment[name], constants.R_OK)
  }
  catch {
    throw new Error(`desktop package: ${name} must identify a readable local file`)
  }
}

/**
 * Validate the packaging mode before preparation without invoking a token or Apple's services.
 * @param {NodeJS.ProcessEnv} environment Selected local defaults or file-owned release settings.
 * @param {{ platform: 'win32' | 'darwin', arch: string }} target Selected release target.
 * @param {{ unsigned?: boolean, prepareOnly?: boolean, skipNotarization?: boolean }} options Explicit packaging mode.
 * @returns {void}
 */
export function validateDesktopPackageEnvironment(environment, target, options = {}) {
  resolveDesktopTargetBuildPaths(environment, target.platform, target.arch)
  resolveDesktopAppId(environment)
  resolveNpmRegistry(environment)
  if (target.platform !== 'darwin' || !options.unsigned) resolveDesktopPolicyEnvironment(environment)
  if (target.platform === 'darwin') resolveMacOSPackageSettings(environment)
  else resolveWindowsPackageSettings(environment)
  if (options.unsigned) return
  if (!options.prepareOnly) resolveDesktopAutoUpdateConfig(environment, target.platform, target.arch)
  if (target.platform === 'win32') {
    if (!options.prepareOnly) createWindowsTokenSigner({
      certificateFile: environment.DSH_DESKTOP_WINDOWS_CER_FILE,
      signTool: environment.DSH_DESKTOP_WINDOWS_SIGNTOOL,
      tokenPin: environment.DSH_DESKTOP_WINDOWS_TOKEN_PIN,
      keyContainer: environment.DSH_DESKTOP_WINDOWS_KEY_CONTAINER,
    })
    if (!options.prepareOnly) resolveWindowsSignatureCacheDirectory(environment)
  } else {
    if (environment.DSH_DESKTOP_MACOS_SIGNATURE_CACHE_DIR !== undefined) validateMacOSSignatureCacheDirectory(environment.DSH_DESKTOP_MACOS_SIGNATURE_CACHE_DIR)
    resolveMacOSSigningEnvironment(environment)
    if (!options.skipNotarization) {
      const strategies = [
        ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'],
        ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'],
        ['APPLE_KEYCHAIN_PROFILE', 'APPLE_KEYCHAIN'],
      ]
      if (strategies.filter(names => names.some(name => environment[name] !== undefined)).length > 1) {
        throw new Error('desktop package: configure exactly one macOS notarization strategy; comment out the other strategies')
      }
      const credentials = resolveMacOSNotarizationEnvironment(environment)
      if ('appleApiKey' in credentials) requireReadableFile(environment, 'APPLE_API_KEY')
      if ('keychain' in credentials) requireReadableFile(environment, 'APPLE_KEYCHAIN')
    }
    requireReadableFile(environment, 'CSC_LINK')
    if (environment.CSC_KEY_PASSWORD === undefined) {
      throw new Error('desktop package: CSC_KEY_PASSWORD must be set to the p12 export password (use an explicit empty value for an unencrypted p12)')
    }
  }
}
