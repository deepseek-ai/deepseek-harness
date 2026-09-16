# DeepSeek Harness Desktop

English | [中文](README.zh.md)

The desktop application is an Electron shell around the complete dsh Web application. An Electron RunAsNode child starts the shared profile runner, and Electron immediately loads the packaged Web entry at `dsh-app://app/`. Its shared loading page waits for Host boot injections, then starts the client without navigating to another document. Electron forwards application HTTP requests to the authenticated Web Host; WebSocket streams connect to that Host with credentials attached only for the owned application window. Node IPC carries boot injections, readiness, and shutdown. Desktop defaults to port `19387`, separate from Web’s `3080`; a `webserver.config.port` patch can override it.

## Key technical decisions

The original artwork lives in `resources/icon.png` and `resources/icon.svg`; platform adaptations retain the whale and gradients in `resources/icon-windows.*` and `resources/icon-macos.*`. Export each platform SVG as a transparent 1024×1024 PNG. Electron-builder generates the multi-size ICO for the Windows application, installer, and uninstaller ([Windows icon requirements](https://learn.microsoft.com/en-us/windows/apps/design/iconography/app-icon-construction)). The installation pages use matching artwork in both themes; the uninstaller's welcome and finish pages share `installer/assets/uninstaller-sidebar.png`, converted to a 164×314 BMP during preparation.

The macOS PNG uses an inset rounded background for legacy ICNS packaging, with representations up to 1024 pixels. It is a flattened icon, not an Icon Composer document. Apple's [app icon guidance](https://developer.apple.com/design/human-interface-guidelines/app-icons) describes unmasked layers for Icon Composer; those inputs require a separate macOS export and must not reuse the rounded ICNS artwork. Verify Finder and Dock appearance on supported macOS versions before release.

### Bundled workspace dependencies

The current Windows Python payload contains unsigned native extensions. Smart App Control blocked `_decimal`, `pyexpat`, `_lzma` and `_uuid` during local validation; XML and LZMA operations fail on that host. Successful numpy/pandas smoke checks do not establish compatibility for every extension.

Desktop carries independent Python, Node.js and pnpm distributions, with numpy and pandas in Python's `site-packages`. The `load_workspace_dependencies` tool installs this payload offline on first use under `$DSH_HOME/dsh-runtimes/dsh-primary-runtime` (normally `~/.dsh/dsh-runtimes/dsh-primary-runtime`) and returns absolute interpreter, pnpm script and library paths. Execute the pnpm script with the returned Node executable. The returned Node library directory is reserved for bundled libraries, not pnpm's global installation directory.

The payload follows the Desktop release. `runtime.json` records the Desktop version, target and component versions; a matching installation is reused, and a different release replaces the directory after a complete staged copy. Python packages added to that directory are retained within the same release and replaced with the application baseline on upgrade. A failed directory replacement retains the previous installation; Windows may refuse replacement while an interpreter is still running.

This tool does not change PATH, environment variables or user package-manager configuration. pnpm retains its own defaults and user settings for global packages, executable entries and its store, including native errors when the environment does not support global installation. There is no separate dependency updater. [The primary-runtime decision](../../.agents/notes/implemented/feature/2026-09-14-desktop-primary-runtime.md) records these choices.

Node prepares the bundled interpreters and Python libraries without a system Python or pip. [The download lock](scripts/primary-runtime-lock.json) pins interpreter archives and target-specific wheel URLs and hashes; pnpm follows the Desktop build dependency lock. The supported library wheels unpack directly into site-packages; wheels requiring other installation directories are rejected, and package command-line wrappers are not generated. Native-target checks execute the bundled interpreters and numpy/pandas operations after staging cleanup and again after macOS signing. The standalone Node executable receives the JIT entitlement required by V8. Cross-target execution and signed installation require the target release host. Both `dev:desktop` and `start:desktop` prepare `.desktop-build/targets/<target>/runtime/primary-runtime` before launching Electron; first use may download locked dependencies. An unfinished preparation cannot report a successful launcher exit.

| Decision | Why | Direct consequence |
|---|---|---|
| Release identity | The shell API, Web client, backend, and plugin graph are qualified as one combination; independent versions would create untested combinations and ambiguous update availability. | Electron and `@deepseek-ai/dsh` always have the same exact version. A dsh upgrade is a Desktop release, even when the shell code is unchanged. |
| Runtime | The application must run without a system Node.js or pnpm installation. | dsh runs under Electron with `ELECTRON_RUN_AS_NODE=1` and `--expose-internals` and every package operation uses the bundled pnpm. Package-manager configuration and the Host environment follow the user's settings. Package scripts use a `node` shell launcher that forwards to Electron. |
| Package sources | Core installation at startup adds work even when offline. | `app.asar/dsh` carries a complete production dependency tree; the profile installs only external plugins. |
| State ownership | Sharing executable dependency graphs would let CLI and Desktop change each other's dsh, Cordis, plugin, or native-module versions, while two desktop processes could race on the same profile. | Electron acquires its process-lifetime single-instance lock before any profile access and exclusively owns `$DSH_HOME/profiles/desktop` plus its package-manager state. CLI and Desktop share supported product data under `$DSH_HOME`, but never executable packages, plugin activation, lockfiles, or `node_modules`. |
| Transport | Web serving and authentication share one implementation. | Electron loads packaged Web assets; the Host supplies boot injections and authenticated APIs. The shell protocol serves plugin management. |
| Plugin changes | Package installation and Host startup can fail. | Desktop stops the Host and modifies the current profile directly. Failures retain partial changes for explicit repair; there is no automatic profile rollback. |
| Updates | Independent shell and dsh updates would recreate version splits, while unchanged shell blocks should not require a complete transfer. | The Electron shell, matching dsh runtime and pnpm form one signed update unit. Platform update artifacts may reuse unchanged blocks, but runtime version selection never splits from the Desktop release. |

The [thin-wrapper decision](../../.agents/notes/implemented/architecture/2026-09-10-desktop-web-wrapper.md) owns shared Web behavior and Desktop adapters. The [Electron packaging and update decision](../../.agents/notes/implemented/architecture/2026-08-25-electron-desktop-packaging-and-updates.md) owns release identity, signing, and update qualification.

## Installation ownership

Electron owns `$DSH_HOME/profiles/desktop`. Its `dependencies` contains packages installed by pnpm; `dsh.profile.bundles` contains the built-in bundles followed by enabled plugins. The signed application supplies dsh, the private Desktop Host, and their production packages from `resources/app.asar/dsh`. Packaged applications select runtime profile resolution without creating package links; development profiles use filesystem links. Both host and plugins execute in the same Electron Node-mode process; Desktop does not enable `--preserve-symlinks`. The CLI cannot boot or mutate this profile.

The application preload exposes boot readiness and fatal startup reporting. The product renderer uses the Web application’s HTTP APIs. The separate plugin window receives structured list, install, remove, update, and update-check operations; neither renderer receives filesystem access, raw Electron IPC, a shell, or arbitrary pnpm arguments.

The product UI retains Web actions, including "Open In..." through the shared authenticated HTTP routes. Desktop uses Web's automatic directory-picker selection and initializes new profiles with the shared Web template's bundles.

Electron chooses typed English or Chinese shell copy from its application locale and falls back to English. Menus, native dialogs, and the plugin-management renderer use the same locale payload; the repository Client UI i18n gate checks these desktop sources.

Electron's native Edit menu supplies undo, redo, cut, copy, paste, and select-all commands and platform shortcuts for the focused window. Right-clicking an editable field opens these commands without shortcut labels, with availability supplied by Chromium; selected read-only text offers Copy.

### Runtime and plugin activation

The signed `resources/app.asar/dsh/desktop-runtime.json` binds the shell version, Electron's Node version, platform, architecture, shared package versions, and final file inventory. Startup reads the metadata and checks shared package records. Release schema, shell version, target compatibility, and file integrity are verified during packaging. Core packages are never copied into profile storage or installed by pnpm at first launch.

1. The main window displays the shared Web loading page from packaged static assets before profile preparation or backend startup. Shared profile initialization creates missing manifest, empty user patch, and pnpm workspace files without overwriting existing files.
2. Before production Host startup, Desktop removes profile copies and fallback links for packages listed by the current runtime or the recorded Desktop package set. It removes their dependency declarations and overrides, and discards the lockfile when cleanup changes package state. Other plugin files, configuration, and versions remain; development skips this cleanup and startup never runs pnpm.
3. Changes to Electron's Node version, platform, or architecture preserve installed plugins. Native incompatibilities surface during loading and can be repaired through pnpm.
4. Plugin add, update, and remove operations use bundled pnpm with its normal user and profile configuration. Desktop does not override the registry, npmrc, cache, or store, and new profiles add no build allowlist or strict-build setting. The plugin-management page has an inline version form with cancellation; versions and ranges pass to pnpm, including the installed version for a reinstall. Package specs pass to pnpm, including local directories, Git, tarballs, and aliases. Relative paths resolve from the Desktop profile directory. Packages declaring `dsh.bundle.patch` activate as bundles; ordinary dependencies remain installed without activation. Desktop does not scan plugin dependency graphs or validate patch files before Host startup. Custom profile metadata and bundle order are retained. Unreadable installed metadata does not block listing, disabling, or removing dependencies; the list uses the dependency spec when the installed version is unavailable.
5. Plugin changes stop the backend before modifying the current profile. The Host restarts after every attempted package change, including failed package operations. Package or Host startup failures retain modified files and report the error. Desktop creates no staging directories, activation journals, or rollback copies.

CLI and Desktop use the same installed-dependency inventory and bundle reconciliation. Bundle declarations resolve with the same installation-first precedence as startup. CLI operations automatically enable installed bundles; Desktop preserves bundles disabled through its UI across updates. Neither path requires readable installed metadata to list or remove a dependency.

Fatal main-window creation, main-document loading, preload, renderer, Web initialization, or backend failures open one native recovery dialog per application process. It shows a bounded tail of the first error, notes any truncation, and offers Exit, Restart, and Disable all third-party plugins and restart. Startup failures retain the Web loading page and spinner; runtime failures retain the current page. Expected shutdowns, cancelled navigation, and ordinary requests do not trigger recovery. Package-operation errors stay in the plugin window when the Host restarts successfully; a Host startup failure after any plugin change enters native recovery. There is no startup timeout heuristic.

Native dialog details include at most 1,200 UTF-16 code units and eight diagnostic lines; the complete reported error is written to the Electron console. Host error diagnostics retain only the last 64 Ki characters written to stderr. Earlier output is discarded so a long-running Host does not grow the shell’s diagnostic buffer indefinitely.

Recovery waits for Host shutdown before changing plugin activation. The native recovery action disables third-party bundles by writing the profile under its transaction lock without loading runtime metadata or deleting files. Invalid profile data or write failures are reported as recovery-operation errors; Desktop does not restart as though disabling succeeded. Desktop has no profile-reset action or emergency HTML document.

Package transactions hold `$DSH_HOME/profiles/desktop/lock` exclusively through pnpm process exit. Before pnpm runs, the shared module-fallback helper removes only its owned links and preserves pnpm-managed directories; development Host startup restores needed links. Link cleanup preserves target directories. Native builds follow pnpm’s configured build policy; release preparation owns its separate build-time allowlist.

## Develop

`dev:desktop` builds the current Host, client bundles, Web frontend, and Electron shell, projects the built CLI and private Desktop Host packages with their workspace dependencies into a disposable desktop npm project, and launches Electron without resolving dsh from npm:

```sh
pnpm run dev:desktop
```

Development Harness state defaults to `apps/desktop/.desktop-build/development/home`, the disposable npm project lives at `apps/desktop/.desktop-build/development/project`, and Electron browser data lives at `apps/desktop/.desktop-build/development/electron-user-data`. Sessions, settings, credentials, package links, and browser data therefore stay out of the user's normal Harness home. An explicit `DSH_HOME` replaces only the development Harness home. Renderer DevTools opens automatically; Main, Renderer, and dsh Host debugging listen on ports 9229, 9222, and 9230. `DSH_DESKTOP_MAIN_INSPECT_PORT`, `DSH_DESKTOP_RENDERER_DEBUG_PORT`, and `DSH_DESKTOP_HOST_INSPECT_PORT` replace those ports, while `DSH_DESKTOP_OPEN_DEVTOOLS=0` keeps the detached Renderer tools closed.

After an explicit build, `start:desktop` reconstructs the disposable project and launches the existing artifacts without building again:

```sh
pnpm run start:desktop
```

Workspace development runs the current CLI and private Desktop Host packages under Electron RunAsNode. Plugin management and recovery use `$DSH_HOME/profiles/desktop`, separate from the disposable workspace runtime. Development and packaged profiles both use normal bundle resolution, including linked packages. Use an unpacked application to exercise Electron RunAsNode, bundled pnpm, bundled dsh resources, plugin installation and repair paths.

## Package

Packaging, upload, and manual macOS signature verification read `apps/desktop/.env.windows` or `.env.macos`, selected by target platform. Copy the [Windows template](.env.windows.example) or [macOS template](.env.macos.example) and fill in the local settings; Git ignores both local files, and packaged artifacts exclude them. Release fields come only from the target file, without fallback to system or shell variables; `PATH`, proxies, and build-tool settings remain inherited. Files use UTF-8 with optional BOM; relative certificate, SignTool, Apple API key, and keychain paths resolve from `apps/desktop`, values are not shell-expanded, and passwords containing `#` or spaces need quotes. CI also creates the target file before invoking packaging.

Every package command checks the application ID, update origin, and mode-specific signing configuration before building or downloading. macOS checks the identity, Team ID, one complete notarization strategy, and referenced API key and keychain files; Windows checks the public code-signing certificate, SignTool file, container name, and PIN format. Windows preparation-only and explicit unsigned builds do not require signing credentials. Configuration checks do not authenticate the PIN, log in to the token, unlock a keychain, or contact Apple; actual signing and notarization perform those checks. Run the same checks separately:

```sh
pnpm --dir apps/desktop run check:package
```

`prepare:desktop` is not a prerequisite:

```sh
pnpm run package:desktop
```

Release automation uses fixed target commands so runtime preparation, dsh preparation, and electron-builder receive the same platform and architecture:

```sh
pnpm run package:desktop:mac:arm64
pnpm run package:desktop:mac:x64
pnpm run package:desktop:win:x64
```

The macOS arm64 command requires Apple Silicon. The macOS x64 command runs on Intel macOS or Apple Silicon with Rosetta. The Windows x64 command requires Windows x64. Linux is not a supported Desktop release target.

Each target owns its packed package inputs, prepared runtime, package set, dsh tree, pnpm preparation state, unpacked application, update metadata, and final artifacts under `apps/desktop/.desktop-build/targets/<target>/`. The Electron archive cache remains shared under `.desktop-build/downloads` because every archive name includes its version, platform, and architecture and is verified before extraction. A target build never consumes another target's mutable preparation state.

### Runtime file selection

Production packages first pass through npm's publication rules and dependency installation. [Desktop's file policy](scripts/runtime-file-policy.ts) then filters the immutable `resources/app.asar/dsh/node_modules` copy before signing and integrity sealing. It omits TypeScript declarations, recognized JavaScript/CSS/TypeScript source maps, TypeScript build caches, Domino's test directory, selected native compiler outputs, and node-pty prebuilds for other platforms. It preserves runtime JavaScript, native modules and their DLL/EXE helpers, WASM, unknown assets, licenses, and notices. The policy does not alter npm tarballs, the bundled package manager, or user-installed plugin files.

The packaged application runs compiled JavaScript and pre-generated Typert metadata; it does not compile TypeScript plugins. Source-level debugger navigation and editor declarations remain available in development packages. [Copy-policy tests](tests/runtime-file-policy.spec.ts) cover exclusions and retained assets; `prepare:dsh` runs the [payload smoke](tests/fixtures/runtime-payload-smoke.mjs) under Electron RunAsNode before the Host smoke and final inventory verification.

Windows release qualification also runs [directory and replacement checks](scripts/smoke-windows.ps1) manually after the Desktop build. Set `$Makensis`, `$SevenZip`, and `$PluginDir` to the pinned builder’s NSIS compiler, 7-Zip executable, and x86-unicode NSIS plugin directory. From the repository root, run the command below. It verifies directory replacement and rollback, and both locked-file replacement modes; it is not part of the unit-test lane.

```powershell
pwsh -NoProfile -File apps/desktop/scripts/smoke-windows.ps1 -Makensis $Makensis -SevenZip $SevenZip -PluginDir $PluginDir
```

The Windows installer extracts the new version beside the installation directory, stops the old application, and replaces directories through same-volume renames. Same-path upgrades preserve the old directory until promotion succeeds; extraction failure leaves it intact, and promotion failure attempts to restore it. The installer removes the old backup before launch. Forced termination or power loss can leave `.new-*` or `.old-*` directories; installation-location and scope migrations retain electron-builder's old-uninstaller flow.

### Upload updates

`DSH_DESKTOP_AUTO_UPDATE_ENV` selects `test` or `production` for both the URL embedded during packaging and the later COS upload; an absent value selects `test`. Test packaging requires its HTTPS origin in `DOWNLOAD_TEST_ORIGIN`, while the production origin remains `https://download.deepseek.com`. Upload additionally requires the selected deployment's COS bucket in `DOWNLOAD_TEST_COS_BUCKET` or `DOWNLOAD_PROD_COS_BUCKET`. The target path is `_/harness/desktop/stable/<target>/`, where `target` is `mac-arm64`, `mac-x64`, or `win-x64`.

The update destination and upload credentials follow the selected deployment:

| Environment | Public origin | COS bucket | COS credentials |
|---|---|---|---|
| `test` or unset | `DOWNLOAD_TEST_ORIGIN` | `DOWNLOAD_TEST_COS_BUCKET` | `DOWNLOAD_TEST_COS_SECRET_ID`, `DOWNLOAD_TEST_COS_SECRET_KEY` |
| `production` | `https://download.deepseek.com` | `DOWNLOAD_PROD_COS_BUCKET` | `DOWNLOAD_PROD_COS_SECRET_ID`, `DOWNLOAD_PROD_COS_SECRET_KEY` |

Configure the update origin and selected COS bucket, SecretId, and SecretKey in the target dotenv file, then package and upload the same target:

```sh
pnpm run package:desktop:mac:arm64
pnpm run upload:mac:arm64
```

Set `DSH_DESKTOP_AUTO_UPDATE_ENV=production` in the target dotenv file before packaging, then provide `DOWNLOAD_PROD_COS_BUCKET` and the production credential pair before running `upload:mac:arm64`, `upload:mac:x64`, or `upload:win:x64`. Packaging does not require a COS bucket or credentials. It explicitly disables electron-builder publishing, strips all four COS credential fields from its subprocesses, and writes a target completion record only after electron-builder and every signing or notarization hook succeeds. Upload requires that record to match the selected environment, target, public URL, and current dsh version; it also requires the root dsh version, Desktop version, channel metadata version, artifact names, sizes, and SHA-512 values to agree before it reads the selected COS credential pair. It uploads only that target's immutable versioned artifacts, uploads the version-derived channel metadata last with `no-cache`, and never deletes historical objects. Stable releases use `latest-mac.yml` or `latest.yml`; a prerelease such as `alpha` uses `alpha-mac.yml` or `alpha.yml`, matching electron-builder's emitted filename.

The macOS configuration uses the required release environment instead of accepting whichever certificate appears first in a keychain. It rejects empty values, a malformed Team ID, a signing identity that includes electron-builder's unsupported `Developer ID Application:` prefix, and incomplete notarization credentials. macOS packaging requires the configured identity and its private key. Runtime preparation applies that identity, a secure timestamp, and hardened runtime to every embedded Mach-O file; after signing the application, a deep strict check rejects any other leaf authority or Team ID before artifact creation. The fixed-target macOS installer commands create separate copies of the signed application and run two artifact lanes concurrently. One lane notarizes and staples the App before generating the ZIP and its update metadata. The other encloses its signed App copy in a signed DMG, then notarizes, staples, and verifies the DMG; its inner App has no individually stapled ticket. Both lanes must finish successfully before their artifacts reach the final directory and the release completion record is written. Directory-only commands also require notarization credentials and wait for Apple notarization and App stapling. The [parallel notarization decision](../../.agents/notes/implemented/process/2026-09-09-parallel-macos-notarization.md) owns copy isolation and container ticket semantics. The private key can come from the login keychain or electron-builder's standard `CSC_LINK` input; ambient `CSC_NAME` and certificate discovery order do not select the release owner. Notary credentials may instead use electron-builder's complete Apple ID or keychain-profile strategy. The two macOS identity variables are also required when repeating the application check manually with `pnpm --dir apps/desktop run verify:mac-signature -- <path-to-app>`.

macOS signing visits real files without following Framework symlink aliases. PAK resources retain all shipped languages and are sealed by the enclosing Framework or application signature instead of receiving individual signatures. The [release policy](../../.agents/notes/implemented/architecture/2026-08-25-electron-desktop-packaging-and-updates.md) owns the dependency patch and verification requirements.

Company proxies can accelerate uploads to Apple's notarization service. See the company internal documentation for configuration.

### Unsigned Windows test installer

On Windows x64, use the complete unsigned packaging command for local installation testing:

```sh
pnpm run package:desktop:win:x64:unsigned
```

The command requires `DSH_DESKTOP_APP_ID` and the normal build dependencies, including Python and Visual C++ build tools for native modules. Set `PYTHON` to the Python executable when it is absent from `PATH`. It writes the installer to `.desktop-build/targets/win-x64/unsigned-artifacts/`, omits automatic-update configuration, strips signing credentials, and creates no release completion record. It does not require EV credentials or an update origin. The signed packaging and upload commands retain their release requirements.

### Windows installer interface

The Windows installer uses native NSIS pages with light and dark palettes, system shadows, an editable installation directory, and a finish page whose launch checkbox is selected by default. Installation is restricted to the current user. Clicking Install or pressing Enter validates the current path; new destinations must be empty, and nonempty destinations must be registered installations. Running executables at the affected installation path produce a native prompt and remain running; same-named applications in other directories do not block installation. Silent updates wait up to ten seconds for the affected application to exit, then stop with exit code 2 if it is still running.

The theme follows Windows at startup; `/THEME=light`, `/THEME=dark`, and `/THEME=auto` select a palette explicitly. The window appears after its branded controls are ready. Progress reads the pinned 7-Zip extractor’s percentage; directory promotion, registration, and cleanup retain bounded estimates. The weighted percentage does not predict remaining time. After NSIS reports success, the bar fills over 600 ms and displays 100% briefly before the finish page appears; the transition targets 750 ms. The finish page preserves the window position. Finish dismisses the installer before launching the installed executable; a launch failure restores the page for retry. Directory replacement and failure recovery follow the installation flow described above. First-launch profile preparation remains a separate Desktop operation.

Windows packaging compiles an x86 Win32/GDI+ helper with Visual C++ Build Tools and a Windows SDK; signed builds sign this helper through the configured Windows signer. The preparation hook leaves production dependency collection to electron-builder on every platform. The [installer decision](../../.agents/notes/implemented/architecture/2026-09-10-windows-native-installer-pages.md) records the NSIS integration and release checks.

Run `pnpm --dir apps/desktop run test:installer` from the repository root on an interactive Windows x64 desktop to build and exercise a small native test payload through the production installer configuration. Each run uses a unique product identity and sequentially exercises English-only and Chinese-only installer variants, selecting test labels from the displayed welcome button. Both variants install into private directories and uninstall after testing; screenshots and results remain under `.desktop-build/installer-tests/`. The checks include upgrades to registered paths with trailing separators and rejection of drive roots. The optional `--signed` flag uses the Windows EV configuration below to sign test executables and the helper before embedding them; it does not enable an update feed.

### Windows EV signing

For this project's SafeNet token, `SignTool Error: No private key is available.` indicates an incorrect PIN. Stop all signing attempts immediately and wait for the user to correct the PIN before continuing. Five incorrect PIN attempts lock the token. Do not retry packaging or signing probes after this error. The signer serializes token operations and rejects all queued tasks after the first failure.

Windows packaging fixes the 7-Zip filter to `BCJ` for compatibility with the bundled NSIS decoder. This preserves ARM64 binaries carried by dependencies in x64 installers; automatic ARM64 filtering produces entries that this decoder cannot extract.

NSIS removes its temporary extraction tree during installation, before the completion page or an automatic launch. The installed production packages remain ordinary files; startup does not extract them again. Installation still writes the complete application tree.

Fill in `.env.windows` with `DSH_DESKTOP_WINDOWS_CER_FILE` (public EV leaf certificate), `DSH_DESKTOP_WINDOWS_SIGNTOOL` (SafeNet-compatible SignTool), `DSH_DESKTOP_WINDOWS_KEY_CONTAINER` (matching private-key container), and `DSH_DESKTOP_WINDOWS_TOKEN_PIN` (Token Password). The private key stays on the USB token; keep the certificate and local credential file out of Git.

```sh
pnpm run package:desktop:win:x64
```

Insert and unlock the token before packaging. The electron-builder hook passes each artifact to the CRLF `scripts/windows-sign.cmd`, which invokes the configured SignTool once with `/f`, SafeNet `/kc "[{{PIN}}]=container"`, `/csp "eToken Base Cryptographic Provider"`, a SHA-256 file digest, and a DigiCert SHA-256 RFC 3161 timestamp. The hook never substitutes electron-builder's bundled SignTool and never retries a failed signing request. Windows release packaging fails instead of emitting unsigned artifacts when the SignTool, certificate, container, PIN, token, or signature is unavailable.

The PIN cannot contain `]`, a quote, or a line break because those characters delimit the SafeNet `/kc` value or its CMD argument. The CMD disables delayed expansion so a PIN containing `!` reaches SafeNet unchanged. Packaging withholds every `DSH_DESKTOP_WINDOWS_*` field from build and runtime-preparation subprocesses, gives electron-builder only the four configured inputs, gives the signing CMD only the validated signing fields in an otherwise scrubbed environment, clears those fields before SignTool starts, and redacts SignTool diagnostics. SafeNet still requires the PIN in the SignTool process command line. The local `.env.windows` stores the PIN in plaintext and needs restricted file access; CI uses a temporary file and deletes it after the job. Do not commit or share its contents or print credentials in logs. Configuration checks consume no token PIN attempts; signing still stops the batch on its first failure.

Create a runnable application directory instead of an installer by using the matching `:dir` command, such as:

```sh
pnpm run package:desktop:dir
pnpm run package:desktop:mac:arm64:dir
```

To inspect or troubleshoot the prepared host-target resources without invoking electron-builder, stop the same pipeline after preparation:

```sh
pnpm run prepare:desktop
```

This diagnostic command is an alternative stopping point, not the first half of a two-command build. A later `package:desktop*` command repeats the official build and preparation so it cannot consume stale dsh packages, runtime files, or dsh content.

Every package command builds the repository, packs the first-party production closures rooted at dsh and the private Desktop Host, and prepares the target Electron distribution and pnpm CLI. `prepare:dsh` installs the production graph once at build time, prepares materialized packages for electron-builder to archive under `app.asar/dsh`, removes package-manager metadata, and writes `desktop-runtime.json` with shared package versions and final file hashes. On macOS it signs and verifies native files before inventory generation; electron-builder excludes this already-signed tree from nested re-signing. Resource mappings explicitly include `dsh/node_modules`, which the default root-directory filter omits; the prepared runtime inventory is checked after native signing. Native executables and libraries are unpacked beside ASAR; Python, standalone Node and pnpm remain in external runtime resources. Signed installer, notarization, installed upgrade, and target-specific native-module qualification require the release environment.

An unpacked artifact contains Electron, the materialized dsh production tree, pnpm, and the shell application. Installer size and filesystem size differ; release qualification measures both, plus the profile’s plugin storage and first-launch latency. The runtime trades more application files for eliminating core package installation on the user’s machine.

## Updates

A packaged application checks its target-specific release stream ten seconds after the main window opens; the localized **Check for Updates…** menu item triggers the same check manually. An available release opens one native confirmation dialog. Accepting it waits for an in-flight check, downloads and verifies the signed Desktop release, stops the dsh child, and hands installation plus restart to electron-updater.

Signed packaging emits generic-provider channel metadata for the deployment selected by `DSH_DESKTOP_AUTO_UPDATE_ENV`. NSIS differential packages and the macOS ZIP target allow electron-updater to reuse unchanged blocks; the manually installed DMG is notarized without a blockmap because it is not a macOS updater payload. The runtime and shell still form one signed Desktop release. macOS signing and notarization credentials use electron-builder's standard environment; Windows EV signing uses the public certificate, validated SignTool, SafeNet container, and runner PIN described above. The required Desktop release environment selects the application and platform signature identities that the build verifies.

## Low-level development overrides

An unpackaged Electron process uses `.desktop-build/development/project` under its application directory as its development project. `DSH_DESKTOP_PNPM_ENTRY` and `DSH_DESKTOP_DSH_DIR` select explicit runtime resources. Packaged applications ignore these variables, resolve signed resources from `process.resourcesPath`, and use the managed Desktop profile.

## Known limitations

- Release signing, notarization, update hosting, and previous-version installed-artifact qualification require the production release environment.
- Dependency lifecycle scripts follow pnpm’s build permissions; Desktop provides no separate approval dialog.
- The desktop shell shares sessions, settings, credentials, workspaces, and storage under `$DSH_HOME` with CLI dsh, while executable packages, plugin activation, and lockfiles remain separate.
