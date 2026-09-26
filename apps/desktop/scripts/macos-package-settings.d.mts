/** File-owned macOS packaging concurrency and stage-specific proxies. */

/** Validated settings shared by preflight and stage execution. */
export interface MacOSPackageSettings {
  readonly packConcurrency: number
  readonly downloadProxy?: string
  readonly notarizationProxy?: string
}

/**
 * Validate tuning before any build or network operation.
 * @param environment File-owned packaging settings.
 * @returns Resolved settings; empty proxy fields preserve inherited networking.
 */
export function resolveMacOSPackageSettings(environment: NodeJS.ProcessEnv): MacOSPackageSettings

/**
 * Override routing only in download-capable subprocesses without mutating the parent.
 * @param environment Parent environment.
 * @param proxyUrl Validated proxy, or undefined to preserve inherited settings.
 * @returns Child environment; explicit routing bypasses only local hosts.
 */
export function macOSDownloadEnvironment(environment: NodeJS.ProcessEnv, proxyUrl?: string): NodeJS.ProcessEnv
