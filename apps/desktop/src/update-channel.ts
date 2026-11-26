/** Desktop update channel identifier shared across local settings, coordinator, and IPC. */
import type { DesktopUpdatePreferences } from './settings-file.ts'

/** Update channel identifier (`stable` or `nightly`). */
export type DesktopUpdateChannel = DesktopUpdatePreferences['channel']
