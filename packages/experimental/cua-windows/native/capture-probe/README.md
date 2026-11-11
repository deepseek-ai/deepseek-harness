---
description: "Run Windows capture comparisons with the installed .NET Framework and review the native runtime migration plan."
---

# Windows capture experiment

English | [中文](README.zh.md)

## Summary

Compare screen copying, window DC copying, and PrintWindow without installing a .NET SDK or third-party library. The private experiment targets .NET Framework 4.8 and uses the compiler and assemblies installed with Windows. It does not replace the provider's capture implementation.

## Table of Contents

- [Run the experiment](#run-the-experiment)
- [Interpret the output](#interpret-the-output)
- [Further Exploration](#further-exploration)
- [Dev Note](#dev-note)

-----

<a id="run-the-experiment"></a>
## Run the experiment

On an interactive x64 Windows desktop, run this command from the repository root in Windows PowerShell. The demo creates two temporary windows, tests a visible green target, covers it while changing its content to blue, then minimizes it. It closes both windows on completion.

```powershell
powershell -NoProfile -File packages/experimental/cua-windows/native/capture-probe/run.ps1
```

The printed output directory contains PNGs and JSON measurements. The script compiles into a unique temporary directory and removes the executable afterward. A new output directory is required for every run. Compilation errors, unavailable windows, and failed captures produce a nonzero exit.

To compare an application you select, pass its decimal top-level HWND and a new output directory. This mode captures its current state without changing focus, position, or visibility. Obtain the HWND with a window inspector; a PID is not a window handle.

```powershell
powershell -NoProfile -File packages/experimental/cua-windows/native/capture-probe/run.ps1 -WindowHandle 123456 -OutputDirectory C:\Temp\cua-capture-example
```

Replace the example HWND and output directory. Repeat with the window covered, after its content changes, and after resizing. The screen-copy image includes whatever occupies those screen coordinates. Keep evidence local when other applications can appear there.

-----

<a id="interpret-the-output"></a>
## Interpret the output

Each capture runs in a separate process with a five-second deadline. A hung capture is terminated and recorded as a timeout. JSON records the API return value, image dimensions, elapsed capture time, sampled foreground change, and counts of known marker colors. A successful API return or a valid PNG does not establish that the image contains current target content.

| Method | Windows facility | What to inspect |
|---|---|---|
| `screen` | `System.Drawing.Graphics.CopyFromScreen` | Whether another window replaces the target pixels. |
| `window-dc` | `GetWindowDC` and GDI `BitBlt` | Whether compositor-backed content is missing or stale. |
| `print` | `PrintWindow`, flags `0` | Whether the target handles print requests. |
| `print-full` | `PrintWindow`, `PW_RENDERFULLCONTENT` | Whether the complete, current client content appears. |

The demo waits until its visible marker reaches the screen before comparing methods. It samples UI Automation from an MTA thread and records the result in `runtime.json`. Marker checks are intended for the owned fixture; other applications require visual comparison against their actual state. This experiment does not test WGC, clipboard restoration, input, service sharing, or ARM64 compatibility.

-----

<a id="further-exploration"></a>
## Further Exploration

- [Provider behavior and desktop acceptance](../../README.md)
- [PrintWindow and its synchronous execution](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-printwindow)
- [Windows SDK capture flags](https://github.com/microsoft/win32metadata/blob/main/generation/WinSDK/RecompiledIdlHeaders/um/WinUser.h)
- [Windows Graphics Capture](https://learn.microsoft.com/en-us/windows/apps/develop/media-authoring-processing/screen-capture)
- [.NET Framework system requirements](https://learn.microsoft.com/en-us/dotnet/framework/get-started/system-requirements)
- [Code Pack window capture source](https://github.com/aybe/Windows-API-Code-Pack-1.1/blob/master/source/WindowsAPICodePack/Shell/Taskbar/TabbedThumbnailScreenCapture.cs)

-----

<a id="dev-note"></a>
### Dev Note

Research and proposed work below are non-authoritative; the production helper still targets .NET 10 and captures through WGC/Direct3D11.

The Windows x64 machine used on 2026-10-20 has Framework release `533509` (4.8.1). The Framework-only probe compiled, queried the owned window through `System.Windows.Automation`, and captured images without NuGet dependencies. The current self-contained production helper is approximately 192 MiB; the probe is much smaller because it implements only this experiment. Its size is not an estimate of a complete port.

For the painted WinForms fixture, all four methods captured the visible green content. After covering the window and changing it to blue, screen copying returned the magenta cover, while window DC copying and both PrintWindow variants returned the new blue content. After minimization, every API reported success but returned only a 314 × 50 image without the content marker. These observations do not establish behavior for other rendering engines or monitors.

For an owned local HTML page in Edge, window DC copying and ordinary PrintWindow returned black images even while visible. Full-content PrintWindow captured the visible green page. After covering it, JavaScript changed the background to blue and updated the title; full-content PrintWindow captured the updated title with the old green client content. The fresh-content requirement remains unresolved for this case, including whether WGC behaves differently. This is a reason to compare rendering engines before replacing the backend.

The capture decision must preserve background window observation. `CopyFromScreen` and desktop duplication observe the composed desktop, so they cannot substitute for covered-window capture. DWM thumbnails display another window in a destination window rather than directly returning PNG pixels. WGC supplies Direct3D11 frames by design; removing the Vortice wrapper does not remove that dependency from the API.

Windows API Code Pack is useful reference material for Shell objects, links, common dialogs, and taskbar integration. Its `TabbedThumbnailScreenCapture` wraps GDI window DC copying and documents limitations for hidden or obstructed controls. It does not provide a general replacement for WGC or target-confirmed clipboard consumption. WinForms already provides ordinary clipboard access, drawing, images, and a message loop; UI Automation is also in the Framework. Add a Code Pack dependency only for a specific capability that removes more maintained code than it introduces.

Proposed implementation order:

1. Compare PrintWindow's full-content mode against WGC on Chromium/Electron, WPF, classic controls, changed covered content, mixed DPI, and a hung target. Keep the saved PNGs and observed state together. Select a production backend only after this comparison; do not silently fall back to screen pixels when a window capture fails.
2. Use .NET Framework 4.8 as the runtime port candidate for x64. Keep `System.Windows.Automation`, WinForms, `System.Drawing`, and Windows P/Invoke. Verify the ARM64 runtime and delivery requirements separately; this x64 experiment cannot establish them.
3. Port runtime APIs deliberately: pipe and mutex access control, cancellation and disposal, hashing, and JSON handling. Framework `JavaScriptSerializer` can emit the probe's JSON, but replacing `System.Text.Json` must preserve protocol validation, duplicate-property rejection, numeric limits, and escaping. `JsonSchema.Net` has a netstandard2.0 asset; the installed Vortice version has only modern .NET assets. Avoid introducing a handwritten JSON/schema framework merely to remove a package.
4. Run the owned desktop smoke and shared-service lifetime checks against the selected runtime, then update source preparation and packaging. Remove superseded implementations and dependencies after those checks pass. Keep the shared `cua` API and the macOS provider outside this Windows runtime change.

The current desktop smoke exposed clipboard prefetch by the Remote Desktop client before the selected editor consumed the data. The pending fix identifies the requesting window's process and leaves the format delayed for other readers. Readers that open the clipboard without an HWND cannot be attributed and time out. The revised native binary cross-compiles, but Smart App Control blocked its execution on this machine. The branch is handed over for human-owned Windows acceptance with an approved signed build or test environment. Earlier smoke results must not be represented as validation of that binary.
