/** Channel policy applied after electron-updater's channel setter. */
import type { AppUpdater } from 'electron-updater'

/**
 * Select a feed without permitting downgrades or prereleases on stable.
 * @param updater - Updater whose prior operations have settled.
 * @param channel - Selected distribution channel.
 */
export function selectUpdateChannel(updater: AppUpdater, channel: 'nightly' | 'stable'): void {
  updater.channel = channel
  // The library channel setter enables downgrades.
  updater.allowDowngrade = false
  updater.allowPrerelease = channel === 'nightly'
}
