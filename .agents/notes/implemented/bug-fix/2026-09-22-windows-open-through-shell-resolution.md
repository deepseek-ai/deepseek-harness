# Agent Note: Windows opens go through explorer.exe

Status: implemented

English | [中文](2026-09-22-windows-open-through-shell-resolution.zh.md)

## Problem

The Windows desktop client's settings sheet offers **Open configuration file**, which prepares the active profile's `cordis.patch.yml` and hands the path to the native text-document opener (issue #4428). On the reporting machine the gesture opened nothing and reported nothing. The opener ran `powershell.exe -NoProfile -Command "Invoke-Item -LiteralPath '<path>'"`, so an association resolved inside the host process decided the outcome, and `Invoke-Item` exits 0 when that resolution finds no application.

That machine records the `.yml` default only in `HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.yml\UserChoiceLatest` (progid `VSCode.yml`), with no `UserChoice` record and no `HKCU\Software\Classes\.yml` default. Explorer opens VS Code on a double-click of the same file. Run from the host process, `Invoke-Item`, `cmd /c start`, the `Shell.Application` default verb, and `AssocQueryString` all reported no application for that extension, and `cmd /c start` displayed the shell's own application chooser instead of opening one. `Invoke-Item` still exited 0, so `SettingsController.openSettingsDocument` answered `{ opened: true }` and the sheet rendered no error.

## Decision

`openWindowsPath` hands the path to `explorer.exe` as one argv element, and `revealNativePath` reaches the same shell through the shared `runExplorer` helper. Both encode the target as a file URI with its commas and equals signs percent-encoded, because Explorer parses its own command line and splits fields at both — a raw path containing either opens a different target without reporting it. Nothing else is escaped: Explorer rejects percent-encoded non-ASCII in a file URI and falls back to Documents, so those characters reach it literally. Explorer performs the default-application resolution a double-click performs, so the shell's answer — including a default recorded only in the newer per-user record — selects the application, and a machine with no handler at all gets Explorer's own "How do you want to open this file?" chooser instead of silence.

`runExplorer` holds the one Explorer invocation rule for both operations: exit code 1 is the handoff Explorer returns after passing the request to the desktop process already running, and it resolves the caller's promise; every other failure and every cancellation still rejects. The helper replaced the PowerShell command string, and with it `powershellLiteral` and its single-quote doubling: a path crosses the process boundary as an argv element, which removes the shell-layer escaping rather than the encoding Explorer's own parser requires. `explorerTarget` owns that one encoding step for both intents.

Windows still names no browser for HTML and SVG, so `openInBrowser` continues to decline the platform and the default, association, and text-editor intents all reach the same Explorer handoff.

## Alternatives considered

**Keep `Invoke-Item`.** Rejected. It asks a different resolver than the shell does, so a user whose default Explorer honors can still get a silent no-op, and its zero exit code removes the error the sheet would otherwise render.

**Resolve the default inside the host process.** Rejected. Reading `UserChoiceLatest`, then `UserChoice`, then the classes default, and launching the winning progid's `shell\open\command` reimplements an order Windows owns, including the `UserChoice` hash Windows validates; the shell's own answer is the definition of the application a double-click uses.

**`cmd /c start <path>`.** Rejected. It needs a command shell for the same resolution Explorer already performs, and it reported no application on the machine that reproduced the defect.

**Fall back to a fixed editor when no application resolves.** Rejected. A Windows installation always ships a usable editor, but choosing it in the opener would override the user's association and turn a missing association into a silently wrong application.

## Consequences

The settings sheet's open gesture and the artifact and workspace opens share one Windows behavior: the application a double-click would launch. A machine whose recorded default Explorer honors but `AssocQueryString` does not — the reported state — now opens the configured editor.

The opener can no longer distinguish "the shell opened it" from "the shell declined": Explorer reports 0 or 1 for both, so the Remote still answers `{ opened: true }`, and a machine with no handler shows the shell's chooser as its only feedback. Nothing here verifies that a window appeared.

An interactive desktop session is a precondition. In a non-interactive Windows session (a service, or a scheduled task without an interactive logon) `explorer.exe` invokes no association and still exits 1, so that exit code does not tell this case apart from a delegated open: an SSH session 0 on Windows 11 ARM64 build 26200 measured exit code 1 after about a second, where an `Invoke-Item` command resolved the association in-process. A Host started that way loses the capability and pays the wait, and a caller's abort signal is what bounds it. No fallback for that session is implemented.

Directories take the same path. The rejected alternative recorded in [the open-in-app note](../feature/2026-08-25-promote-open-anywhere-plugin.md) was a detached, credential-scrubbed `explorer.exe <dir>` spawn, which is not what this handoff does: the `explorer.exe` child inherits the host environment and no detached process is created, while the application or folder window Explorer delegates to starts from the desktop session's environment rather than the host's.

## Verification

`path-opener.spec.ts` pins the encoded file URI Explorer receives for both intents, the accepted delegate exit code 1 for an open and a reveal, and the preserved failure and cancellation. `resolver.spec.ts` pins the open-in-app route's Windows command. Native desktop verification stays on Windows, per the package's test policy. On Windows 11 ARM64 build 26200 an independent pass drove the module's own `openNativeAssociatedPath`, `openNativePath`, and `openNativeTextFile` from a sha256-matched copy beside an association probe that recorded every argument the shell passed: each comma-bearing target arrived complete as `%2C`, a plain file opened, and a directory named for a comma opened as a window rooted there. The negative control — the same file as a file URI whose comma is left raw — invoked no association and opened the user's Documents folder, and still exited 1. Exit 1 therefore records the delegation rather than the outcome, so accepting it cannot turn a wrong target into a success; the encoding is what keeps the path whole. Nothing here observes a window. A later pass on the same build read the shell's own window and selection state instead of pixels: the encoded `/select,` target selected the named file; an unencoded `=` opened Documents instead of the file; and a target whose non-ASCII characters stay percent-encoded opened Documents where the literal characters opened the file.
