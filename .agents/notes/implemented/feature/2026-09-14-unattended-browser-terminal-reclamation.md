# Agent Note: Two-hour reclamation of unattended browser terminals

Status: implemented

English | [中文](2026-09-14-unattended-browser-terminal-reclamation.zh.md)

## Problem

A browser can disappear without closing its terminal tabs. Keeping every abandoned terminal retains shells, descendant processes and screen buffers indefinitely. Output subscriptions do not identify abandonment: hidden tabs and inactive Sessions legitimately stop following the screen.

## Decision

A browser terminal is reclaimed only after no window holds it and the Host continuously confirms idle activity for two hours. Running work and unknown activity cancel the idle deadline. When work finishes, a fresh full grace period starts; command runtime and output silence never impose a deadline. Explicit tab close and Session or Host disposal retain their authority to terminate work.

| Situation | Behavior |
|---|---|
| A connected window holds the tab, including a collapsed sidebar or inactive Session | Retain the terminal. |
| One of several holding windows disappears | Retain while another window holds it. |
| The final window disappears while a command is running, stopped, waiting for input, or running in the background | Preserve the work, regardless of runtime. |
| No window holds a positively confirmed idle terminal | Start the full grace period and recheck before cleanup. |
| A window returns before cleanup | Reattach the same process and cancel reclamation. |
| The saved process is gone | Preserve the tab and show localized unavailability with a New terminal action. Only an explicit click replaces it in place with a fresh identity. |

For example, a window disconnecting at 14:00 while a command runs until 20:00 cannot cause reclamation before 22:00. The deadline starts at the first subsequent confirmed idle observation.

The [sidebar](../../../../packages/client/ui-sidebar-right/README.md#state) persists layout per Session and publishes `openTabs` metadata for saved and adopted Sessions. Startup discovery does not mount dormant content, pin files or activate Agents. Adopted stores are authoritative within their window; another window's storage writes cannot revoke those live holds. Permanent scope removal drops its metadata.

The terminal provider intersects that inventory with its own saved terminal associations and unfinished close requests. Each window uses one `retain(sessionId, id, signal)` Remote stream per distinct terminal. Its acknowledgement grants a hold without screen output, Agent activation, input control or creation. Restored output waits for an acknowledged current hold. Transport generations cancel independently, and the existing Gateway reconnect and heartbeat mechanisms own transport liveness.

The subprocess seam supplies `inspectActivity()` with a state and revision. Ordinary non-login Bash 4.4+ and Zsh launches support opt-in lifecycle records, combined with complete process-table observations and original process identities. Zsh distinguishes an empty top-level editor prompt from `vared`, selection and continuation input. Input invalidates prompt evidence; background and stopped descendants prevent idle. Native Linux also checks the systemd task count so escaped descendants still inside its owned scope remain protected. Custom traps, asynchronous Zsh descriptor handlers, unsupported launches and incomplete observations remain unknown. Lifecycle files are private and disappear after successful cleanup.

The Host [terminal controller](../../../../packages/api/terminal-controller/README.md#use-this-package) owns configurable `unattendedTimeoutMs` (7200000), `activityPollIntervalMs` (30000) and `cleanupRetryMs` (60000). Zero disables automatic reclamation only. It uses a monotonic clock; stale observations after gaps longer than twice the polling interval reset the grace period. Input and hold changes invalidate in-flight observations. A successful final check marks the identity closed before asynchronous termination, preventing late creation and admission. Closed identities cannot be reused, and each cleanup remains attached to its original Session owner.

Cleanup awaits provider quiescence and final screen output. Failure retains ownership, rejects new holders and schedules one retry without a new idle grace. Failed allocation cleanup follows the same retry policy. Owner disposal stops timers and streams and joins cleanup and observations before reporting failures, including when cleanup rejects before an observation settles. No Agent terminal tool, model input or Session event changes.

Peer research on Codex thread unloading, OpenCode Location scopes and [VS Code PTY grace periods](https://github.com/microsoft/vscode/blob/main/src/vs/platform/terminal/node/ptyService.ts) informed separate references and delayed cleanup. The two-hour value is DSH product policy, not an industry default. The [browser-terminal decision](2026-09-09-web-sidebar-terminal.md) and [layout/provider recovery decision](../architecture/2026-09-14-sidebar-layout-provider-recovery.md) remain active because their resource ownership and persistence separation still apply.

## Alternatives considered

**Count output followers.** Switching tabs or Sessions stops output subscriptions without abandoning the corresponding terminal. Window holds track open layout membership instead.

**Kill every disconnected terminal after two hours.** A hard deadline would kill legitimate long-running commands. Busy and unknown work therefore has no automatic maximum runtime.

**Infer idle from silence, low CPU or foreground identity.** Silent builds, sleeping jobs, shell builtins and commands waiting for input can satisfy these signals without completing. Positive lifecycle evidence and owned-job observations are both required.

**Restore only the visible Session or retain every saved association.** The first loses dormant holds after refresh; the second lets obsolete associations keep abandoned processes alive. The layout/provider intersection represents the window's actual tabs.

## Consequences

Idle abandoned terminals have bounded retention while connected windows and long-running work survive refreshes and presentation changes. Busy, hung or permanently serving commands may remain indefinitely; so may unsupported shells and uncertain process observations. Explicit close remains available. PowerShell, fish, Windows, custom shell arguments and sandbox-wrapped launches currently report unknown activity.

Root-shell exit does not authorize killing descendants. Failure to enumerate Linux processes is an unavailable observation, not an empty process range; activity stays unknown and cleanup retains ownership. Empty native Linux ranges and complete empty Linux sessions can permit cleanup of exited records. macOS cannot confirm an unobserved range after root exit and may retain its record until explicit close or owner disposal. Existing provider limits on escaped, unobserved descendants remain; the lifecycle record is not a security barrier against hostile same-user processes.

Browser storage failure leaves current memory state usable but cannot guarantee recovery of dormant Sessions after reload. Host restart cannot restore PTYs. Screen history and per-Session terminal quotas retain their existing bounds; no separate unbounded expiry-reason cache is added.

Fake-clock tests cover deadlines, reconnect races, observation invalidation and cleanup retries. Real PTY tests cover silent commands, builtins, background and stopped jobs, Zsh editing modes, startup files and traps. Browser tests cover persistent layouts, multiple windows, collapsed reload, transport loss, retained process identities, explicit replacement of unavailable tabs and reconnection to the original process after transport loss. The keyless recorded Session scenario verifies file-preview layout recovery.
