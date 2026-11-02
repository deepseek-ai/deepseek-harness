/** Whitelisted operation records shared by diagnostic transport and durable readers. */
import { z } from 'zod'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ChangeResult, ManagementError, PluginChange, PluginOperation, PluginOperationId, RestartReason } from './types.ts'

/** Identifies the process lifetime which observed management operations. */
export type PluginOperationRunId = Branded<'PluginOperationRunId'>

/** One diagnostic event; omissions and unknown outcomes must not be interpreted as successful operations. */
export interface PluginOperationRecord {
  readonly runId: PluginOperationRunId
  readonly operation: PluginOperation
  readonly transportDropped: number
}

const fields = {
  id: z.uuid().transform(value => value as PluginOperationId),
  time: z.iso.datetime(),
  reason: z.enum({
    'plugin': 'plugin',
    'bundle': 'bundle',
    'install': 'install',
    'remove': 'remove',
  } satisfies { [K in PluginChange['reason']]: K }),
  target: z.string().max(256).nullable(),
  stage: z.enum({
    'install': 'install',
    'enable': 'enable',
    'remove': 'remove',
  } satisfies { [K in ChangeResult['stage']]: K }),
  enabled: z.boolean().optional(),
  version: z.string().max(128).optional(),
}
const operation: z.ZodType<PluginOperation> = z.discriminatedUnion('phase', [
  z.object({ ...fields, phase: z.literal('started') }),
  z.object({ ...fields, phase: z.literal('unknown') }),
  z.object({ ...fields, phase: z.literal('settled'),
    application: z.enum({
      'applied': 'applied',
      'restart-required': 'restart-required',
      'overridden': 'overridden',
      'failed': 'failed',
      'cancelled': 'cancelled',
    } satisfies { [K in ChangeResult['application']]: K }),
    changed: z.boolean(),
    errorCode: z.enum({
      'management-required': 'management-required',
      'unaddressable': 'unaddressable',
      'unknown-plugin': 'unknown-plugin',
      'invalid-spec': 'invalid-spec',
      'already-installed': 'already-installed',
      'ambiguous-install': 'ambiguous-install',
      'not-bundle': 'not-bundle',
      'not-removable': 'not-removable',
      'stop-profile': 'stop-profile',
      'bundle-in-use': 'bundle-in-use',
      'stale-approval': 'stale-approval',
      'incompatible-version': 'incompatible-version',
      'unsupported-platform': 'unsupported-platform',
      'operation-error': 'operation-error',
    } satisfies { [K in ManagementError['code']]: K }).optional(),
    restartReason: z.enum({
      'no-hmr': 'no-hmr',
      'package-moved': 'package-moved',
      'host-module': 'host-module',
      'unmanaged-plugin': 'unmanaged-plugin',
      'module-comparison': 'module-comparison',
    } satisfies { [K in RestartReason]: K }).optional(),
  }),
])
const record = z.object({
  runId: z.uuid().transform(value => value as PluginOperationRunId),
  operation,
  transportDropped: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
})

/**
 * Validate transport/file data and discard fields outside the diagnostic whitelist.
 * @param value - Untrusted decoded JSON.
 * @returns A bounded record, or undefined for malformed, oversized or unsupported records.
 */
export function parsePluginOperationRecord(value: unknown): PluginOperationRecord | undefined {
  const parsed = record.safeParse(value)
  return parsed.success ? parsed.data : undefined
}
