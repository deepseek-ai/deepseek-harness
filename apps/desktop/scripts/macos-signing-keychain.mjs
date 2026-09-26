/** Own a temporary PKCS#12 signing identity for one macOS packaging invocation. */
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Execute a credential-bearing Apple command without exposing arguments or tool output on failure.
 * @param {string} command Absolute executable path.
 * @param {string[]} args Command arguments, potentially containing secrets.
 * @returns {string} Command standard output, needed when the caller reads a security query.
 */
function execute(command, args) {
  try {
    return execFileSync(command, args, { stdio: 'pipe', timeout: 120_000, encoding: 'utf8' })
  }
  catch (error) {
    // execFile errors contain the command line, including private-key passwords.
    throw new Error(`desktop macOS signing: ${command} ${args[0]} failed; check certificate, password, and signing access`)
  }
}

/**
 * Read the user's keychain search list so this invocation can extend and later restore it.
 * @param {(command: string, args: string[]) => string} run Apple command executor.
 * @returns {string[]} Keychain paths on the user search list.
 */
function readUserKeychains(run) {
  const output = run('/usr/bin/security', ['list-keychains', '-d', 'user'])
  if (typeof output !== 'string') {
    throw new Error('desktop macOS signing: the user keychain search list could not be read')
  }
  return output.split('\n').map(line => line.trim().replace(/^"|"$/gu, '')).filter(path => path !== '')
}

/**
 * Import and authorize the required p12 before work; delete the owned keychain after work settles.
 * Children receive only its path, never the p12 password. Existing login keychains are not unlocked.
 * codesign resolves an identity only from a keychain on the user search list, so the owned keychain
 * is prepended during the run and the previous list is restored before deletion.
 * Abrupt process termination requires the CI runner to clean its temporary directory.
 * @param {NodeJS.ProcessEnv} environment Validated platform configuration with local CSC_LINK and CSC_KEY_PASSWORD.
 * @param {(environment: NodeJS.ProcessEnv) => Promise<void>} action All signing work, settled before cleanup.
 * @param {(command: string, args: string[]) => string} run Apple command executor.
 * @returns {Promise<void>} Resolves after work and cleanup; rejects on setup, work, or cleanup failure.
 */
export async function withMacOSSigningKeychain(environment, action, run = execute) {
  const certificate = environment.CSC_LINK
  const exportPassword = environment.CSC_KEY_PASSWORD
  if (!certificate || exportPassword === undefined) throw new Error('desktop macOS signing: CSC_LINK and CSC_KEY_PASSWORD are required')
  const directory = mkdtempSync(join(tmpdir(), 'dsh-macos-signing-'))
  const keychain = join(directory, 'signing.keychain-db')
  const password = randomBytes(32).toString('base64')
  /** @param {string[]} args Security command arguments. */
  const security = args => run('/usr/bin/security', args)
  let created = false
  let previousKeychains
  try {
    security(['create-keychain', '-p', password, keychain])
    created = true
    security(['unlock-keychain', '-p', password, keychain])
    security(['set-keychain-settings', keychain])
    security(['import', certificate, '-k', keychain, '-P', exportPassword, '-T', '/usr/bin/codesign', '-T', '/usr/bin/productbuild'])
    security(['set-key-partition-list', '-S', 'apple-tool:,apple:', '-s', '-k', password, keychain])
    // codesign ignores --keychain unless that file is also on the search list
    // (https://github.com/electron-userland/electron-builder/issues/1457).
    previousKeychains = readUserKeychains(run)
    security(['list-keychains', '-d', 'user', '-s', keychain, ...previousKeychains])
    const probe = join(directory, 'probe')
    run('/bin/cp', ['/usr/bin/true', probe])
    run('/usr/bin/codesign', ['--force', '--sign', `Developer ID Application: ${environment.DSH_DESKTOP_MACOS_SIGNING_IDENTITY}`, '--keychain', keychain, '--timestamp', '--options', 'runtime', probe])
    run('/usr/bin/codesign', ['--verify', '--strict', probe])
    const childEnvironment = { ...environment, CSC_KEYCHAIN: keychain, DSH_DESKTOP_MACOS_SIGNING_PROBE: probe }
    delete childEnvironment.CSC_LINK
    delete childEnvironment.CSC_KEY_PASSWORD
    await action(childEnvironment)
  } finally {
    try {
      if (previousKeychains !== undefined) security(['list-keychains', '-d', 'user', '-s', ...previousKeychains])
      if (created) security(['delete-keychain', keychain])
    }
    finally { rmSync(directory, { recursive: true, force: true }) }
  }
}
