# Agent Note: Package and update the Electron desktop application

Status: implemented

English | [中文](2026-08-25-electron-desktop-packaging-and-updates.zh.md)

Profile mutation and recovery follow the [in-place profile decision](2026-09-09-desktop-in-place-profile.md).

The [Electron runtime decision](2026-09-11-desktop-electron-node-runtime.md) supersedes the separate upstream Node executable; other decisions in this note remain applicable.

## Problem

DeepSeek Harness needs an Electron desktop application that reuses the Web UI, works without system Node.js or pnpm, installs dsh and desktop plugins through an application-bundled pnpm, and updates the complete desktop release through one user-facing flow.

The desktop application and an npm-installed dsh share the `.dsh` data root, but they may have different dsh and plugin versions. They must share supported product data without sharing executable packages, lockfiles, `node_modules`, plugin activation, or package-manager configuration.

The current GUI protocol binds the Web client and backend release. Independently versioning the Electron artifact and its bundled dsh would create unqualified shell, client, backend, and plugin combinations and make update availability ambiguous.

## Decision

Ship a small Electron shell and pinned pnpm; the [runtime decision](2026-09-11-desktop-electron-node-runtime.md) owns the executable choice. The [thin-wrapper decision](2026-09-10-desktop-web-wrapper.md) owns Host boot and transport: the private Host runs the shared Web profile runner, Electron loads its authenticated HTTP URL, and child IPC carries lifecycle messages.

Electron owns the reserved profile at `.dsh/profiles/desktop`. The [bundled-runtime decision](2026-09-08-desktop-bundled-runtime-and-external-plugins.md) owns core resource storage, external plugin dependencies, shared package links, and profile reconciliation. The private Desktop Host remains outside the public CLI package and is never published to npm.

One Desktop release number identifies the Electron artifact and its exact `@deepseek-ai/dsh` and `@deepseek-ai/dsh-desktop-host` dependencies. A release cannot select a different core version at build or runtime. Updating dsh therefore requires a new Electron release even when shell code is unchanged.

The browser Web UI, dsh backend, existing `dsh plugin` CLI, user npm, and user pnpm cannot mutate this profile. The CLI reserves every case variant of the `desktop` name and rejects boot, config-dump, and plugin-management requests for it. Electron acquires its process-lifetime single-instance lock before project recovery or Host startup; later launches focus or recreate the primary window without touching profile state. An Electron-only GUI sends structured install, remove, and update requests through preload; Electron invokes only its bundled pnpm.

## Ownership

| Owner | Responsibility |
|---|---|
| Electron shell | Window and child lifecycle, local shell pages, reserved desktop profile, plugin GUI, update coordination |
| Electron RunAsNode and pnpm | Execute dsh and install desktop-project dependencies using pnpm’s normal configuration |
| Desktop profile | External plugin dependencies, ordered enabled bundles, and shared links defined by the bundled-runtime decision |
| Private Desktop Host package | Electron-only child-process entry and composition overlay installed with dsh but excluded from the public CLI package and npm publication |
| Installed dsh package | Backend, matching Web UI, boot manifest, client bundles, and product behavior |
| Shared `.dsh` owners | Sessions, settings, credentials, workspaces, and storage, guarded by their existing locks and format versions |
| npm-installed dsh | Its own executable installation and user-managed profiles; no access to the reserved desktop profile or package state |

The renderer uses `nodeIntegration: false`, `contextIsolation: true`, and `sandbox: true`. Preload exposes typed RPC, lifecycle, update, locale, and desktop-plugin actions rather than raw `ipcRenderer`, filesystem access, shell commands, or pnpm arguments. Electron selects a typed English or Chinese dictionary from its application locale and falls back to English; menus, native dialogs, and the plugin-management renderer use that locale-owned copy.

## Filesystem layout

```text
~/.dsh/
  profiles/
    desktop/
      package.json
      pnpm-lock.yaml
      lock
      pnpm-workspace.yaml
      node_modules/
  sessions/
  storages/
```

