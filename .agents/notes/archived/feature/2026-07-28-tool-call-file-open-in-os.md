# Agent Note: Tool-call file open in OS

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-28-tool-call-file-open-in-os.zh.md)

## Problem

Chat tool rows treated the whole summary line as a click target that opened the right-hand details panel, with a hover background on the row. For filesystem tools the useful action is opening the mentioned file in the operating system's default application, not inspecting the raw tool payload in a sidebar.

## Decision

File-tool path summaries (`read` / `write` / `edit` args carrying `path` or `file_path`) render as links underlined at rest with a pointer cursor. Clicking the path calls `session/openWorkspacePath` through the chat view's `openFile` injection; the chat view resolves relative paths against the addressed Session's cwd when it is known. File-link rows disable args expand (leading icon is inert); whole-row click, row hover fill, and the click-to-open-details gesture are removed from tool rows (including bash and todo registrations). The details panel and its inject surface remain for programmatic selection; rows no longer drive them.

`session/openWorkspacePath` uses the authenticated Remote carrier, while the product UI offers the gesture only on a loopback page whose `session/canOpenWorkspacePath` result is true. Platform adapters open without a shell: `open` on macOS, PowerShell `Invoke-Item` on Windows, and `xdg-open` on desktop Linux; browser-renderable documents prefer the named default browser on macOS and desktop Linux. WSL is a separate host shape despite Node reporting `linux`: the adapter recognizes its environment or Microsoft kernel release, translates the Linux path with `wslpath -w`, and passes the resulting Windows/UNC path to the same PowerShell handoff. The opener's platform facts and command runner are injectable for tests. URL-only read args (`web_fetch`) are not file links.

## Alternatives considered

- Keep row-click details and add a separate file affordance — rejected; the product ask replaces the row gesture with the file link.
- Open files inside an in-app preview — rejected; the ask is the OS default application.
- Treat WSL as desktop Linux — rejected; a WSL process reports `linux`, but a Linux desktop association is optional while its ordinary operator desktop and browser live on Windows.
- Reuse `host.pickDirectory`'s timeout exemption — unnecessary; path open hand-off completes quickly under the normal unary deadline.

## Consequences

Clicking a file path in a tool row opens that path on the host. Non-file tool rows are inert summaries (expand toggles remain where the row already supported them). The Client withholds the file-open gesture on non-loopback pages; every exposed Host invocation still requires the browser session. A Host or OS refusal is owned by the chat view: it shows the thrown reason and retries the same path ([file-open failure](../bug-fix/2026-08-18-tool-row-file-open-failure.md)).

## Risks

- Desktop Linux hosts without `xdg-open`, and WSL hosts without working Windows interop (`wslpath` plus `powershell.exe`), fail the RPC; the chat view shows that Host error and offers retry.
- Relative paths without a session cwd are forwarded verbatim and may fail on the host.
