import type { WindowsRuntimeSignature } from './windows-runtime-signature.mjs'

/**
 * Remove unsigned signature attributes on a previously verified private copy.
 * @param path Single-signature private copy.
 * @param signTool Configured SignTool executable.
 * @param environment Credential-free subprocess environment.
 * @returns Resolves after removal or an unchanged-file warning; other failures reject.
 */
export function normalizeWindowsSignature(path: string, signTool: string, environment: NodeJS.ProcessEnv): Promise<void>

/** Public operations on isolated files; sign resolves only after verified hardware success. */
export interface WindowsTimestampOptions {
  sign: (path: string) => Promise<void>
  timestamp: (path: string) => Promise<void>
  normalize: (path: string) => Promise<void>
  inspect: (path: string) => Promise<WindowsRuntimeSignature>
  thumbprint: string
  evidenceDirectory: string
  record: (event: object) => void
  wait?: (milliseconds: number) => Promise<unknown>
}

/**
 * Complete a single verified hardware signature using bounded, isolated timestamp attempts.
 * @param path Exclusively owned build file in trusted storage.
 * @param options Verified signer, public operations, certificate and retained audit storage.
 * @returns Resolves after a valid timestamp and exact normalized-content verification; failures preserve evidence.
 */
export function completeWindowsSignature(path: string, options: WindowsTimestampOptions): Promise<void>