`.dsh/profiles/desktop` is the only active desktop profile. Its executable package ownership and allowed resolution directories follow the [bundled-runtime decision](2026-09-08-desktop-bundled-runtime-and-external-plugins.md). pnpm selects its store and cache from normal configuration.

## Installation and resolution

Desktop stops the Host before modifying its profile in place. Package failures retain partial changes for explicit repair; profile mutation and package-retry ownership follow the [in-place decision](2026-09-09-desktop-in-place-profile.md).

The process-lifetime Electron lock is the authoritative Desktop owner. The package transaction lock is depth defense and records the process that can still mutate package state: Electron between package operations and the spawned pnpm PID while pnpm runs. The owner change is truncated, written, and synchronized through the already-open exclusive lock file. If Electron terminates during pnpm execution, a later process observes the live worker and refuses to start a competing package transaction; after that worker exits, the stale PID can be recovered.

Core materialization, first launch, plugin installation, and shared-module resolution follow the [bundled-runtime decision](2026-09-08-desktop-bundled-runtime-and-external-plugins.md). The actual Host composes enabled desktop plugins contributing `dsh.client` code when it starts.

## Updates and recovery

Electron update uses one `electron-updater` release stream and signed `electron-builder` artifacts. Its version is the Desktop release version; there is no independent dsh manifest, compatibility range, or dsh-only update operation. A foreground install waits for an in-flight background check rather than reusing its result as an install result. The update dialog downloads and installs the Electron artifact, then restarts into the new release.

The [immediate-window decision](2026-09-09-desktop-immediate-window-and-direct-start.md) owns the local loading page, direct Host startup, and recovery in the main window. Profile reconciliation follows the [bundled-runtime decision](2026-09-08-desktop-bundled-runtime-and-external-plugins.md).

`DSH_DESKTOP_AUTO_UPDATE_ENV` selects the test deployment by default or the production deployment for both the target-specific generic-provider URL and COS destination. Release automation supplies the test HTTPS origin through `DOWNLOAD_TEST_ORIGIN` and each deployment's bucket through `DOWNLOAD_TEST_COS_BUCKET` or `DOWNLOAD_PROD_COS_BUCKET`; keeping mutable test routing and COS storage identities out of source lets deployment infrastructure change without a code release, while the public production origin remains fixed. Packaging resolves only the public updater URL, disables electron-builder publishing, removes every COS credential field from its subprocess environment, and writes a completion record only after electron-builder and every signing or notarization hook succeeds. Target upload additionally requires the selected bucket, then requires the completion record, root dsh version, Desktop version, version-derived channel metadata, artifact names, sizes, and SHA-512 values to agree before it reads the selected credentials or sends data. It uploads immutable versioned updater payloads and any separate blockmaps before replacing the channel metadata emitted by electron-builder, and it never deletes historical objects. Stable versions use the `latest` metadata name; prereleases use the first semantic-version prerelease identifier. NSIS embeds its blockmap in the signed executable; the macOS ZIP carries a separate blockmap. Both let electron-updater download changed blocks when supported, while application replacement and the local pnpm package operation remain separate operations.

## Security and release policy

Core dsh and the private Desktop Host come only from the signed application resource tree. Plugin installation forwards package specs to pnpm, including local and remote sources, but never accepts raw pnpm commands. pnpm owns dependency resolution and the profile’s `allowBuilds` policy; the Host loads activated bundles.

