/** Connection plugin configuration shared by the Host and Client faces; types only. */
import type { Volatile } from '@deepseek-ai/cordis'
import type { ConnectionRecoveryConfig } from './recovery-config.ts'

/** Browser authentication, request limits, and connection recovery configuration. */
export interface ConnectionConfig {
  /** Browser recovery timing; the browser receives it through its synced Config and reads it once when the plugin activates. */
  recovery?: Volatile<ConnectionRecoveryConfig>
  /**
   * Authorities this deployment serves beyond loopback: exact `host:port`, or
   * port-less `host` matching any port. The fence accepts loopback and the
   * listener's own bind IP independently; other remote authorities require
   * an entry here. A non-canonical or non-bare authority fails plugin load.
   */
  trustedHosts?: string[]
  /** Maximum buffered JSON body for every `/api` request. Default: 300 MiB. */
  maxRequestBodyBytes?: number
}
