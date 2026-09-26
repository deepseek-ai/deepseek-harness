/** Own a temporary PKCS#12 signing identity for one macOS packaging invocation. */

/**
 * Import and authorize the required p12 before work; delete the owned keychain after work settles.
 * Children receive only its path, never the p12 password. Existing login keychains are not unlocked.
 * The owned keychain is prepended to the user search list for the run and the previous list is restored.
 * Abrupt process termination requires the CI runner to clean its temporary directory.
 * @param environment Validated platform configuration with local CSC_LINK and CSC_KEY_PASSWORD.
 * @param action All signing work, settled before cleanup.
 * @param run Apple command executor returning command standard output.
 * @returns Resolves after work and cleanup; rejects on setup, work, or cleanup failure.
 */
export function withMacOSSigningKeychain(
  environment: NodeJS.ProcessEnv,
  action: (environment: NodeJS.ProcessEnv) => Promise<void>,
  run?: (command: string, args: string[]) => string,
): Promise<void>
