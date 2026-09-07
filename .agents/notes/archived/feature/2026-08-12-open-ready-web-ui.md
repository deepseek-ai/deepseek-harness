# Agent Note: `dsh web` opens its ready page

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-12-open-ready-web-ui.zh.md)

## Problem

`dsh web` bound the HTTP server and printed its canonical local URL, but left the user to copy that URL into a browser even though the root README described the command as opening the Web UI. A browser handoff also cannot run at the server's bind callback alone: the API routes, browser plugin roster, and static fallback may still be mounting, so the first page request could observe an incomplete application that the process is about to reject.

## Decision

The Web app's command provider resolves `openBrowser: true` for an ordinary invocation and `false` for `--no-open`. The bundle passes that value into its `web-runtime` row; deployments may still replace the complete row config explicitly. The runtime samples inherited `SSH_CONNECTION` and `SSH_TTY` once during activation and suppresses browser handoff when either is non-empty, because the process then serves remote host loopback while the SSH client or editor owns the user's local forwarded address.

The Web runtime treats URL printing and browser opening as separate actions at one readiness point. It waits for the complete Loader tree to settle and confirms that `webServer` is still live, then prints the configured URL line and, outside SSH, prints `dsh web: opening the default browser; pass --no-open to disable` immediately before handing the canonical loopback URL to the operating system's default browser. An SSH launch keeps the host URL line so the operator can identify the remote port, but cannot derive or open the forwarding owner's local address. A deployment that explicitly binds all interfaces still opens loopback locally while the printed LAN URL remains informational; the CLI rejects `--host 0.0.0.0`. `openBrowser` and `printUrl` can be disabled independently.

The handoff uses the maintained `open` package for macOS, Windows, Linux, containers, and WSL. A short-lived Node helper invokes that package with the canonical scrubbed child environment, so Harness credentials and `DSH_*` state do not reach the operating-system launcher or a newly started browser. `BROWSER` is a launch-only command selector: app boot rejects it in a discovered `.env`, while only an inherited value can reach a compatible opener path that honors the variable. On Windows the helper waits for the short-lived PowerShell launcher to exit because `open` resolves when that process spawns, before it has handed the URL to the shell; other platforms stop after the opener accepts spawn. The runtime never waits for the browser to exit. The parent reads helper stderr so a failure writes one English diagnostic with the specific reason and manual URL to stderr without disposing the already-ready server; a later browser exit is outside the handoff result.

Unit coverage pins command defaults, `--no-open`, SSH suppression, readiness ordering, teardown and failure suppression, helper outcomes, stderr reason propagation, the Windows launcher lifetime, the scrubbed helper environment, the inherited-only `BROWSER` rule, the pre-handoff opt-out status, and the reason-bearing non-fatal diagnostic. A real Loader composition binds an OS-assigned port, serves the actual static fallback, replaces only the operating-system handoff, and requests the handed-off URL immediately to prove it is already reachable. Assembled keyless snapshots run the built `dsh web` command locally, with a failing opener, with VS Code plus SSH markers, and from a project that declares `BROWSER`: the local case verifies that the handed-off page is the printed, reachable page containing the boot manifest while credential and Harness-state variables are absent from the opener; the failure case verifies the stderr reason and manual URL after readiness; the remote case verifies that the host URL remains visible without a browser launch; the file-layer command case fails before readiness or handoff. Repository browser and packaging tests pass `--no-open` because they own their browser or run unattended.

## Alternatives considered

**Open from the CLI launcher** — rejected because the launcher deliberately knows only profile selection and cannot derive the OS-assigned port or the app-owned Loader settlement point without reversing the app-owned command-line decision.

**Open from `dsh-host-webserver` when its socket binds** — rejected because that package is a generic route carrier with no shell or frontend knowledge, and socket readiness precedes application readiness.

**Infer whether to open from TTY, CI, editor, display, container, or WSL variables** — rejected because those signals do not establish a host/browser split and misclassify detached terminals and desktop launches. Non-empty `SSH_CONNECTION` or `SSH_TTY` is narrower evidence: it identifies a remote host whose loopback URL is not the forwarding owner's local URL. The default plus explicit `--no-open` remains stable for non-SSH launches.

**Require Enter before opening the browser** — rejected for the local default because it turns ordinary server startup into a second stdin-owned interaction and excludes desktop or supervised launches with no usable terminal. `--no-open` remains the explicit opt-out for a caller that owns the browser or wants a server only.

**Hand-roll platform commands** — rejected because URL opening has distinct macOS, Windows, Linux, container, and WSL behavior. The maintained dependency owns those platform branches while this package retains only readiness and failure semantics.

## Consequences

An ordinary local `dsh web` invocation announces the automatic handoff and its `--no-open` opt-out, then opens one ready page without making the generic HTTP carrier desktop-aware or exposing its ambient credentials to the desktop launcher. An SSH invocation prints the remote host URL but leaves opening the forwarded local address to the SSH client or editor. A discovered `.env` that sets `BROWSER` fails launch instead of selecting an executable; a platform opener that honors the variable can read it only when the operator exports it in the launching shell. Other unattended consumers must pass `--no-open`; a handoff failure writes its reason and manual URL to stderr while preserving the usable server. The Web app gains the locked `open` dependency, the shared subprocess environment scrubber, and the opener's transitive platform helpers; it does not own, wait for, or terminate the browser after the operating-system handoff succeeds.
