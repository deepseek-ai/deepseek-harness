/** Shortcuts plugin configuration shared by the Host and Client faces; types only. */
import type { Volatile } from '@deepseek-ai/cordis'

/** Fixed shortcut sequence timing; the browser receives it through its synced Config. */
export interface ShortcutsConfig {
  /** Maximum interval between independent Escape presses for stopping a reply, in milliseconds. */
  stopSequenceMs: Volatile<number>
}
