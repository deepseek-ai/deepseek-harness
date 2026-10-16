# Agent Note: Prompt to reload when the Host release changes instead of hot-replacing across releases

Status: implemented

English | [中文](2026-10-14-host-release-change-refresh-prompt.zh.md)

## Problem

After `dsh web` is upgraded, or after a developer restarts `pnpm run dev:web` at another commit, an open browser page reconnects to the new Host automatically while its static shell stays at the old release. When the protocol is no longer compatible, the page keeps failing to reconnect or shows errors, and the user is not told that a reload is required.

Technical causes:

- After a reconnect, [client-hmr](../../../../packages/client/hmr/src/client/index.ts) receives the new Host's complete graph, and [ClientEntries](../../../../packages/client/modules/src/client/entries.ts) hot-replaces plugins by each row's `rev` (the bundle's mtime, ctime, and size). The Vite shell, static libraries, and the bootstrap are never replaced during the page's lifetime.
- The API connection validates its ready frame against an exact key set ([remote-events.ts](../../../../packages/api/gateway/src/client/remote-events.ts)), so an old page cannot recover from a protocol change by itself.
- The page has no way to learn that the Host now runs another release.
- Desktop is unaffected: after its Host is replaced, the main process navigates the window again ([main.ts](../../../../apps/desktop/src/main.ts)).

The [client plugin loading model](../architecture/2026-07-23-client-plugin-loading-model.md) owns the loading chain and hot replacement. It states that static libraries and the shell require a reloaded page; this note owns how the page learns that the Host's release changed and what it does about it.

## Decision

A release is the Host's version identity: a version plus an optional source commit. The name deliberately differs from "build", which names the build process and its artifacts.

The change touches three owners: client-modules (producing, publishing, and comparing the release identity), the shared client build preset (fixing the commit into the Host artifact), and ui-settings-general (the confirmation dialog). web-app and client-hmr are unchanged.

### Behavior

A page applies Host graphs and rebuilt frames only while the connected Host serves the release the page booted from. Every module the page runs therefore belongs to its boot release: either the boot artifacts unchanged, or the boot artifacts plus hot replacements published by a Host of that same release.

| Situation | Behavior |
|---|---|
| The Host serves the boot release; its graph equals the applied graph | Nothing happens. |
| The Host serves the boot release; some module revisions differ | Hot replacement of exactly the changed modules, as before; a shown dialog closes. |
| The Host serves another release (version or commit differs) | Nothing from it is applied, rebuilt frames are ignored, and a dialog shows the Host's and the page's transition. |
| The user chooses **Reload to load the new version** | `location.reload()` boots the page from the Host's release. |
| The user chooses **Not now**, the close control, a mask click, or Escape | The dialog closes; the page stays at its boot release and applies nothing from that Host release; later graphs of that release no longer ask. |
| The Host returns to the boot release | The dialog closes and the usual revision comparison replaces exactly the changed modules; unchanged modules stay. |
| The Host moves to a release other than the dismissed one | The dialog appears again. |

The page remembers only the last dismissed Host release, in page memory; nothing is written to localStorage or IndexedDB. After a reload, the new boot release is the comparison basis.

### Release identity

- Fields: `{ version, commit? }`; two releases are the same only when both fields are equal. Every complete build, released builds included, records the repository commit, so pages compare both fields; a release changes both together.
- `version` is client-modules' own package.json version. All packages release under one version, so it equals the CLI version.
- `commit` is fixed at build time. The shared client build preset [tsdown.client.ts](../../../../packages/client/tsdown.client.ts) injects the same public `process.env.DSH_CLIENT_*` values into the Node half of every client package that it injects into the browser half ([`clientBuildValueDefines`](../../../../scripts/client-build-environment.ts) replaces the named variables and leaves `process.env` itself in place). The client-modules Host code reads `process.env.DSH_CLIENT_COMMIT_HASH`, which is a constant in the built artifact.
- A Host started from TypeScript source has no build step: `pnpm run dev:web` places the build values in the Host process environment, so the Host reads the same commit; a source launch without dev-web publishes the version alone.
- Field values are wire data that the dialog renders verbatim, without localization.

### Wire

```
WebBootRelease { version: string; commit?: string }
WebBootGraph {
  rev; entries; batches   // unchanged
  /** Host release identity; absent from a Host that publishes none. */
  release?: WebBootRelease
}
BootManifest { ...; release?: WebBootRelease }
```

- [ClientModuleRegistry](../../../../packages/client/modules/src/index.ts) computes the release once at construction and `compose()` writes it into every graph; `release` stays outside `graph.rev`. There is no new config field and the composition is unchanged.
- `__DSH_BOOT__` and every SSE `graph` frame carry the field, so one graph frame carries both the Host release and its complete module graph; the client-hmr Host half is unchanged. A rebuilt frame comes from the same Host process as the graph frame before it on that SSE connection, so it inherits that frame's release.
- `parseBootManifest` accepts an absent `release`, rejects a non-string `version` or `commit`, and drops members outside the identity, so equality compares only those two fields. `readRelease` reads only the `release` member of a received graph, so a page compares releases before it validates anything else; a release it cannot read counts as absent. Older pages that do not know the field ignore it.

### Page side

The release comparison lives in [release-change.ts](../../../../packages/client/modules/src/client/release-change.ts); `ClientEntries` consults it from `sync` and `reload`.

```
interface ClientReleaseChange {
  /** Release this page booted from; every module the page runs belongs to it. */
  readonly page: WebBootRelease | undefined
  /** Release the Host served before its latest release change. */
  readonly previous: WebBootRelease | undefined
  /** Release of the connected Host. */
  readonly host: WebBootRelease | undefined
}

class ReleaseChangeGate {
  /** Release change to announce; undefined while the Host serves the boot release or a dismissed one. */
  readonly change: ObservableSnapshot<ClientReleaseChange | undefined>
  /** Whether the connected Host serves the boot release; graphs and rebuilt frames apply only then. */
  get matches(): boolean
  /** Record a received graph's release and update the announcement; true when the graph may be applied. */
  observe(release: WebBootRelease | undefined): boolean
  /** Stop announcing the connected Host's release. */
  dismiss(): void
}

class ClientEntries {
  /** The gate's change. */
  readonly releaseChange: ObservableSnapshot<ClientReleaseChange | undefined>
  /** Stop announcing the connected Host's release; updates stay paused until the Host returns or the page reloads. */
  dismissRelease(): void
}
```

Order of operations:

1. `ClientEntries` creates the gate from the boot manifest's `release`.
2. `sync(graph)` reads the graph's release with `readRelease` and passes it to `observe` before parsing the rest, so a graph of another release is announced even when this page cannot read its format. A graph of the boot release is parsed and reconciles as before, and the existing revision comparison replaces exactly the changed modules. A graph of another release returns without entering the reconciliation queue; its first appearance logs the Host's previous and current identities through `console.warn` and publishes the change unless that release was the last one dismissed.
3. `reload(id, rev)` (a rebuilt frame) returns at once while the Host serves another release.
4. `retry()` keeps reconciling the last applied graph, which always belongs to the boot release.
5. The UI's inject face reloads the page through `location.reload()`; `ClientEntries` does not navigate.

### UI

- Owner: [ui-settings-general](../../../../packages/client/ui-settings-general/src/client/index.ts), which already owns the connection pill (`ConnectionIndicator`) and the Desktop update prompt; its `inject` adds `modules`.
- It registers the `shell.overlay` entry `host-release-change` through `ctx.slots.inject('shell.overlay', ...)` and renders it with `Modal`. The inject face provides `hooks: { releaseChange: ctx.modules.entries.releaseChange }`, `dismissRelease`, and `reloadPage`.
- Copy lives in the zh/en locale dictionaries: a title, one sentence stating that live updates are paused until a reload, and two gray-labelled lines:
  - **Service**: `previous` (gray) → `host` (solid), joined by a 1px solid green arrow because the Host already switched.
  - **Page**: `page` (solid) → `host` (gray), joined by a 1px dashed gray arrow because only a reload completes the switch. Both connectors are a fixed 56px and do not stretch across the dialog.
  - Each line shows versions when its two ends differ in version and commits otherwise; a release or field the page cannot read, including one the Host did not publish, shows **Unknown**. Screen readers read the two lines as text; the arrows are decorative.
- The buttons are **Not now**, which carries `data-modal-autofocus`, and **Reload to load the new version** (primary). The dialog opens without a user gesture, so initial focus keeps the page and an Enter typed into the composer cannot reload it and discard a draft. The close control, a mask click, and Escape act as **Not now** through the shared `Modal` close behavior.

## Alternatives considered

- **Call `location.reload()` automatically**: it can discard unsaved input, and the user should see and confirm the reload.
- **Carry the identity in the API ready frame (`ConnectionHostInfo`)**: when the protocol is incompatible, the ready frame itself may fail to parse, so detection would never run; pausing hot replacement would still belong to `ClientEntries`.
- **Let web-app compose the identity (CLI version + web-app version + commit) and pass it to modules through the `webApp` service and the composition**: it changes web-app's service interface, tests, docs, and the generated API catalog, and makes modules wait for web-runtime activation; the two versions release together, so reading them separately adds nothing.
- **Add a client-modules `commit` config field set from `!!js process.env.DSH_CLIENT_COMMIT_HASH` in the composition**: it reads the environment at run time, and released `dsh web` launches do not set the variable; the commit must be fixed at build time.
- **Read the CLI version by depending on app-boot from client-modules**: it adds a dependency edge, a dependency-policy classification, a tsconfig reference, and a lockfile change, while the package's own version is the same number.
- **Keep the decision logic inside `ClientEntries`**: reconciliation and release comparison are independent concerns; the separate gate keeps `ClientEntries` to a few added lines.
- **Let Not now apply the other release's plugin updates**: the page would run plugins of one release on the shell and static libraries of another, its state could no longer be named by one release, and returning to the boot release would need a second prompt whose two choices end in the same state.
- **Name the field `build`**: it is easily confused with the build process and build artifacts.
- **Reopen a permanently closed SSE stream in client-hmr**: in end-to-end restarts the 404 window never appeared, because the browser's own retry covered connection refusals; the gap is a documented limitation.
- **Store the decision in localStorage**: the decision concerns one page's code, and a reload replaces that code, so it should not outlive the page.
- **Remember every dismissed release**: a page that moves between several Host releases is rare, and asking again after another release appeared costs one click.
- **Keep the identity an opaque string and let the page split version and commit**: the display rule needs the two parts separately, and parsing a concatenated string breaks whenever its format changes.
- **Create a separate UI package**: it needs three more registrations, while ui-settings-general already owns connection state and update prompts.

## Consequences

- An upgraded Host or a dev Host at another commit never hot-replaces plugin code into a page of another release; the page keeps working at its own release until the user reloads.
- While the Host serves another release, plugin updates, including enabling or disabling a plugin on the Host, reach the page only after a reload.
- When a Host returns to the page's release, only modules whose revisions differ are replaced. Revisions come from artifact metadata, so a rebuild of identical code still replaces the rebuilt modules once, without a prompt.
- A composition without the dialog registered still pauses updates from another release and logs the warning; the user sees no prompt.
- The API connection and SSE are independent channels, so an old page can show a protocol error before the dialog appears.
- If a restarting Host answers `/plugins/events` with a non-200 status before registering the route, the browser closes that SSE stream for good, and the page cannot detect a release change until it reloads.
- A source launch without dev-web has no commit, so development detection falls back to version changes.
- Each tab prompts and remembers independently.
- Unit tests pin the gate through `ClientEntries` (same-release replacement, another release applying nothing, the return to the boot release replacing only changed modules, dismissal, absent releases), the manifest parser, the Host-published release, the shared preset's Node-half defines, and the dialog's rendering and callbacks.
