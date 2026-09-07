/** Sign seed code and verify that packaged macOS artifacts carry the company release identity. */

import { spawn, spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { resolveMacOSSigningEnvironment } from './desktop-release-environment.mjs'

/**
 * Reject signature metadata that does not name the company release authority and team.
 * @param {string} details - Output from `codesign --display --verbose=4`.
 * @param {{ signingIdentity: string, teamId: string }} expected - Public release identity.
 * @returns {void}
 */
export function assertMacOSSignatureDetails(details, expected) {
  const fields = new Set(details.split(/\r?\n/u).map(line => line.trim()))
  const expectedAuthority = `Authority=Developer ID Application: ${expected.signingIdentity}`
  const expectedTeam = `TeamIdentifier=${expected.teamId}`
  const missing = [expectedAuthority, expectedTeam].filter(field => !fields.has(field))
  if (missing.length > 0) {
    throw new Error(`desktop macOS signing: signature does not match the release identity; missing ${missing.join(', ')}`)
  }
}

/**
 * Require the signature properties Apple validates for executable seed content.
 * @param {string} details - Output from `codesign --display --verbose=4`.
 * @param {{ signingIdentity: string, teamId: string }} expected - Public release identity.
 * @returns {void}
 */
export function assertMacOSSeedSignatureDetails(details, expected) {
  assertMacOSSignatureDetails(details, expected)
  const fields = details.split(/\r?\n/u).map(line => line.trim())
  if (!fields.some(line => /^Timestamp=.+/u.test(line))) {
    throw new Error('desktop macOS signing: seed signature has no secure timestamp')
  }
  if (!fields.some(line => /\bflags=0x[0-9a-f]+\(runtime\)(?:\s|$)/iu.test(line))) {
    throw new Error('desktop macOS signing: seed signature does not enable hardened runtime')
  }
}

/**
 * Execute one Apple release tool and return its diagnostic streams.
 * @param {string} command - Absolute executable path.
 * @param {readonly string[]} args - Tool arguments.
 * @param {string} label - Stable diagnostic name.
 * @returns {string} Combined stdout and stderr.
 */
function runAppleCommand(command, args, label) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.error !== undefined) {
    throw new Error(`desktop macOS signing: could not execute ${label}: ${result.error.message}`)
  }
  if (result.signal !== null) {
    throw new Error(`desktop macOS signing: ${label} was terminated by ${result.signal}`)
  }
  if (result.status !== 0) {
    const diagnostic = `${result.stdout}${result.stderr}`.trim()
    throw new Error(`desktop macOS signing: ${label} exited with ${String(result.status)}${diagnostic === '' ? '' : `: ${diagnostic}`}`)
  }
  return `${result.stdout}${result.stderr}`
}

/**
 * Execute one Apple release tool without blocking other independent seed signers.
 * @param {string} command - Absolute executable path.
 * @param {readonly string[]} args - Tool arguments.
 * @param {string} label - Stable diagnostic name.
 * @returns {Promise<string>} Combined stdout and stderr after process exit.
 */
function runAppleCommandAsync(command, args, label) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let spawnError
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', error => { spawnError = error })
    child.once('close', (code, signal) => {
      if (spawnError !== undefined) {
        reject(new Error(`desktop macOS signing: could not execute ${label}: ${spawnError.message}`))
        return
      }
      if (signal !== null) {
        reject(new Error(`desktop macOS signing: ${label} was terminated by ${signal}`))
        return
      }
      if (code !== 0) {
        const diagnostic = `${stdout}${stderr}`.trim()
        reject(new Error(`desktop macOS signing: ${label} exited with ${String(code)}${diagnostic === '' ? '' : `: ${diagnostic}`}`))
        return
      }
      resolvePromise(`${stdout}${stderr}`)
    })
  })
}

/**
 * Execute Apple's code-signing tool and return its diagnostic streams.
 * @param {readonly string[]} args - Arguments passed to `/usr/bin/codesign`.
 * @returns {string} Combined stdout and stderr.
 */
