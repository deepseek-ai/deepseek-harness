/**
 * Native backend of the directory-picker seam: registers `ctx.directoryPicker`
 * with the `native` capability, opening one native OS chooser on the host
 * display per pick (macOS `osascript`, Linux Zenity with a KDialog fallback;
 * Windows opens the modern `IFileOpenDialog` in a spawned child process — a
 * koffi-driven COM conversation on the child's main thread, preceded by a
 * synthesized Alt press so the dialog activates as foreground even when a
 * background host spawned the child). Only viable when
 * the operator sits at the host's screen; remote deployments compose the
 * browse backend instead.
 * @module @deepseek-ai/dsh-host-directory-picker-native
 */

import { DirectoryPicker } from '@deepseek-ai/dsh-host-directory-picker'
import type { DirectoryPickerCapability } from '@deepseek-ai/dsh-host-directory-picker'
import { pickNativeDirectory } from './native-picker.ts'

export type { DirectoryPickerInternals, DirectoryPickerRunner } from './native-picker.ts'
export { pickNativeDirectory } from './native-picker.ts'

/** The `ctx.directoryPicker` native implementation (stable capability object per service life). */
export default class NativeDirectoryPicker extends DirectoryPicker {
  private readonly nativeCapability: DirectoryPickerCapability = {
    kind: 'native',
    /* v8 ignore next -- pure forward to pickNativeDirectory (its spec owns behavior); invoking here opens a real chooser. */
    pick: signal => pickNativeDirectory(signal),
  }

  /**
   * The native interaction capability.
   * @returns the stable `native` capability object.
   */
  capability(): DirectoryPickerCapability {
    return this.nativeCapability
  }
}
