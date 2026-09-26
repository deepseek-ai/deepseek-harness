import type { WindowsRuntimeSignature } from './windows-runtime-signature.mjs'

/**
 * Validate complete, ordered, per-file inspection results.
 * @param stdout Newline-delimited signature records.
 * @param stderr Process diagnostics, which must be empty.
 * @param files Exact requested file order.
 * @returns Validated signatures; rejects missing, duplicate, reordered or malformed rows.
 */
export function parseSignatureRows(stdout: string, stderr: string, files: readonly string[]): WindowsRuntimeSignature[]

/**
 * Inspect every file with at most four processes and 32 files per process.
 * @param files Materialized PE paths in stable order.
 * @returns One signature per file, after all processes in each batch have exited, including on failure.
 */
export function inspectSignaturesBatched(files: readonly string[]): Promise<WindowsRuntimeSignature[]>
