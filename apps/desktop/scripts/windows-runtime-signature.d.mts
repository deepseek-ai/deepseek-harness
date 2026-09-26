/** Public-key verification result; no hardware authentication is performed. */
export interface WindowsRuntimeSignature {
  status: string
  timestamped: boolean
  thumbprint: string | null
}

/**
 * Read Windows trust, timestamp and signer identity using the engine's bundled modules, without accessing the private key.
 * @param path File to inspect.
 * @returns Authenticode verification result.
 */
export function inspectWindowsRuntimeSignature(path: string): Promise<WindowsRuntimeSignature>

/**
 * Preserve a copied primary-runtime executable only after signature and exact-byte verification.
 * @param path Signing-hook target.
 * @param options Prepared and copied runtime roots with retained audit directory.
 * @returns True for a verified runtime copy; false for targets outside that directory.
 */
export function preserveWindowsRuntimeSignature(path: string, options: {
  sourceRoot: string
  destinationRoot: string
  runDirectory: string
  inspect?: typeof inspectWindowsRuntimeSignature
}): Promise<boolean>

/** Supervised signing dependencies shared by all Windows release trees. */
export interface WindowsCodeSigningOptions {
  thumbprint: string
  sign: ReturnType<typeof import('./windows-sign.mjs').createWindowsTokenSigner>
  inspect?: typeof inspectWindowsRuntimeSignature
  record: (event: object) => void
  /** Hardware-free restores on distinct targets; concurrency is a resolved positive integer. All restores and their verification drain before serial signing starts. */
  cache?: {
    restore: import('./windows-signature-cache.mjs').WindowsCachedSigner['restore']
    concurrency: number
  }
}

/**
 * Enumerate PE files by content without following links.
 * @param root Materialized directory to scan.
 * @returns Sorted PE paths; rejects malformed Windows executables and links.
 */
export function windowsRuntimeCode(root: string): Promise<string[]>

/**
 * Preserve valid signatures and sign unsigned PE files with a supervised signer.
 * @param root Materialized directory to sign.
 * @param options Signer, certificate identity and audit sink.
 * @returns Resolves after verified parallel cache restores and sequential signing; stops dispatch and drains active restores on failure, without retries.
 */
export function signWindowsCode(root: string, options: WindowsCodeSigningOptions): Promise<void>

/**
 * Reject unsigned or invalid PE files in a completed directory.
 * @param root Materialized artifact directory.
 * @param inspect Public-key verifier.
 * @returns Resolves after all PE signatures are valid.
 */
export function verifyWindowsCode(root: string, inspect?: typeof inspectWindowsRuntimeSignature): Promise<void>