Electron release artifacts are signed; macOS artifacts are notarized. Package and upload commands read release settings from the Git-ignored target `.env.windows` or `.env.macos`; subprocesses receive the fields selected by orchestration. The target file exclusively owns release fields so stale shell or system credentials cannot override local selection, and loading does not mutate the parent environment. Packaging validates the mode-specific application ID, update origin, signing identity, and local files before builds, downloads, or release-record cleanup; macOS also requires one complete notarization strategy. The separate `check:package` command runs the same validation without accessing the token or Apple; actual signing and notarization still verify authentication. Configuration loading rejects missing or malformed identifiers and incomplete notarization credentials, while macOS packaging requires signing so certificate discovery cannot silently select another installed identity or emit an unsigned release. Runtime preparation verifies the exact Authority and Team ID plus the timestamp and hardened-runtime flags on every embedded Mach-O file. An after-sign hook performs Apple's deep strict application verification and requires the same leaf Authority and Team ID before artifact creation continues. The fixed-target installer command uses [isolated App copies for parallel notarization](../process/2026-09-09-parallel-macos-notarization.md): the ZIP contains a stapled App, while the signed DMG carries the ticket covering its unstapled inner App. The DMG artifact-completion hook requires the configured identity, a valid ticket, and Gatekeeper acceptance. Both artifact lanes must succeed before the command promotes their outputs and writes the release completion record; directory-only commands still notarize and staple the App. DMG blockmaps are disabled because macOS updates consume the signed ZIP, and stapling would otherwise invalidate an already-generated DMG blockmap. The shared Web server owns frontend and client-module responses. The plugin installer API is available only to the Electron-owned management GUI and is absent from the browser application and backend RPC.

The [pinned osx-sign patch](../../../../patches/@electron__osx-sign@1.3.3.patch) uses `lstat` in both published module builds, so Framework file and directory aliases do not trigger duplicate signing. The patch remains necessary until the selected upstream release skips those aliases. PAK files are resources sealed by the enclosing bundle; individual signatures add serial timestamp requests without additional resource integrity. Desktop preserves all locale files and skips only their standalone signatures. Executable code retains Developer ID signatures, secure timestamps, and hardened runtime. The [signer traversal regression](../../../../apps/desktop/tests/macos-signing-walk.spec.ts) exercises the installed dependency with real Framework aliases; release qualification still requires strict application verification, notarization, and startup.

Windows release packaging supplies the public EV leaf certificate named by `DSH_DESKTOP_WINDOWS_CER_FILE` to the configured SafeNet-compatible SignTool through `/f` and identifies its matching private key through the required `DSH_DESKTOP_WINDOWS_KEY_CONTAINER`. The certificate file remains outside source control, and the private key remains on the USB token. The electron-builder hook passes each artifact to the CRLF `windows-sign.cmd`, whose single SignTool invocation uses the SafeNet `/kc "[{{PIN}}]=container"` value and CSP, a SHA-256 file digest, and a DigiCert SHA-256 RFC 3161 timestamp. The hook never substitutes another SignTool and never retries a failed request. Package orchestration withholds every `DSH_DESKTOP_WINDOWS_*` field from build and runtime-preparation children and passes only the certificate path, SignTool path, key container, and PIN into electron-builder. The signer supplies only validated signing fields in an otherwise scrubbed CMD environment; the CMD disables delayed expansion, clears those fields before SignTool starts, and preserves the PIN only in the required SignTool command line. Every surfaced diagnostic replaces the PIN, and only the dedicated build account and administrators may inspect the runner. The signer signs electron-builder's temporary NSIS bootstrap before enterprise Code Integrity evaluates that executable and clears a generated executable's certificate-table entry only when it points beyond the file before applying the final signature. Packaging fails before producing unsigned artifacts when the SignTool, certificate, container, PIN, token, or signature is unavailable. The shared Web server owns frontend and client-module responses. The plugin installer API is available only to the Electron-owned management GUI and is absent from the browser application and backend RPC.

Windows package invocations force `ELECTRON_BUILDER_7Z_FILTER=BCJ`. The bundled 7-Zip 24.09 encoder automatically selects ARM64 filters for ARM64 PE files, but the NSIS decoder from `nsis-resources-3.4.1` omits those entries during extraction. A native extraction probe with the actual NSIS plugin loses both `node-pty` ARM64 binaries under automatic filtering and restores both byte-for-byte with BCJ. Keeping a compatible filter preserves dependency contents and runtime integrity instead of removing architecture-specific files or weakening verification.

