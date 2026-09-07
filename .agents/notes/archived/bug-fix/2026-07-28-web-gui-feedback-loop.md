# Agent Note: Web GUI changes close the loop on the existing URL

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-28-web-gui-feedback-loop.zh.md)

## Problem

The Web agent could identify neither the GUI hosting its session nor the URL the user was viewing. The [runtime-context decision](2026-07-28-web-agent-runtime-context.md) supplies the first fact, but a GUI edit still had no executable acceptance target: source edits, artifact builds, a listening process, and the user's existing page were unrelated observations. Repository affordances made a wrong substitute look valid because `apps/web/package.json` exposed `vite` as its `dev` script and bare Vite returned HTTP 200 even though it could not inject `window.__DSH_BOOT__`.

The [incident post-mortem](../../../../docs/postmortem/0003-web-agent-gui-feedback-loop.md) owns the event-log timeline and why the original checks accepted the wrong page, process, and port.

## Decision

The ordinary `dsh web` composition mounts the Web bundle's `web-runtime` plugin, which publishes one canonical loopback URL as both model-visible orientation and a managed shell fact. The `app:web-surface` prompt section says that unqualified references identify this GUI and names the URL; `DSH_WEB_URL` carries the same fact into every foreground or managed background bash call. The section preserves the no-implicit-DOM, route, or screenshot boundary and does not claim that a LAN alias equals the browser's literal address. A complete-prompt profile sets the row's `surfaceContext` to false and receives neither the prompt section nor the managed variable; the Web launcher uses the same setting to suppress its source-checkout prompt section.

The prompt makes the agent, rather than the user, own the hidden startup contract. The client-plugin HMR receiver is always mounted, but automatic client-plugin reload additionally requires a same-checkout `pnpm run dev:web` watcher, which the agent verifies before promising no-refresh updates. Shell and other plain-package changes still require rebuilding the affected artifacts and refreshing the existing URL. The agent does not launch a replacement GUI unless asked.

The `apps/web` development script and Vite configuration reject serve mode before opening a port. Their diagnostics identify `apps/web` as a build-only shell, explain that only `dsh web` injects `window.__DSH_BOOT__`, and name the production and HMR entry paths. Vite build mode remains unchanged.

No server restart or replacement is required merely because static artifacts changed. The host reads `index.html` and static assets on each request, while client bundles are also served from their current files with `no-cache`; a refresh of the existing URL is therefore the acceptance path after the relevant shell and plugin bundles are rebuilt. Starting a separate server proves only that a separate server works. If the user explicitly requests another long-running server, the existing managed background-job contract owns its lifecycle and completion notices; shell `&` is not an alternative lifecycle.

## Verification

The keyless fresh-round-trip browser scenario boots the shipped Web composition, drives a real replayed session, snapshots the URL-bearing system-prompt prefix, and invokes the assembled bash tool to prove `$DSH_WEB_URL` matches the actual bound runtime. The real CLI smoke launches `dsh web` and captures the provider request, pinning the complete two-command development contract. The `dev:web` watcher test rebuilds an isolated client bundle after a source change; the browser HMR scenario launches `dsh web`, changes an initial roster bundle, and observes the new DOM under the same page identity. A real Vite subprocess test requires serve mode to exit naturally with the full-host correction and instruments `Server.listen()` to prove it was never called. The real-Loader webserver test rewrites a static asset after the process binds and proves the same port returns the new bytes. These assertions inspect prompt state, process exit, shell output, DOM identity, and HTTP bytes rather than an agent's success statement.

## Alternatives considered

**Extend only the system prompt.** Rejected because it would leave the target unavailable to tools, preserve the misleading bare-Vite path, and fail to prove how an existing process observes rebuilt artifacts.

**Remove the `apps/web` development script without guarding Vite.** Rejected because `npx vite`, the exact incident command, bypasses package scripts. Serve mode itself must fail.

**Automatically restart or replace the current Web process after every edit.** Rejected because the static server already reads current artifacts per request, a restart would interrupt the session that requested the edit, and client-plugin reload is owned by the always-mounted HMR chain plus the `pnpm run dev:web` watcher.

**Send DOM, route, or screenshots with each request.** Deferred to a separate logged-input design. Stable URL identity closes this feedback loop without claiming browser state the host does not receive.

## Consequences

Ordinary Web prompts gain a dynamic URL paragraph, so provider prefix reuse now varies by bound port. Their Bash processes gain one non-secret managed environment variable. Bare Vite can no longer be used as a shell-only visual sandbox; developers use the full host or build mode instead. In exchange, GUI work has one mechanically observable target, the agent can teach the user the exact update behavior of the process actually serving their session, and the unsupported startup path fails before a white screen. The URL contract guides the agent away from replacement ports; it does not prohibit arbitrary shell commands from starting one. Profiles that disable `surfaceContext` also give up this feedback-loop guidance and shell context.
