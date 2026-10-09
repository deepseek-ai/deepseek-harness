# Agent Note: Windows persistent PTYs use the console host node-pty ships

Status: implemented

English | [中文](2026-09-28-pty-bundled-console-host.zh.md)

## Problem

The master `serial / windows (self-hosted standby)` drill has been red since 2026-09-15: its `test:coverage` gate fails on `packages/shell/tool-pwsh-persistent/tests/loader-composition.spec.ts`, either with `settleReasons` reporting one `stdin_read` among six `inferred_idle` settlements or with the case exhausting its 120 s budget. The same case passes in 5.3 s on the Blacksmith Windows image.

Windows has no exact stdin-wait tier: `WindowsProcessInspector.isStdinWaiting()` always returns false and `foregroundPgid()` returns the shell pid, so `inspectForeground()` can only report `inputWaiting: false`. The persistent-pwsh readiness path therefore settles `stdin_read` only after it has seen both the OSC `133;D;` marker and the printable `dsh> ` tail written by the same prompt render (`terminal-bash/src/session.ts`).

Probing the pool machine directly (node-pty 1.2.0-beta.15, `pwsh -NoLogo -NoProfile`, 160x40, `TERM=dumb`) shows why that tail never matches there: once a command's output scrolls the viewport, the console host Windows itself provides replays the prompt line as `\ndsh>\x1b[1C` — a leading newline, the prompt text without its trailing space, and a cursor-forward escape in place of that space. `TerminalSanitizer` accumulates the printable text after the marker, so the tail becomes `\ndsh>`, which neither equals `dsh> ` nor prefixes it, and every later send waits out the silence tier. Five of seven prompts took that form on the pool machine; the same command sequence on Windows 11 25H2 (conhost 10.0.26100.1) renders `dsh> ` verbatim. The [seen-marker tail grace](2026-09-27-pwsh-prompt-tail-grace.md) recorded the same red signal as a late tail and shipped `promptTailGraceMs`; this measurement replaces that attribution for these hosts, because a tail that has already arrived in a non-prefixing form never satisfies the condition the grace extends.

## Decision

`subprocess-local` allocates Windows terminals with node-pty's `useConptyDll: true`, so the PTY is backed by the OpenConsole the node-pty package ships instead of the console host the operating system provides. The option is set only when the runtime platform is `win32`; POSIX allocation is unchanged.

The same command sequence on the pool machine through the bundled console host rendered `dsh> ` for all seven prompts.

## Alternatives considered

**Rely on `promptTailGraceMs`, the grace shipped for late tails.** Rejected: the extended bound applies only while the arrived tail still prefixes `dsh> ` (`tailPending` in `terminal-bash/src/session.ts`). A pool prompt renders `\ndsh>`, which prefixes nothing in that comparison, so the grace is never reached and the sends keep settling on the plain silence bound.

**Teach `TerminalSanitizer` to tolerate the operating system console host's rendering.** Rejected: normalizing the leading newline and `CSI nC` into the tail keeps the readiness path working, but it writes one console host's quirk into the sanitizer and leaves any other repaint form to reintroduce the same divergence. The console host is a replaceable component, and the package already ships a current one.

**Keep the operating system console host and accept the red drill.** Rejected: the drill is the only continuous evidence that the in-house Windows pool can take over the required lanes, and it has been red for two weeks.

**Upgrade the pool machines' Windows.** Rejected as this repository's fix: it requires rebuilding production CI hosts (Server 2022, Windows 10 22H2), and the rendering difference returns on any host that is not current.

## Consequences

Windows PTY allocation now depends on node-pty's bundled OpenConsole binaries. The desktop runtime file policy already retains `node-pty/prebuilds/win32-x64/conpty/conpty.dll` and `OpenConsole.exe`, and the package resolves them relative to its own addon, so the packaged desktop runtime keeps working; that policy is now load-bearing for terminal allocation rather than only for keeping the source distribution intact.

Console signals keep their documented behavior: SIGINT is still delivered as a `\x03` input write that the console host turns into a console-wide CTRL_C event, and the Windows inspector is unchanged. The allocated process id still names the shell: on the pool machine `pty.pid` resolves to `pwsh.exe` and equals the shell's own `$PID` under both console hosts. node-pty marks `useConptyDll` experimental, so a node-pty upgrade can change it; a unit test pins the option as present for `win32` and absent elsewhere. Both teardown paths still publish node-pty's exit event on the pool machine under the bundled host (about 1.1 s for a `taskkill` tree kill and for a bare `kill()`), and an unresolvable `conpty/conpty.dll` fails loud: node-pty throws instead of falling back to the operating system host.

## Testing

`packages/subprocess/subprocess-local/tests/local.spec.ts` pins the option per platform: present for `win32`, absent for a POSIX platform. The end-to-end signal for the pool is the next master push's `serial / windows (self-hosted standby)` run, whose sends settle on the prompt path instead of the silence bound. No e2e, snapshot, or sandbox case applies: this change selects a PTY backend and produces no model- or product-user-visible output of its own. The packaged runtime keeps the assets this option resolves, pinned by the retained-file assertions in `apps/desktop/tests/runtime-file-policy.spec.ts`, and the Electron payload smoke passes the option when it allocates a PTY from that tree on Windows, so the packaged path and the separately pinned retained-file list are both exercised.
