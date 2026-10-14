/** Closed account-command diagnostics projected from the CLI's final stderr JSON envelope. */

import z from 'zod'
import type { FeishuCommandResult } from './cli.ts'
import type { FeishuOperationFailure } from './types.ts'

const ErrorType = z.enum(['validation', 'authentication', 'authorization', 'config', 'network', 'api', 'policy', 'internal', 'confirmation'])
const ErrorSubtype = z.enum(['sdk_error', 'storage', 'file_io', 'not_configured', 'invalid_config', 'invalid_client'])
const Envelope = z.object({
  ok: z.literal(false),
  error: z.object({
    type: ErrorType.optional().catch(undefined),
    subtype: ErrorSubtype.optional().catch(undefined),
  }),
})

/**
 * Keep only recognized classifications from the CLI's bounded stderr tail. The final envelope
 * may follow setup progress and a QR code; truncated or unrecognized output adds no fields.
 * @param command - the account command whose process finished.
 * @param result - its observed exit code and captured output.
 * @returns fixed command identity, exit code, and optional allowlisted classifications.
 */
export function commandFailure(command: FeishuOperationFailure['command'], result: FeishuCommandResult): FeishuOperationFailure {
  const failure: FeishuOperationFailure = { command, exitCode: result.exitCode }
  const start = result.stderr.lastIndexOf('\n{')
  let value: unknown
  try {
    value = JSON.parse(result.stderr.slice(start < 0 ? 0 : start + 1))
  } catch (_error) {
    // Partial or non-JSON stderr cannot supply a safe CLI classification.
    return failure
  }
  const parsed = Envelope.safeParse(value)
  if (!parsed.success) return failure
  const { type, subtype } = parsed.data.error
  return {
    ...failure,
    ...type === undefined ? {} : { type },
    ...subtype === undefined ? {} : { subtype },
  }
}