function runCodeSign(args) {
  return runAppleCommand('/usr/bin/codesign', args, 'codesign')
}

/**
 * Sign one Mach-O file embedded in the seed store.
 * @param {string} path - Writable standalone Mach-O file.
 * @param {string} identifier - Stable code-signing identifier derived from the release app ID and CAS digest.
 * @param {{ signingIdentity: string, teamId: string }} expected - Public release identity.
 * @returns {Promise<void>} Resolves after codesign exits successfully.
 */
export async function signMacOSSeedCode(path, identifier, expected) {
  await runAppleCommandAsync('/usr/bin/codesign', [
    '--force',
    '--sign', expected.signingIdentity,
    '--identifier', identifier,
    '--timestamp',
    '--options', 'runtime',
    path,
  ], 'codesign')
}

/**
 * Verify one Mach-O file embedded in the seed store.
 * @param {string} path - Mach-O file to inspect.
 * @param {{ signingIdentity: string, teamId: string }} expected - Public release identity.
 * @returns {void}
 */
export function verifyMacOSSeedCode(path, expected) {
  runCodeSign(['--verify', '--strict', '--verbose=2', path])
  const details = runCodeSign(['--display', '--verbose=4', path])
  assertMacOSSeedSignatureDetails(details, expected)
}

/**
 * Verify the full application signature and its release owner.
 * @param {string} appPath - Path to the packaged `.app` directory.
 * @param {{ signingIdentity: string, teamId: string }} expected - Public release identity.
 * @returns {void}
 */
export function verifyMacOSSignature(appPath, expected) {
  runCodeSign(['--verify', '--deep', '--strict', '--verbose=2', appPath])
  const details = runCodeSign(['--display', '--verbose=4', appPath])
  assertMacOSSignatureDetails(details, expected)
}

/**
 * Verify the release identity, stapled ticket, and Gatekeeper acceptance of one disk image.
 * @param {string} diskImagePath - Path to the packaged `.dmg` file.
 * @param {{ signingIdentity: string, teamId: string }} expected - Public release identity.
 * @returns {void}
 */
export function verifyMacOSDiskImage(diskImagePath, expected) {
  runCodeSign(['--verify', '--strict', '--verbose=2', diskImagePath])
  const details = runCodeSign(['--display', '--verbose=4', diskImagePath])
  assertMacOSSignatureDetails(details, expected)
  runAppleCommand('/usr/bin/xcrun', ['stapler', 'validate', diskImagePath], 'stapler validate')
  runAppleCommand('/usr/sbin/spctl', ['--assess', '--type', 'install', '--verbose=4', diskImagePath], 'spctl')
}

/**
 * Verify the macOS application produced by electron-builder's signing phase.
 * @param {{ electronPlatformName: string, appOutDir: string, packager: { appInfo: { productFilename: string } } }} context - electron-builder hook context.
 * @param {{ signingIdentity: string, teamId: string }} expected - Public release identity.
 * @returns {void}
 */
export function verifyMacOSSignatureAfterSign(context, expected) {
  if (context.electronPlatformName !== 'darwin') return
  const appPath = resolve(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  verifyMacOSSignature(appPath, expected)
  process.stdout.write(`desktop macOS signing: verified Developer ID Application: ${expected.signingIdentity} (${expected.teamId})\n`)
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  const cliArgs = process.argv[2] === '--' ? process.argv.slice(3) : process.argv.slice(2)
  const appPath = cliArgs[0]
  if (appPath === undefined || cliArgs.length !== 1) {
    throw new Error('usage: node scripts/verify-macos-signature.mjs <path-to-app>')
  }
  const expected = resolveMacOSSigningEnvironment(process.env)
  verifyMacOSSignature(resolve(appPath), expected)
  process.stdout.write(`desktop macOS signing: verified Developer ID Application: ${expected.signingIdentity} (${expected.teamId})\n`)
}
