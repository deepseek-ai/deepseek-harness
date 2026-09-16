# Agent Note: Run Desktop through the shared Web application

Status: implemented

English | [中文](2026-09-10-desktop-web-wrapper.zh.md)

The [Electron runtime decision](2026-09-11-desktop-electron-node-runtime.md) supersedes the separate upstream Node executable; other decisions in this note remain applicable.

## Problem

Separate Desktop composition and request transport require their own configuration, module loading, streaming, and asset-serving behavior. Those implementations can omit Web features even when the renderer is shared. Desktop needs its own installation and native controls without maintaining a second application backend.

## Decision

The private Desktop Host invokes the CLI's shared profile runner against the independently owned Desktop profile. The complete Web composition owns authentication, HTTP routes, client assets, RPC, and response streaming. Electron loads packaged static Web assets before the child is ready. Child IPC carries readiness, structured boot injections, and shutdown. The [immediate-window decision](2026-09-09-desktop-immediate-window-and-direct-start.md) owns local-document HTTP forwarding and authenticated WebSocket access; Web retains application dispatch and stream framing.

The shared runner owns profile and Harness-home patches, proxy setup, telemetry defaults, module fallbacks, configuration reload, and application lifecycle. Desktop initializes profiles from the shared Web template's bundles and uses Web's automatic directory-picker selection, keeping application defaults under one owner. Desktop uses a separate default listener port so both applications can run concurrently; profile configuration can override it. Shell windows, menus, plugin management, recovery, and updates remain Electron responsibilities.

The [bundled-runtime decision](2026-09-08-desktop-bundled-runtime-and-external-plugins.md) retains separate runtime and plugin storage, bundled pnpm and explicit package ownership. The [in-place decision](2026-09-09-desktop-in-place-profile.md) retains package transactions and partial-failure recovery. The public CLI continues to reject the reserved Desktop profile.

Independent package ownership prevents CLI and Desktop from modifying each other’s installations; it does not define a stricter Desktop plugin policy. Desktop delegates registry, store, Git, tarball, local-path, and ordinary-package installation to pnpm with normal user and profile configuration. The Host inherits `NODE_OPTIONS`, `NODE_PATH`, and npm/pnpm environment variables. User build configuration determines which dependency lifecycle scripts execute. This replaces Desktop-specific source, environment, and build restrictions with the same package-manager and loader responsibilities used by Web.

App-boot owns installed-dependency discovery, installation-first bundle declaration resolution, and bundle-list updates after pnpm succeeds. CLI selects automatic activation; Desktop explicitly preserves bundles disabled through its UI. The policy difference belongs to the visible activation control, while metadata handling and reconciliation remain shared.

Shared `initProfile` creates missing profile files and preserves existing content. The Host’s `healIsolatedProfileModuleFallback` is the sole owner of installation and bundle projections; package operations use shared `unlinkProfileModuleFallback` to detach only its own links before pnpm. pnpm-managed directories retain priority. Desktop maintains no second runtime-state, lockfile hash, or link reconciliation mechanism. One-time cleanup of `desktop-runtime-state.json` removes only matching recorded links and retires that metadata.

This partially supersedes the private composition and portless transport in the [packaging decision](2026-08-25-electron-desktop-packaging-and-updates.md). That design avoided listening ports and used framed byte pipes to avoid Base64 expansion and cross-version V8 serialization. Shared HTTP gives up the portless guarantee and assigns serving and authentication to the existing Web implementation. Release identity, signing, process ownership, and native shell features remain active decisions.

## Alternatives considered

**Maintain a second backend composition and carrier.** This permits a portless application, but every Web route, reload behavior, authentication change, and stream capability needs a Desktop implementation or explicit omission. Reintroduction requires a desktop product requirement that cannot use the Web implementation and justifies that continuing cost.

**Merge CLI and Desktop plugin installations.** Shared boot code does not require shared executable dependencies. Separate installations allow independently qualified releases and plugin versions while their existing data owners govern shared sessions and settings.

**Keep a Desktop link ledger and manifest reconciler.** These duplicate shared profile mechanisms and can reject otherwise usable installations when derived metadata drifts. A single fallback owner can protect pnpm directories without maintaining release identity in the plugin profile.

**Pin registry and store settings, filter runtime environment, and admit only approved plugin sources.** Those rules constrain execution and package selection, but make the same user configuration behave differently in Desktop and Web. Separate installation ownership remains useful without those restrictions. A Desktop-only restriction requires a distinct product requirement instead of following automatically from packaging or plugin isolation.

## Consequences

Desktop inherits Web features through the same boot and serving path. HTTP listener ownership and authentication remain part of application startup. Electron uses the reported Host address and preserves the existing Web document through readiness. The shared Web loading page is available before the Host starts; native recovery remains available when startup fails.

User-selected runtime options, package sources, and permitted lifecycle scripts can affect Host execution, load third-party code, or cause startup failure. Desktop accepts these effects under the same configuration ownership as Web; the signed core runtime does not attest to user-installed plugin code. Package or loading failures retain explicit repair and the native recovery dialog rather than triggering stricter admission checks or automatic rollback.

Verification requires shared-runner coverage, authenticated HTTP asset and API delivery, configuration reload, native directory selection, child shutdown, and recovery after plugin failure. Installed-platform and real-model GUI qualification remain distinct from unit tests; this note records no measured startup or transfer improvement.
