import type { WindowsRuntimeSignature } from './windows-runtime-signature.mjs'
import type { createWindowsTokenSigner } from './windows-sign.mjs'

/** File-owned cache policy and existing supervised signing operations. */
export interface WindowsSignatureCacheOptions {
  root: string
  identity: string
  thumbprint: string
  sign: ReturnType<typeof createWindowsTokenSigner>
  inspect: (path: string) => Promise<WindowsRuntimeSignature>
  record: (event: object) => void
}

/**
 * Hash the public certificate and files controlling signing output in fixed order.
 * @param files Certificate and signing-toolchain paths, excluding credentials.
 * @returns Content identity independent of installation paths and PIN values.
 */
export function signatureCacheIdentity(files: readonly string[]): Promise<string>

/** Counters include failed attempts; times sum per-file work. Verification covers restored and newly signed files; restore time includes its verification and staging cleanup. */
export interface WindowsSignatureCacheSummary {
  root: string
  identity: string
  hits: number
  misses: number
  published: number
  retained: number
  signingCalls: number
  avoidedSigningCalls: number
  validationFailures: number
  verificationMs: number
  restoreMs: number
  signingMs: number
}

/** Serial signing callback with a separate hardware-free restore operation and shared counters. */
export type WindowsCachedSigner = ReturnType<typeof createWindowsTokenSigner> & {
  /**
   * Restore a hit without accessing hardware; distinct targets may run concurrently under the stage lock.
   * @param configuration Unsigned target owned exclusively by the caller.
   * @returns True after verified replacement, false for an absent entry without counting a signing miss; corrupt entries reject. The caller drains all restores before signing or reporting failure.
   */
  restore(configuration: Parameters<ReturnType<typeof createWindowsTokenSigner>>[0]): Promise<boolean>
  /** @returns Current counters and elapsed times; does not wait for queued operations. */
  summary(): WindowsSignatureCacheSummary
}

/**
 * Reuse complete signed files only after input, integrity, identity and timestamp checks.
 * @param options Cache policy, supervised signer, public-key verifier and audit sink.
 * @returns Serial fail-stop signer with hardware-free restores; invalid cache entries are never repaired.
 */
export function createCachedSigner(options: WindowsSignatureCacheOptions): WindowsCachedSigner

/** The caller validates ownership and holds the user-wide signing-stage lock throughout migration. */
export interface SignatureCacheMigrationOptions {
  source: string
  root: string
  record: (event: object) => void
}

/**
 * Copy complete entries without changing the source or replacing valid destination entries.
 * @param options Validated directories and credential-free audit sink.
 * @returns Counts of published, retained and skipped entries; corruption rejects without repair. Actual use rechecks trust.
 */
export function migrateSignatureCache(options: SignatureCacheMigrationOptions): Promise<{ published: number, retained: number, skipped: number }>

/**
 * Inspect or explicitly clear complete entries under the caller's signing-stage lock.
 * @param root Validated current-account cache directory.
 * @param clear Remove complete entries after atomic retirement; incomplete staging directories remain untouched.
 * @returns Count and bytes of complete entries, plus the number of skipped incomplete entries.
 */
export function maintainSignatureCache(root: string, clear?: boolean): Promise<{ entries: number, bytes: number, incomplete: number }>
