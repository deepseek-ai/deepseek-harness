/** Shared validation for Host-configured and browser-local connection recovery. */
import z from '@deepseek-ai/schemastery'

/** Timing for generation readiness and automatic reconnection. */
export interface ConnectionRecoveryConfig {
  /** First-retry delay cap in ms; actual delay is 50–100% of the cap. Default: 500. */
  backoffBaseMs?: number
  /** Finite growth factor of at least 1 per failed attempt; 1 keeps a fixed cap. Default: 2. */
  backoffFactor?: number
  /** Maximum retry delay cap in ms; retries continue at this cap. Default: 10000. */
  backoffMaxMs?: number
  /**
   * Delay before reporting a slow handshake, without cancelling it. Default: 3000.
   * Omitted when readiness, failure, cancellation, or the hard deadline occurs first.
   */
  generationReadyWarnMs?: number
  /** Deadline in ms for readiness, including physical connection setup. Default: 15000. */
  generationReadyTimeoutMs?: number
}

// Browsers and Node share this maximum signed 32-bit timer delay.
const MAX_TIMER_MS = 2_147_483_647

/** Schema shared by the Host plugin and the Client's recovery input parser. */
export const ConnectionRecoveryConfigSchema: z<ConnectionRecoveryConfig> = z.object({
  backoffBaseMs: z.natural().min(1).max(MAX_TIMER_MS).default(500),
  backoffFactor: z.number().min(1).max(Number.MAX_VALUE).default(2),
  backoffMaxMs: z.natural().min(1).max(MAX_TIMER_MS).default(10_000),
  generationReadyWarnMs: z.natural().min(1).max(MAX_TIMER_MS).default(3_000),
  generationReadyTimeoutMs: z.natural().min(1).max(MAX_TIMER_MS).default(15_000),
})

/**
 * Validate recovery input and supply every timing default before starting work.
 * @param config - Host configuration, page bootstrap data, or direct loop options.
 * @returns validated, complete recovery timing.
 */
export function resolveConnectionConfig(config: unknown = {}): Required<ConnectionRecoveryConfig> {
  const resolved = ConnectionRecoveryConfigSchema(config as ConnectionRecoveryConfig) as Required<ConnectionRecoveryConfig>
  if (!Number.isFinite(resolved.backoffFactor)) {
    throw new RangeError('connection recovery backoffFactor must be finite')
  }
  return resolved
}