Local Windows installation testing uses an explicit `--unsigned` package invocation with the same build and runtime preparation. It strips certificate inputs, isolates artifacts in `unsigned-artifacts`, and omits updater configuration and the release completion record. The regular package command explicitly selects signed mode even when its parent environment requests unsigned mode. This separation permits installation diagnosis without an EV token while preventing local test output from qualifying for release upload.

Windows application replacement follows the [directory-installation decision](2026-09-11-windows-directory-installation.md): extract beside the destination with a command-line tool that returns failure status, then rename complete directories on the same volume. The installer retains the old directory through staging and restores it if promotion fails. Registration, shortcuts, and the signed uninstaller remain owned by electron-builder.

Packaged applications ignore development resource and project environment overrides. Only an unpackaged Electron process can replace the pnpm entry, dsh resources, or active project.

Architecture-specific builds report actual component-level compressed and installed sizes.

## Implementation

| Surface | Implementation |
|---|---|
| Shell | `apps/desktop` owns Electron windows, restricted preloads, the custom protocol, child lifecycle, project transactions, the plugin GUI, update coordination, and electron-builder configuration. |
| Installed runtime | Private `@deepseek-ai/dsh-desktop-host` invokes the shared profile runner and reports the authenticated Web URL to Electron. |
| Package state | Electron RunAsNode executes immutable core resources; bundled pnpm modifies only the external plugin graph in the Desktop profile. |
| Qualification | macOS packaging requires the configured company identity and notary credentials, verifies every native runtime file before inventory generation, verifies the completed application signature, and requires notarization plus Gatekeeper acceptance for both the application and DMG. Windows packaging requires the configured public certificate, SafeNet private-key container, Token Password, and SignTool, and verifies every produced signature. Update hosting, previous-version installed-artifact tests, and platform GUI recordings remain release-environment gates. |

`dev:desktop` builds the current workspace, projects the built CLI and private Desktop Host packages plus their dependency links into a disposable project, uses an isolated Harness home, opens the Main, Renderer, and Host debuggers, and starts unpackaged Electron without preparing release resources. The development runtime supplies workspace links to a separate plugin profile; plugin management and recovery use the same flow as packaged applications. Fixed macOS arm64, macOS x64, and Windows x64 package commands pass one target through runtime preparation, dsh preparation, and electron-builder; each also has an unpacked-directory variant for release-path verification before installer generation.

## Alternatives considered

**Use Electron's Node.js for dsh.** This saves package size but couples dsh to Electron's Node patches, fuses, native ABI, TLS behavior, and process lifecycle. A bundled upstream Node.js keeps dsh on its supported runtime.

**Carry Fetch bodies through JSON IPC as Base64.** This expands request and response bodies, constructs large strings in both processes, and buffers requests before dispatch. Raw framed pipes avoid Base64 expansion but retain a second transport to maintain; the [thin-wrapper decision](2026-09-10-desktop-web-wrapper.md) selects the existing Web HTTP transport.

**Bake the product Web UI into Electron.** Independent UI and backend updates would require a new versioned compatibility program. Installing backend and Web UI from the same dsh package preserves the current release binding.

**Reuse the existing CLI or browser plugin installer.** That crosses the desktop authorization and release scope and can use the user's package-manager state. Desktop package mutation remains exclusively Electron-owned.

**Let the desktop profile use CLI-managed packages or plugins.** Either product could change the other’s dependency graph, Cordis version, plugin version, or native module. Desktop rejects package resolution through the CLI profile fallback.

**Separate core and plugin resolution without shared package links.** Plugins with host peers need access to the bundled runtime when pnpm does not install those packages. The [bundled-runtime decision](2026-09-08-desktop-bundled-runtime-and-external-plugins.md) supplies missing profile packages through explicit links while retaining pnpm-installed packages.

**Remove non-target Mach-O files from registry packages.** Architecture pruning saves a small amount of runtime space, but packages can deliberately ship several architecture variants and callers can observe their installed file set. Signing every shipped Mach-O object satisfies notarization without inventing a Desktop-specific package layout.

**Export the Windows EV private key in a PFX file.** The externally supplied public leaf certificate lets SignTool construct the signature while `/csp` and `/kc` locate the hardware key. The EV private key remains non-exportable on the token.

