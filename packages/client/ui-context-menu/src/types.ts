/** Context-menu plugin configuration shared by the Host and Client faces; types only. */
import type { Volatile } from '@deepseek-ai/cordis'

/** Live preparation budget; the browser receives it through its synced Config. */
export interface ContextMenuConfig {
  /** Maximum time in milliseconds to prepare each contribution before omitting its pending actions. */
  resolutionTimeoutMs: Volatile<number>
}
