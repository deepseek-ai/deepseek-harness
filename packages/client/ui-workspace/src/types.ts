/** Workspace navigation configuration shared by the Host and Client faces; types only. */
import type { Volatile } from '@deepseek-ai/cordis'

/** Live Workspace navigation preferences; the browser receives every field through its synced Config. */
export interface WorkspaceNavigationConfig {
  /** Recently viewed Sessions needing no attention kept loaded besides the main-view Session. */
  recentViewLimit: Volatile<number>
}
