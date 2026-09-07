/**
 * Build the minimal CMD environment for one Electron artifact.
 *
 * @param environment Parent environment.
 * @param input Validated signing identity and task.
 * @returns Scrubbed environment plus the fields consumed and cleared by the signing CMD.
 */
export function buildWindowsSigningEnvironment(environment: NodeJS.ProcessEnv, input: {
  certificateFile: string
  signTool: string
  path: string
  isNest: boolean
  tokenPin: string
  keyContainer: string
}): NodeJS.ProcessEnv

/**
 * Create the electron-builder hook for a hardware-backed Windows code-signing certificate.
 *
 * @param options Release signing configuration.
 * @returns The signing hook.
 */
export function createWindowsTokenSigner(options: {
  certificateFile?: string | undefined
  signTool?: string | undefined
  tokenPin?: string | undefined
  keyContainer?: string | undefined
  commandInterpreter?: string | undefined
}): (
  configuration: {
    path: string
    hash: string
    isNest: boolean
  },
) => Promise<void>

/**
 * Remove inherited credentials before starting a signing-related subprocess.
 *
 * @param environment Parent environment.
 * @returns Environment without credential-shaped names.
 */
export function scrubWindowsSigningEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv

/**
 * Replace a SignTool failure with a diagnostic that cannot retain its command line.
 *
 * @param error SignTool process failure.
 * @param path Artifact that failed signing.
 * @param secrets Values that must not appear in the diagnostic.
 * @returns Sanitized signing failure without the original error as its cause.
 */
export function createRedactedWindowsSigningError(
  error: unknown,
  path: string,
  secrets: readonly string[],
): Error

/**
 * Clear a certificate-table entry that points beyond the end of a generated executable.
 *
 * @param path Executable to inspect.
 * @returns Whether an invalid certificate-table entry was cleared.
 */
export function repairDanglingAuthenticodeDirectory(path: string): Promise<boolean>

/**
 * Sign electron-builder's temporary NSIS executable before enterprise code integrity evaluates it.
 *
 * @param options Signing hook and injectable host values.
 * @returns Nothing.
 */
export function installWindowsNsisBootstrapSigner(options: {
  sign: (configuration: {
    path: string
    hash: string
    isNest: boolean
  }) => Promise<void>
  wineVmManager?: {
    prototype: {
      exec: (
        file: string,
        args: string[],
        options?: { env?: NodeJS.ProcessEnv },
        isLogOutIfDebug?: boolean,
      ) => unknown
    }
  }
  platform?: NodeJS.Platform
  environment?: NodeJS.ProcessEnv
}): void
