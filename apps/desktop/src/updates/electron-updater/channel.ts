/** Channel policy applied after electron-updater's channel setter. */
import type { AppUpdater } from 'electron-updater'

/**
 * Select the operator-managed feed, accepting prereleases while preventing downgrades.
 * @param updater - Updater whose prior operations have settled.
 * @param channel - Selected distribution channel.
 */
export function selectUpdateChannel(updater: AppUpdater, channel: 'nightly' | 'stable'): void {
  updater.channel = channel
  // The library channel setter enables downgrades.
  updater.allowDowngrade = false
  updater.allowPrerelease = true
}
