/**
 * Pure sequencing of the Win32 `IFileOpenDialog` folder-picker COM
 * conversation over injectable platform bindings, so every outcome path
 * (selection, cancellation, HRESULT failure, cleanup ordering) is testable on
 * any platform. The koffi-backed bindings live in
 * `win32-dialog-bindings.ts`, which only a real win32 process ever loads.
 */

/** `HRESULT_FROM_WIN32(ERROR_CANCELLED)`: the user dismissed the dialog. */
export const HRESULT_CANCELLED = 0x800704c7 | 0

/** `FOS_PICKFOLDERS`: the dialog selects directories, not files. */
export const FOS_PICKFOLDERS = 0x20
/** `FOS_FORCEFILESYSTEM`: only results with a filesystem path can be chosen. */
export const FOS_FORCEFILESYSTEM = 0x40
/** `FOS_NOCHANGEDIR`: never mutate the process working directory. */
export const FOS_NOCHANGEDIR = 0x8

/** One created folder dialog: the vtable calls the sequencing needs. */
export interface Win32FolderDialog {
  /**
   * `IFileDialog::SetOptions`.
   * @param options - the `FOS_*` flag union to apply.
   * @returns the call's HRESULT.
   */
  setOptions(options: number): number
  /**
   * `IFileDialog::SetTitle`.
   * @param title - the dialog title text.
   * @returns the call's HRESULT.
   */
  setTitle(title: string): number
  /**
   * `IModalWindow::Show` with no owner window; blocks the calling thread
   * until the user selects or dismisses.
   * @returns the call's HRESULT (`HRESULT_CANCELLED` on dismissal).
   */
  show(): number
  /**
   * `IFileDialog::GetResult` + `IShellItem::GetDisplayName(SIGDN_FILESYSPATH)`,
   * releasing the shell item and freeing the COM string.
   * @returns the call chain's HRESULT and, on success, the selected path.
   */
  resultPath(): { hr: number; path?: string }
  /** Release the dialog's COM reference. */
  release(): void
}

/** The thread-level native surface the dialog sequencing runs against. */
export interface Win32DialogBindings {
  /**
   * Opt the calling thread into the best supported DPI awareness
   * (per-monitor-v2, then per-monitor, then system-aware), checking each
   * call's result. Best-effort on purpose: a host accepting none of them
   * (or lacking the API, pre-1607) still shows the modern dialog — possibly
   * blurry above 100 % scaling — because a cosmetic degradation must not
   * cost the tier.
   */
  setThreadDpiAwareness(): void
  /**
   * `CoInitializeEx(COINIT_APARTMENTTHREADED)` on the calling thread.
   * @returns the call's HRESULT (`S_FALSE` re-entry is still a success).
   */
  coInitializeSta(): number
  /**
   * `CoUninitialize` on the calling thread — COM requires one pairing call
   * for every successful (including `S_FALSE`) `CoInitializeEx`, even on a
   * thread that exits right after the conversation.
   */
  coUninitialize(): void
  /**
   * `CoCreateInstance(CLSID_FileOpenDialog)`.
   * @returns the created dialog surface; throws when creation fails.
   */
  createFolderDialog(): Win32FolderDialog
  /**
   * `GetCurrentThreadId` — the native id a driver needs to close this
   * thread's windows from outside.
   * @returns the calling thread's native id.
   */
  currentThreadId(): number
  /**
   * Make the dialog that `Show` is about to create able to take the
   * foreground. Windows grants activation only to the foreground process,
   * to a process it started, or to a process that received recent input; a
   * worker spawned by a background host (the web GUI server) qualifies for
   * none, so the dialog would open behind every other window. Synthesizing
   * one Alt press (down, then up) through `keybd_event` counts this process
   * as the most recent input owner — a community-documented technique with
   * no documented contract. Call immediately before `Show`. When the
   * process already holds foreground rights (a console-launched CLI), the
   * press is inert, but the focused window still receives the lone Alt and
   * may briefly highlight its menu bar before the dialog activates.
   */
  pressAltForForeground(): void
}

/**
 * Throw when an HRESULT signals failure.
 * @param hr - the HRESULT to check.
 * @param what - the failing call's name for the error message.
 * @returns the (successful) HRESULT unchanged.
 */
function check(hr: number, what: string): number {
  if (hr < 0) throw new Error(`${what} failed: HRESULT 0x${(hr >>> 0).toString(16)}`)
  return hr
}

/**
 * Run one modal folder-picker conversation on the calling thread: DPI opt-in,
 * STA init, dialog creation, `Show`, and result extraction, releasing the
 * dialog on every path.
 * @param bindings - the native surface (koffi-backed in production, fakes in tests).
 * @param title - the dialog title text.
 * @param onShowing - called with the native thread id immediately before the
 *   blocking `Show`, so a driver on another thread can close the dialog.
 * @returns the selected filesystem path, or null when the user cancels.
 */
export function runFolderDialog(
  bindings: Win32DialogBindings,
  title: string,
  onShowing: (threadId: number) => void,
): string | null {
  bindings.setThreadDpiAwareness()
  check(bindings.coInitializeSta(), 'CoInitializeEx')
  // From here the apartment is initialized (S_OK or S_FALSE) and must be
  // uninitialized exactly once on every path.
  try {
    const dialog = bindings.createFolderDialog()
    try {
      check(dialog.setOptions(FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_NOCHANGEDIR), 'SetOptions')
      check(dialog.setTitle(title), 'SetTitle')
      onShowing(bindings.currentThreadId())
      bindings.pressAltForForeground()
      const shown = dialog.show()
      if (shown === HRESULT_CANCELLED) return null
      check(shown, 'Show')
      const result = dialog.resultPath()
      check(result.hr, 'GetResult')
      return result.path as string
    } finally {
      dialog.release()
    }
  } finally {
    bindings.coUninitialize()
  }
}
