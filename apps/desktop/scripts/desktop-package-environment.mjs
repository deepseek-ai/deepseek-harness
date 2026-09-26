/** Load platform-local release settings without changing the caller's process environment. */

import { accessSync, constants, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'
import { resolveDesktopAppId, resolveMacOSNotarizationEnvironment, resolveMacOSSigningEnvironment, resolveNpmRegistry } from './desktop-release-environment.mjs'
import { resolveDesktopAutoUpdateConfig } from './desktop-auto-update-environment.mjs'
import { createWindowsTokenSigner } from './windows-sign.mjs'
import { resolveDesktopPolicyEnvironment } from './desktop-policy-environment.mjs'
import { resolveMacOSPackageSettings } from './macos-package-settings.mjs'
import { resolveWindowsSignatureCacheDirectory } from './windows-signature-cache-directory.mjs'
import { resolveWindowsPackageSettings } from './windows-package-settings.mjs'

const APP_ROOT = fileURLToPath(new URL('..', import.meta.url))
const SHARED_SETTING = /^(?:DSH_DESKTOP_(?:APP_ID|AUTO_UPDATE_ENV|NPM_REGISTRY|MANDATORY_UPDATE_(?:CONFIG|(?:TEST|PROD)_ORIGIN))|DOWNLOAD_TEST_RELEASE_ID|DOWNLOAD_(?:TEST|PROD)_(?:ORIGIN|COS_BUCKET|COS_SECRET_ID|COS_SECRET_KEY))$/u
const WINDOWS_SETTING = /^DSH_DESKTOP_WINDOWS_(?:CER_FILE|SIGNTOOL|KEY_CONTAINER|TOKEN_PIN|SIGNATURE_CACHE_DIR|SIGNATURE_CACHE_CONCURRENCY)$/u
const MACOS_SETTING = /^(?:DSH_DESKTOP_MACOS_(?:SIGNING_IDENTITY|TEAM_ID|PACK_CONCURRENCY|DOWNLOAD_PROXY|NOTARIZATION_PROXY)|APPLE_(?:API_KEY|API_KEY_ID|API_ISSUER|ID|APP_SPECIFIC_PASSWORD|TEAM_ID|KEYCHAIN|KEYCHAIN_PROFILE)|CSC_(?:LINK|KEY_PASSWORD))$/u
const AMBIENT_RELEASE_SETTING = /^(?:DSH_DESKTOP_(?:APP_ID|AUTO_UPDATE_ENV|MANDATORY_UPDATE_.*|WINDOWS_.*|MACOS_.*)|APPLE_.*|(?:WIN_)?CSC_.*|DOWNLOAD_(?:TEST|PROD)_.*)$/iu
const FILE_SETTINGS = ['DSH_DESKTOP_WINDOWS_CER_FILE', 'DSH_DESKTOP_WINDOWS_SIGNTOOL', 'APPLE_API_KEY', 'APPLE_KEYCHAIN', 'CSC_LINK']

/**
 * Read the target's required UTF-8 dotenv file; release settings never fall back to ambient values.
 * @param {'win32' | 'darwin'} platform Target platform.
 * @param {NodeJS.ProcessEnv} environment Parent environment, retained only for unrelated build tools.
 * @param {string} appRoot Desktop application directory; relative credential paths resolve here.
 * @returns {NodeJS.ProcessEnv} Isolated environment with file-owned release settings.
 */
export function loadDesktopPackageEnvironment(platform, environment = process.env, appRoot = APP_ROOT) {
  const path = join(appRoot, platform === 'win32' ? '.env.windows' : '.env.macos')
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
  const platformSetting = platform === 'win32' ? WINDOWS_SETTING : MACOS_SETTING
  for (const name of Object.keys(settings)) {
    if (!SHARED_SETTING.test(name) && !platformSetting.test(name)) {
      throw new Error(`desktop package: unsupported setting ${name} in ${path}; use the platform template`)
    }
    if (settings[name].includes('\0')) throw new Error(`desktop package: ${name} cannot contain a NUL character`)
  }
  for (const name of FILE_SETTINGS) {
    if (settings[name]?.trim()) settings[name] = resolve(dirname(path), settings[name].trim())
  }
  return {
    ...Object.fromEntries(Object.entries(environment).filter(([name]) => !AMBIENT_RELEASE_SETTING.test(name))),
    ...settings,
  }
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
 * Validate release configuration before preparation without invoking a token or Apple's services.
 * @param {NodeJS.ProcessEnv} environment File-owned release settings.
 * @param {{ platform: 'win32' | 'darwin', arch: string }} target Selected release target.
 * @param {{ unsigned?: boolean, prepareOnly?: boolean }} options Explicit packaging mode.
 * @returns {void}
 */
export function validateDesktopPackageEnvironment(environment, target, options = {}) {
  resolveDesktopAppId(environment)
  resolveNpmRegistry(environment)
  resolveDesktopPolicyEnvironment(environment)
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
    resolveMacOSSigningEnvironment(environment)
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
    requireReadableFile(environment, 'CSC_LINK')
    if (environment.CSC_KEY_PASSWORD === undefined) {
      throw new Error('desktop package: CSC_KEY_PASSWORD must be set to the p12 export password (use an explicit empty value for an unencrypted p12)')
    }
  }
}
