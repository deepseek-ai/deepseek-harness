/** Account notification plugin configuration shared by the Host and Client faces; types only. */
import type { Volatile } from '@deepseek-ai/cordis'

/** Initial polling interval; the browser receives it through its synced Config. */
export interface AccountNotificationsConfig {
  /** Initial query delay in milliseconds, replaced by each successful server response. */
  notificationPollIntervalMs: Volatile<number>
}
