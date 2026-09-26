# Agent Note: Run Desktop through the shared Web application

Status: implemented

English | [中文](2026-09-10-desktop-web-wrapper.zh.md)

The [Electron runtime decision](2026-09-11-desktop-electron-node-runtime.md) supersedes the separate upstream Node executable; other decisions in this note remain applicable.

## Problem

Separate Desktop composition and request transport require their own configuration, module loading, streaming, and asset-serving behavior. Those implementations can omit Web features even when the renderer is shared. Desktop needs its own installation and native controls without maintaining a second application backend.

## Decision

The private Desktop Host invokes the CLI's shared profile runner against the independently owned Desktop profile. The complete Web composition owns authentication, HTTP routes, client assets, RPC, and response streaming. Electron loads packaged static Web assets before the child is ready. Child IPC carries readiness, structured boot injections, and shutdown. The [immediate-window decision](2026-09-09-desktop-immediate-window-and-direct-start.md) owns local-document HTTP forwarding and authenticated WebSocket access; Web retains application dispatch and stream framing.

The shared runner owns profile and Harness-home patches, proxy setup, telemetry defaults, the runtime resolution, configuration reload, and application lifecycle. Desktop initializes profiles from the shared Web template and uses its Plugin Manager in the main application. Electron owns windows, menus, native directory selection, recovery, and release updates.

The [bundled-runtime decision](2026-09-08-desktop-bundled-runtime-and-external-plugins.md) retains separate runtime and plugin storage, bundled pnpm and explicit package ownership. The public CLI continues to reject the reserved Desktop profile. Electron profile preparation and native recovery remain available without a working Host.

Independent package ownership prevents CLI and Desktop from modifying each other’s installations; it does not define a stricter Desktop plugin policy. Desktop delegates registry, store, Git, tarball, local-path, and ordinary-package installation to pnpm with normal user and profile configuration. The Host inherits `NODE_OPTIONS`, `NODE_PATH`, and npm/pnpm environment variables. User build configuration determines which dependency lifecycle scripts execute. This replaces Desktop-specific source, environment, and build restrictions with the same package-manager and loader responsibilities used by Web.

The shared Web plugin manager owns installation, activation, errors, and restart requirements. Electron has no separate plugin-management renderer, preload, shell asset route, plugin IPC, or package-mutation runner. Packaging explicitly selects the main entry and application preload so stale build outputs cannot restore the removed bridge.

Shared `initProfile` creates missing profile files and preserves existing content. The Host computes its runtime resolution with `createRuntimeResolution` and installs it through `PluginPackages`, without writing fallback links. pnpm-managed directories retain priority. Desktop maintains no second runtime-state, lockfile hash, or link reconciliation mechanism.

This partially supersedes the private composition and portless transport in the [packaging decision](2026-08-25-electron-desktop-packaging-and-updates.md). That design avoided listening ports and used framed byte pipes to avoid Base64 expansion and cross-version V8 serialization. Shared HTTP gives up the portless guarantee and assigns serving and authentication to the existing Web implementation. Release identity, signing, process ownership, and native shell features remain active decisions.

Native directory selection in the local application uses a narrow preload IPC call to Electron’s window-owned dialog. Main admits only the current application window’s main frame at `dsh-app://app`; shell, remote, and child frames cannot request it. Concurrent requests share the pending dialog and destroyed windows discard selections. Web backend selection and Host browse are shared.

## Alternatives considered

**Use the Host OS chooser in Electron.** The Host’s macOS AppleScript dialog has no Electron parent window and cannot reliably follow application focus. Electron owns the local dialog while Web keeps its Host chooser; cancellation and errors do not launch a second chooser.

**Maintain a second backend composition and carrier.** This permits a portless application, but every Web route, reload behavior, authentication change, and stream capability needs a Desktop implementation or explicit omission. Reintroduction requires a desktop product requirement that cannot use the Web implementation and justifies that continuing cost.

**Merge CLI and Desktop plugin installations.** Shared boot code does not require shared executable dependencies. Separate installations allow independently qualified releases and plugin versions while their existing data owners govern shared sessions and settings.

**Keep a Desktop link ledger and manifest reconciler.** These duplicate shared profile mechanisms and can reject otherwise usable installations when derived metadata drifts. A single owner of the runtime resolution can protect pnpm directories without maintaining release identity in the plugin profile.

**Keep a separate native plugin-management page.** It can operate while the Web Host is unavailable, but duplicates package operations, renderer IPC, localization, and backend restart handling. Native recovery already supports disabling third-party bundles and backing up the profile patch without the Host. Reintroduction requires a repair operation that this recovery cannot provide.

**Pin registry and store settings, filter runtime environment, and admit only approved plugin sources.** Those rules constrain execution and package selection, but make the same user configuration behave differently in Desktop and Web. Separate installation ownership remains useful without those restrictions. A Desktop-only restriction requires a distinct product requirement instead of following automatically from packaging or plugin isolation.

## Consequences

Desktop inherits Web features through the same boot and serving path. HTTP listener ownership and authentication remain part of application startup. Electron uses the reported Host address and preserves the existing Web document through readiness. The shared Web loading page is available before the Host starts; native recovery remains available when startup fails.

User-selected runtime options, package sources, and permitted lifecycle scripts can affect Host execution, load third-party code, or cause startup failure. The shared Web manager owns package-failure handling; Electron retains native recovery for fatal startup failures. The signed core runtime does not attest to user-installed plugin code.

Verification requires shared-runner coverage, authenticated HTTP asset and API delivery, configuration reload, native directory selection, child shutdown, and recovery after plugin failure. Installed-platform and real-model GUI qualification remain distinct from unit tests; this note records no measured startup or transfer improvement.
