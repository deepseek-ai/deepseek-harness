/** Execution mode and resource limits for the Node PTC provider. */
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type { LaunchConfig } from './launch.ts'

/** Deployment-varying runtime bounds and launch choices. */
export interface Config {
  /** Worker invocation in the subprocess world; omitted selects the local carrier. */
  launch?: LaunchConfig
  /** per-call starts fresh processes; persistent-in-memory retains a REPL per owner under the same file policy. */
  executionMode?: 'per-call' | 'persistent-in-memory'
  /** Default elapsed deadline, including nested tool and approval waits. */
  timeoutMs?: number
  /** Maximum numeric elapsed budget accepted by resolve. */
  maxTimeoutMs?: number
  /** Combined serialized logs, completion and diagnostic byte cap. */
  maxOutputBytes?: number
  /** V8 old-generation heap limit in MiB; native allocations are excluded. */
  maxOldGenerationSizeMb?: number
  /** Maximum control frame, outstanding argument and queued control-output bytes. */
  maxMessageBytes?: number
  /** Maximum simultaneous host binding calls accepted from a program. */
  maxPendingCalls?: number
  /** Managed process termination and output-drain grace in milliseconds. */
  graceMs?: number
}

/** Configuration after Loader defaults and executable selection. */
export type ResolvedConfig = Required<Config>
/** Loader defaults for the Node PTC provider. */
export const NodeConfig: z<Config> = z.object({
  executionMode: z.union([z.const('per-call'), z.const('persistent-in-memory')]).default('per-call'),
  timeoutMs: z.number().default(120_000),
  maxTimeoutMs: z.number().default(600_000),
  maxOutputBytes: z.number().default(67_108_864),
  maxOldGenerationSizeMb: z.number().default(512),
  maxMessageBytes: z.number().default(134_217_728),
  maxPendingCalls: z.number().default(128),
  graceMs: z.number().default(3_000),
  launch: z.union([
    z.object({ kind: z.const('node-script').required(), executable: z.string().required(), bootstrapPath: z.string() }),
    z.object({ kind: z.const('embedded').required(), executable: z.string().required() }),
  ]),
})

/**
 * Validate resolved Node limits and paths.
 * @param config - Loader-defaulted fields with the selected executable.
 */
export function validateConfig(config: ResolvedConfig): void {
  for (const [key, value] of Object.entries(config)) {
    if (typeof value === 'number' && (!Number.isFinite(value) || value <= 0)) throw new Error(`ptc-runtime-node: ${key} must be positive and finite`)
  }
  for (const key of ['timeoutMs', 'maxTimeoutMs', 'graceMs'] as const) {
    if (config[key] > MAX_TIMER_DELAY_MS) throw new Error(`ptc-runtime-node: ${key} exceeds the supported timer range`)
  }
  if (!Number.isSafeInteger(config.maxOutputBytes) || config.maxOutputBytes < 4) throw new Error('ptc-runtime-node: maxOutputBytes must be an integer of at least 4')
  if (!Number.isSafeInteger(config.maxMessageBytes) || config.maxMessageBytes > 0xffff_ffff) throw new Error('ptc-runtime-node: maxMessageBytes must fit an unsigned 32-bit frame length')
  if (!Number.isSafeInteger(config.maxPendingCalls)) throw new Error('ptc-runtime-node: maxPendingCalls must be an integer')
  if (!Number.isSafeInteger(config.maxOldGenerationSizeMb)) throw new Error('ptc-runtime-node: maxOldGenerationSizeMb must be an integer')
}