**Store credentials in tracked scripts or system environment settings.** Local platform files keep configuration scoped to one checkout and make packaging inputs explicit. This accepts plaintext credentials at rest: the build account must restrict file access, CI must remove temporary configuration, and both Git and release file mappings must exclude real settings. Committed templates contain no credentials; the Windows CMD contains only variable references, signing stays serialized and stops on the first failure, and the file format does not exempt wrong PIN attempts from token counters.

**Let electron-builder or a general directory sync publish directly.** A direct publisher can expose channel metadata before every referenced artifact exists, mix stale or cross-target files into a release, and cannot prove that the completed signed build still matches the current dsh version. A target-specific validated upload keeps publication ordering and release identity explicit.

## Consequences

- A clean offline machine without system Node.js or pnpm starts bundled dsh without installing core dependencies.
- The signed application inventories final runtime files; every macOS native file has the release Developer ID, secure timestamp, and hardened runtime, and every Windows artifact has the configured hardware-backed EV signature.
- `.dsh/profiles/desktop/node_modules` resolves shared host links and every GUI-installed desktop plugin.
- Every Desktop package operation uses bundled pnpm with the user’s normal environment and profile configuration.
- The Electron-only GUI installs, removes, and updates ordinary npm plugin packages without exposing raw pnpm arguments.
- The backend and browser application cannot mutate desktop packages.
- npm/CLI dsh and Electron never resolve or install plugins from each other's `node_modules`.
- The active backend and Web UI report the same dsh version and a compatible shell API before the product UI loads.
- Package or Host failures retain partial profile changes and expose recovery controls; no automatic profile rollback is promised.
- One Desktop version binds Electron and dsh; every dsh update arrives through one Electron update dialog and one user-visible restart.
- Shared `.dsh` data rejects incompatible readers before migration or mutation.
- The Web application owns HTTP authentication and serving; the sandboxed renderer cannot access arbitrary filesystem or Electron APIs.
- Workspace development runs current built code without downloading release resources, while unpacked-package verification retains the production installation path.
- Windows release packaging requires the validated SignTool, EV token, matching public leaf certificate, Token Password, and explicit key container; it never falls back to an unsigned artifact or an exportable key file.
- A target update cannot expose new channel metadata until the completed signed build and every referenced artifact pass release validation; retained historical artifacts remain available for differential updates.
- Signed installed artifacts update successfully from the previous supported release on each release-blocking platform.

## Review decisions

| Decision | Recommendation |
|---|---|
| First launch | Check bundled release metadata and create profile links without installing core dependencies |
| Desktop profile | One Electron-owned reserved profile for external plugins and shared package links |
| Plugin management | Electron-only GUI and package service; no CLI, backend, or browser installation path |
| Activation | In-place package changes followed by actual Host startup |
| Initial platforms | macOS arm64/x64 and Windows x64; Linux has no supported release target |
| Update behavior | Background check, explicit confirmation before differential download and restart, startup dsh reconciliation |

## Risks

Plugin lifecycle scripts execute third-party code. The profile’s `allowBuilds` configuration determines which builds may execute.

Updating the bound dsh can invalidate plugin peer dependencies or native modules. Installed plugin files remain in place; loading failures require explicit repair through the recovery UI.

An npm-installed dsh and desktop dsh may have different versions while sharing durable data. Each shared owner must enforce its format version and process lock before reading, migrating, or writing.

Interrupted package operations retain partial changes. Recovery retries the actual Host or permits explicit plugin repair without an automatic package reinstall.

Code signing, notarization, and update hosting require production release infrastructure. Repository tests alone cannot complete that qualification.

## Related proposals

The [bundled-runtime decision](2026-09-08-desktop-bundled-runtime-and-external-plugins.md) owns core resources and external plugin dependencies. The [thin-wrapper decision](2026-09-10-desktop-web-wrapper.md) supersedes portless transport and private backend composition. Release identity, signing, process ownership, and Electron-only package authorization remain owned here.
