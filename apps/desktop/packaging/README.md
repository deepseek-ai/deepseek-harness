---
description: "Build Desktop installers locally or through Windows or macOS Actions, choose deployment and signing mode, and retrieve artifacts and diagnostics. This guide keeps build operations separate from publishing and installed-application qualification. Platform signing details and shared-runner risks must be checked before using hardware credentials."
---

# Desktop packaging

English | [中文](README.zh.md)

## Summary

Build Desktop installers locally or through Windows or macOS Actions, choose deployment and signing mode, and retrieve artifacts and diagnostics. This guide keeps build operations separate from publishing and installed-application qualification. Platform signing details and shared-runner risks must be checked before using hardware credentials.

## Table of Contents

- [Choose a build path](#choose-a-build)
- [Release versions](#release-versions)
- [Configuration and local builds](#configuration-and-local-builds)
- [Windows Actions packaging](#windows-actions)
- [macOS self-hosted packaging](#macos-actions)
- [Unsigned Windows test installer](#unsigned-windows-test-installer)
- [Local macOS DMG without release signing](#local-macos-dmg-without-release-signing)
- [macOS release signing and diagnostics](#macos-release-signing)
- [Directory builds and preparation](#directory-and-preparation)
- [Local Official bundles from a loopback registry](#local-official-bundles-from-a-loopback-registry)
- [Runtime file selection and installation checks](#runtime-file-selection)
- [Desktop runtime preparation](#desktop-runtime-preparation)
- [Installation and release verification](#verification)

<a id="choose-a-build"></a>

## Choose a build path

Run local commands from the repository root after installing locked dependencies. Use platform-specific commands for a local build, or platform Actions for the registered self-hosted runner. Choose test or production deployment independently from signed or unsigned mode. Read [Windows signing and runner operations](../windows-signing/README.md#trust-and-isolation) before any Windows signed build or shared-runner use. Installation is separate from packaging; [publication](../publishing/README.md) is a further explicit operation.

Set `DSH_DESKTOP_PACKAGE_CACHE_DIR` to an absolute build-cache directory for reuse across checkouts; see [cache configuration and lifecycle](#desktop-runtime-preparation).

<a id="release-versions"></a>

## Release versions

Before each Desktop packaging run, first confirm the complete version string with the current user. Check the selected deployment, dsh base version, retained release records, and published objects, then propose the exact version for approval. Do not start packaging until the user confirms that version; the deployment setting alone does not authorize a version choice.

Record the current dsh version as the base. A production Desktop release uses that exact version, including any `alpha`, `beta`, or `rc` identifiers. A test release preserves the complete prerelease base and appends `.YYYYMMDD.index`; a stable base uses `-test.YYYYMMDD.index` instead.

| dsh base | Production Desktop | Test Desktop example |
|---|---|---|
| `0.1.6-alpha.1` | `0.1.6-alpha.1` | `0.1.6-alpha.1.20260916.1` |
| `0.1.6-beta.2` | `0.1.6-beta.2` | `0.1.6-beta.2.20260916.1` |
| `0.1.6-rc.3` | `0.1.6-rc.3` | `0.1.6-rc.3.20260916.1` |
| `0.1.6` | `0.1.6` | `0.1.6-test.20260916.1` |

Use the actual creation date in Asia/Shanghai. For each base and date, start the index at 1 and increment after checking retained release records and published objects; never reuse a published version. Test distribution does not publish the corresponding unsuffixed base.

Manual Desktop CI uses a separate unpublished build identifier: `auto` appends the UTC date, workflow run number and attempt (`.YYYYMMDD.run.attempt`, with `-test` for a stable base). For example, `0.2.1-alpha.1.20261008.42.2`. These numbers are not reserved release sequence numbers.

Pass the confirmed version to the packaging command as `--build-version`, which reaches the artifact names, the update feed, and the upload validation as one value. The manifests keep the product version, so a test build no longer rewrites the release family and leaves nothing to revert:

```sh
pnpm --dir apps/desktop run package:win:x64 --build-version 0.1.6-alpha.1.20260916.1
```

`--build-version auto` proposes the next index for today, reading the published objects in the destination bucket and falling back to this target's local output directory when no bucket is configured or the listing cannot finish within its deadline. Confirm the proposal it prints before an upload; a run script forwards `--` on its own, and the packaging entry accepts it either way.

A production release publishes the product version and takes no `--build-version`. Uploading one tags the packaged commit as `desktop-v<version>` once the artifacts are public; a build from a modified checkout is not tagged, and a tagging failure prints the command to run by hand rather than failing a completed upload. Test and local builds are deliberately left untagged, and every artifact records `dshBuildCommit` and `dshBuildDirty` in its manifest so a build handed over directly remains traceable.

The installer embeds `DSH_DESKTOP_UPDATE_CHANNEL` (`nightly` by default, or `latest`) independently of version and deployment. Automatic updates remain on that channel even for a stable version; manually installing the other channel switches it. Latest packages reject prerelease versions. A stable product can produce a nightly `-test.<date>.<sequence>` build, but that version ranks below the stable base and cannot upgrade an already installed higher version. Keep automatic downgrade disabled; stable corrective releases require a product version bump. CI version selection and publication are documented in [CI publication](../publishing/ci/README.md#package-and-publish).

<a id="configuration-and-local-builds"></a>

## Configuration and local builds

Unsigned macOS and Windows packages use the same localized **DSH Local Build** label and version/commit badge as local Web builds. Signed packages keep official branding, including test deployments and macOS builds that skip notarization. Native application and installer names are unchanged.

Set `DSH_PACKAGING_CONFIG_DIR` to the absolute machine configuration directory and `DSH_PACKAGING_PRESET` to `test` or `production` for local Windows commands. The loader reads `presets/<preset>.env`; signed commands additionally read `secrets/windows-signing.env`. Relative certificate and SignTool paths resolve beside the file declaring them. Public presets reject credentials, and the signing file cannot override public settings. Missing configuration fails without falling back to `.env.windows`; commands without a preset retain the existing dotenv behavior. Unsigned and preparation-only presets never read the signing file. Cache maintenance also reads only public preset settings. Test signed packages also require the existing download origin and release ID, but no upload credentials. Local preset commands with `--build-version auto` number from local artifacts only; Actions uses its run number and attempt.

Both manual packaging workflows accept `test_release_id`. Blank uses the machine preset; a nonblank value must contain 32 lowercase hexadecimal characters and requires the test preset. The loader applies it through `PACKAGE_TEST_RELEASE_ID` without changing the preset file. Keep the same value for successive upgrade tests on that platform. Rotating the default affects future builds only: installed clients retain their original update address, and old objects remain accessible until separately removed. A random prefix reduces discoverability but does not authenticate downloads.

Outside machine-preset mode, packaging, upload, and manual macOS signature verification (except local unsigned macOS builds) read `apps/desktop/.env.windows` or `.env.macos`, selected by target platform. Copy the [Windows template](../.env.windows.example) or [macOS template](../.env.macos.example) and fill in the local settings; Git ignores both local files, and packaged artifacts exclude them. Release fields come only from the selected configuration files, without fallback to system or shell variables; `PATH`, proxies, and build-tool settings remain inherited. The published version is an argument rather than a release field, and upload reads it from the completion record the packaging run wrote. Files use UTF-8 with optional BOM; relative certificate, SignTool, Apple API key, and keychain paths resolve from `apps/desktop`, values are not shell-expanded, and passwords containing `#` or spaces need quotes. Windows CI reads the same machine presets.

Every package command checks the application ID and its mode-specific update and signing configuration before building or downloading, then probes the external tools the run will use: the archive reader, and on a Windows target the installer compiler. macOS checks the identity, Team ID, one complete notarization strategy, readable local `CSC_LINK` p12 file, explicit `CSC_KEY_PASSWORD`, and referenced API key and keychain files; Windows checks the public code-signing certificate, SignTool file, container name, and PIN format. Windows preparation-only builds and explicit unsigned builds on either platform do not require signing credentials. Configuration checks do not authenticate the PIN, log in to the token, unlock a keychain, or contact Apple; actual signing and notarization perform those checks. Without a machine preset, `--build-version auto` contacts the destination bucket, including under `--check`. Run the same checks separately:

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

Both release and local unsigned macOS DMGs use LZMA compression (`dmg.format: 'ULMO'`) in [the electron-builder configuration](../scripts/electron-builder-config.mjs). A [build-time patch](../../../patches/app-builder-lib@26.17.0.patch) adds this format to the pinned builder's validation and TypeScript declarations.

Each target owns its packed package inputs, prepared runtime, package set, dsh tree, pnpm preparation state, unpacked application, update metadata, and final artifacts under `apps/desktop/.desktop-build/targets/<target>/`. The Electron archive cache remains shared under `.desktop-build/downloads` because every archive name includes its version, platform, and architecture and is verified before extraction. A target build never consumes another target's mutable preparation state.

<a id="windows-actions"></a>

## Windows Actions packaging

For supervised runner startup and recovery, follow [Windows runner machine setup](../windows-signing/README.md#machine-setup).

The `Package Desktop · Windows · x64` [manual workflow](../../../.github/workflows/windows-package.yml) selects the dedicated Windows x64 runner label `dsh-win-package-trial` and the machine preset `test` or `production`. Choose `signed` (default) or `unsigned`; signed mode uses the existing EV token preflight, signature cache and failure interlock. It does not publish or upload a release. `build_version` defaults to `auto`, using the CI identifier in [Release versions](#release-versions); an explicit value may be the checkout's product version or an extended build version such as `0.2.1-alpha.1.20261009.1` for product `0.2.1-alpha.1`. The version prefix must match the selected checkout; validation errors show its current example. Manifests remain unchanged.

Select the workflow in Actions, choose the source branch, preset, signing mode and version, then click Run workflow. Before merging input changes, test the pushed branch with `gh workflow run windows-package.yml --ref <branch> -f preset=test -f signing=unsigned -f build_version=auto`; verify the web form after merging. There is no push or PR trigger. Logs and successful EXEs are retained for 14 days. Inspect the retained logs and installer before relying on packaging; installation is separate. Before checkout, Node removes the runner-owned source directory without following dependency junctions; the workflow validates its location and rejects linked ancestors. Never point it at a development checkout. Runs share one concurrency group without cancelling an active build; only one run remains pending, and a newer dispatch replaces it. Diagnostics upload requires a successful clean checkout. Machine settings stay outside the checkout and are never uploaded as artifacts.

Open the completed run in Actions and download its Artifacts. `windows-x64-signed-<version>-<run_id>-<run_attempt>` and `windows-x64-unsigned-<version>-<run_id>-<run_attempt>` contain the corresponding EXE; `windows-package-logs-<run_id>-<run_attempt>` contains packaging diagnostics. The upload steps are `Retain verified signed installer`, `Retain verified unsigned installer`, and `Retain packaging diagnostics`; their step durations and timestamped logs show upload time. These artifacts are not a Release or download-site publication.

For cache measurements, `cache_namespace` selects a retained subdirectory for both dependency stores and upstream downloads; leave it empty for normal shared caches. Use a new name for a cold sample and repeat that name for warm samples. Names contain 1–64 lowercase letters, digits or hyphens, start with a letter or digit, and cannot be Windows device names. This does not reset the separate signature cache or OS file cache; report those states and Job start-to-completion time alongside phase timings and artifact size. Before dependency installation, the workflow records the Node version, available CPU parallelism, logical CPU count, and total/free memory.

The dependency-install and packaging steps normalize their own shell to normal CPU, I/O and memory priority before launching children. The priority helper is copied from the exact workflow commit into a run-specific temporary directory, independently of the selected product source. A missing helper stops CI setup; unavailable priority adjustment emits a warning and marks scheduling unsuitable for performance comparison, but does not stop packaging. This does not modify the runner task or other processes. Version, preset and retained-artifact adapters remain tied to product source and its formats.

Installer uploads store the already-compressed release files without ZIP recompression; this preserves installer bytes and signatures. Diagnostic uploads retain their ordinary compression.

<a id="macos-actions"></a>

## macOS self-hosted packaging

The [Apple Silicon workflow](../../../.github/workflows/macos-package.yml) and [Intel workflow](../../../.github/workflows/macos-intel-package.yml) produce separate arm64 and x64 packages on the Apple Silicon runner labeled `dsh-mac-package-trial`. Both share one concurrency group. The Intel workflow checks Rosetta execution before dependency installation; its selected source must include the target-aware macOS CI adapter. Both select `test` or `production` and use the existing signing, notarization and packaged-runtime checks. Successful DMG/ZIP files and diagnostic logs are retained for 14 days without publishing a release. Installer uploads disable redundant ZIP compression. The operator must verify a complete Actions run and installation on the target architecture before release qualification. The `compression_level` dropdown defaults to `3` and also offers `7`; it overrides the machine preset for this run and affects only ZIP and automatic-update downloads, not DMG.

All three platform forms put source, environment, update channel, version mode, manual version, test release ID and compression level first, with matching defaults. macOS notarization and Windows signing and cache measurement options follow these common fields.

Run `node apps/desktop/scripts/setup-macos-packaging.mjs "$HOME/dsh-ci"` to prepare private `runner/`, `packaging/{presets,secrets,certificates}` and `cache/macos-signatures` directories without overwriting existing files; append `--check` to inspect them. Fill the [preset](../config/macos-packaging/test.env.example) and [signing](../config/macos-packaging/macos-signing.env.example) templates outside the checkout. Set secret and certificate files to mode `0600`. `DSH_PACKAGING_CONFIG_DIR` selects the absolute `packaging` directory and `DSH_PACKAGING_PRESET` selects its preset; missing files fail without falling back to `.env.macos`. Signed and preparation-only Mac builds read `secrets/macos-signing.env`; relative credential paths resolve beside that file. Public presets reject signing credentials, and signing files cannot override public settings. Local unsigned Mac builds retain their configuration-free behavior.

Run `bash apps/desktop/scripts/start-macos-packaging-runner.sh "$HOME/dsh-ci/runner" "$HOME/dsh-ci/packaging" <absolute-node-24-bin-directory> --check` to check the host tools and configuration files. The script selects the active Xcode and its macOS SDK together and compiles a small linker probe. After registration, omit `--check` to run in the foreground with a cleared inherited environment and prevent idle sleep while the runner is alive. Stop it with Ctrl-C before installing the service below. The runner owns its `_work` checkout, separate from daily development. The account can read its signing files, so run only trusted code. The existing notarization proxy restoration rules apply; after forced termination, inspect retained recovery records before another build. New setup templates set `DSH_DESKTOP_MACOS_SIGNATURE_CACHE_DIR` to the absolute `cache/macos-signatures` directory outside checkout. For existing installations, rerun setup and add that field to each preset; existing files are preserved. This retains signatures across clean checkouts; cache verification and limits are described under [macOS signing](#macos-release-signing).

ZIP compression uses the same configured level with or without notarization; the App is assembled once, then DMG and ZIP are built separately so the ZIP setting does not change DMG compression. The `skip_notarization` workflow option defaults to `false`; the equivalent CLI flag is `--skip-notarization`. It retains Developer ID signing, DMG signature verification and packaged-runtime verification, but omits Apple notarization and stapling and does not require Apple notarization credentials. DMG/ZIP filenames carry `-unnotarized`, are stored under `.desktop-build/targets/<target>/unnotarized-artifacts/`, and are uploaded with an `unnotarized-debug` label. These artifacts are for internal debugging only: Gatekeeper may block downloaded copies, and they are not qualified for distribution or update publishing. No release completion record is written. The flag rejects unsigned, Windows and preparation-only builds.

Install the user service from the checkout as the same account that registered the runner, without `sudo`:

```sh
bash apps/desktop/scripts/macos-runner-service.sh install "$HOME/dsh-ci/runner" "$HOME/dsh-ci/packaging" /opt/homebrew/opt/node@24/bin
bash apps/desktop/scripts/macos-runner-service.sh start "$HOME/dsh-ci/runner"
bash apps/desktop/scripts/macos-runner-service.sh status "$HOME/dsh-ci/runner"
```

The installer copies its startup script into `runner/dsh-service`, sets the service PATH to Node 24 plus system tools, and uses GitHub's `svc.sh` and `runsvc.sh`. The LaunchAgent survives SSH disconnection, but requires that account's desktop login after reboot and stops on desktop logout. FileVault disk unlock remains an operator step; this does not provide unattended boot. Logs are `runner/dsh-service/stdout.log` and `stderr.log`; verify `Connected to GitHub` and `Listening for Jobs`. To update installed startup code or tool paths, wait until the runner is idle, run `stop`, then `uninstall`, and repeat installation. Neither action unregisters the runner or removes packaging credentials. Uninstall retains `runner/dsh-service` (including logs) and the explicit `.path`; reinstall replaces the startup snapshot and PATH.

<a id="unsigned-windows-test-installer"></a>

## Unsigned Windows test installer

On Windows x64, use the complete unsigned packaging command for local installation testing:

```sh
pnpm run package:desktop:win:x64:unsigned
```

The command reads `.env.windows` and requires `DSH_DESKTOP_APP_ID` and the [mandatory-update policy settings](../README.md#mandatory-update-policy), including a real HTTPS service origin. The local run and CI use Node 24; the remaining tools are the root `packageManager` version of pnpm, Git, PowerShell 7 (`pwsh`), tar, Python, Visual C++ Build Tools and a Windows SDK. Set `PYTHON` when Python is absent from `PATH`. It writes the installer to `.desktop-build/targets/win-x64/unsigned-artifacts/`, omits ordinary automatic-update configuration, strips signing credentials, and creates no release completion record. EV and upload credentials are unnecessary. Signed packaging and upload retain their release requirements.

Run `pnpm install --frozen-lockfile`, then `pnpm run package:desktop:win:x64:unsigned --check` to validate configuration and tooling before the full command above. Packaging performs its own complete build and isolated runtime smoke without an online model. Stage logs remain under `.desktop-build/packaging-runs/`; a successful build alone does not qualify the installer. Dependency installation and runtime preparation need access to npm, GitHub release assets and nodejs.org; use the existing registry and proxy configuration when the network requires it. Caches and tool locations belong to the build machine, not tracked personal paths.

<a id="local-macos-dmg-without-release-signing"></a>

## Local macOS DMG without release signing

After `pnpm install`, run one command from the repository root. No `.env.macos`, Apple account, certificate, or update service configuration is required:

```sh
pnpm run package:desktop:mac:arm64:unsigned
pnpm run package:desktop:mac:x64:unsigned
```

Add `--check` to validate local configuration and tools without building, or `--dir` to stop at the unpacked application. The DMG is `apps/desktop/.desktop-build/targets/<target>/unsigned-artifacts/deepseek-harness-<version>-mac-<arch>-unsigned.dmg`. After all checks pass, the command prints `DMG:` followed by its absolute path. Open it and copy the application to a local test directory.

These commands ignore `.env.macos` and inherited release settings, use `com.deepseek.harness` as the app ID, and omit automatic-update and mandatory-update configuration. Build tools, standard network proxies, and `DSH_DESKTOP_NPM_REGISTRY` remain available from the shell. They skip Developer ID signing, Apple notarization, temporary signing keychains, and notarization proxy changes. Electron receives a local ad-hoc signature without certificates so the modified executable can run; the DMG is unsigned. Both preparation and the assembled application still run runtime integrity and smoke checks. Local builds omit update feeds, ZIPs, and release completion records, and the upload commands cannot publish them. macOS may require approval in System Settings → Privacy & Security to open an unnotarized application.

<a id="macos-release-signing"></a>

## macOS release signing and diagnostics

The signed macOS configuration uses the required release environment instead of accepting whichever certificate appears first in a keychain. It rejects empty values, a malformed Team ID, a signing identity that includes electron-builder's unsupported `Developer ID Application:` prefix, and incomplete notarization credentials. Signed macOS packaging requires the configured identity and its private key. Runtime preparation applies that identity, a secure timestamp, and hardened runtime to every embedded Mach-O file; after signing the application, a deep strict check rejects any other leaf authority or Team ID before artifact creation. The signed fixed-target macOS installer commands create separate copies of the signed application and run two artifact lanes concurrently. One lane notarizes and staples the App before generating the ZIP and its update metadata. The other encloses its signed App copy in a signed DMG, then notarizes, staples, and verifies the DMG; its inner App has no individually stapled ticket. Both lanes must finish successfully before their artifacts reach the final directory and the release completion record is written. Signed directory-only commands also require notarization credentials and wait for Apple notarization and App stapling. The [parallel notarization decision](../../../.agents/notes/implemented/process/2026-09-09-parallel-macos-notarization.md) owns copy isolation and container ticket semantics. `CSC_LINK` must name a local p12 containing the Developer ID Application certificate and private key; URLs and Base64 inputs are not supported. `CSC_KEY_PASSWORD` is its export password, not an Apple account or login password; an explicitly empty value supports an unencrypted p12. Before building, packaging creates and unlocks a private temporary keychain, imports the p12, authorizes signing, and signs a small probe. Runtime and App signing use this keychain explicitly; existing login keychains require no setup or manual unlocking. Child processes receive its path without the p12 password. The keychain is deleted after success or ordinary failure; CI must clean temporary credentials after forced termination. Ephemeral CI writes the certificate and `.env.macos` from its secret store, restricts file access, and deletes both after the job; self-hosted machine presets retain private files outside the checkout. Ambient `CSC_NAME` and certificate discovery order do not select the release owner. Notary credentials may instead use electron-builder's complete Apple ID or keychain-profile strategy. The two macOS identity variables are also required when repeating the application check manually with `pnpm --dir apps/desktop run verify:mac-signature -- <path-to-app>`.

macOS signing visits real files without following Framework symlink aliases. PAK resources retain all shipped languages and are sealed by the enclosing Framework or application signature instead of receiving individual signatures. The [release policy](../../../.agents/notes/implemented/architecture/2026-08-25-electron-desktop-packaging-and-updates.md) owns the dependency patch and verification requirements.

macOS runtime preparation caches verified single-architecture Mach-O signatures in `.desktop-build/targets/<target>/signature-cache` unless `DSH_DESKTOP_MACOS_SIGNATURE_CACHE_DIR` selects external storage. An explicit path must be absolute and already exist, contain no linked ancestors, and be owned by the current account with mode `0700` and read/write/search access; invalid or empty settings fail preflight without fallback. Omit the field to retain target-local storage. Keys include input bytes and permissions, the signing probe’s actual leaf certificate, identifier, entitlement bytes, macOS version, and signing tools and policy. Git commits do not determine reuse: uncommitted byte changes invalidate the affected file. Every hit verifies cached bytes, the strict signature, certificate, identifier, entitlements, secure timestamp and hardened runtime before replacing an unchanged input. Universal binaries are signed each time. Runtime integrity and smoke checks, App signing, and Apple notarization still run. The cache requires trusted local build storage. Cache corruption or unsafe links fail the build; stop packaging before deleting the affected cache directory and retrying. Successful signing stages prune complete entries to a one-GiB payload budget; interrupted temporary entries require manual removal. Concurrent eviction can fail a reader safely. Logs report hit, miss and uncached counts.

Mac package commands print `DESKTOP_PACKAGING_RECORD` with a unique directory under `apps/desktop/.desktop-build/packaging-runs/`. After reading local configuration, each run retains `run.json` (published version, product version, Git commit, dirty-worktree flag, target and Node version), `events.jsonl` (timestamped phases, durations, parallel output attribution and proxy restoration), redacted child `stdout.log` / `stderr.log`, and `result.json` (overall outcome, stage results and artifact directory). Events also record pack concurrency and whether each proxy is configured. Logs survive failures and later builds; no automatic deletion runs. Missing `result.json` means completion is unconfirmed. Known credential values are redacted; environments and notarytool authentication arguments are not recorded. Runtime preparation records package staging, installation, materialization, signing, manifests, smoke checks, descriptor verification and cleanup separately. Nested phase durations overlap and must not be added together.

App and DMG notarization each record a submission ID and separate `notarytool:upload:*` and `notarytool:wait:*` durations. Upload uses `submit --no-wait` and includes authentication, local validation, transfer and server acceptance; it is not pure transfer time. Waiting starts after that command returns and includes polling and remaining Apple processing; Apple can start processing before upload submission returns. Apple status and diagnostic logs are retained, including rejection; signature checks, acceptance checks and stapling remain owned by `@electron/notarize`. Directory-only package commands use this same measured App notarization path. Individual subprocess output remains live in the terminal, while phase failures and nested errors are retained in the journal. Both platforms record parent-process packaging failures and print redacted diagnostics, including proxy recovery instructions, to the terminal. The configuration-only `check:package` command creates no run log.

Mac packaging reads these tuning fields from `.env.macos`:

| Setting | Default | Scope |
|---|---|---|
| `DSH_DESKTOP_MACOS_PACK_CONCURRENCY` | `4` | Workers for first-party and vendor workspace tarballs; requires a positive integer. |
| `DSH_DESKTOP_MACOS_ZIP_COMPRESSION_LEVEL` | `3` | Final update ZIP compression, integer `0`–`9`; lower levels trade larger downloads for shorter builds. App notarization archives and DMG compression are unchanged. |
| `DSH_DESKTOP_MACOS_DOWNLOAD_PROXY` | Empty | HTTP/HTTPS proxy origin for Electron, runtime assets, pnpm installation and builder downloads. |
| `DSH_DESKTOP_MACOS_NOTARIZATION_PROXY` | Empty | HTTP proxy origin for Apple tools through temporary system proxy settings. |

The proxy fields are independent and reject URL credentials, paths, queries and fragments. Empty values preserve inherited networking. An explicit download proxy replaces child-process proxy variables and bypasses local hosts only; it does not change system settings. Company proxy addresses belong in the ignored local file; see internal documentation for addresses.

Apple tooling uses the active macOS network service's HTTP/HTTPS proxies. Configured notarization routing checks proxy reachability, saves that service's settings, enables the proxy around both artifact lanes, and restores the saved settings after both lanes settle. An originally disabled proxy with an empty server and port zero is restored by disabling it; the temporary server and port may remain stored but inactive. Directory-only builds apply it to App notarization after the signed directory build. This temporarily affects other applications and requires permission to change system proxies; PAC, auto-discovery, SOCKS and authenticated proxy configurations must be disabled first. Packaging and recovery acquire the same per-user POSIX file lock before reading recovery data or changing proxies; process exit releases ownership, while the lock file remains in place. The lock loads `@deepseek-ai/node-addon-system/flock` at first use rather than at script start, so `check:package` and the packaging entry load on a checkout that has not built `native/system`; when the host addon binary or the entry's JavaScript is missing at lock time, the loader runs `pnpm run build:native-system` and `pnpm --dir native/system run build:ts` before locking, so recovery works on such a checkout as well. This prevents overlapping proxy transactions across checkouts; other users and network-setting tools must not change these settings concurrently. SIGINT/SIGTERM wait for active work before restoration. After forced termination or a restoration error, stop any remaining notarization processes and run `pnpm --dir apps/desktop run restore:mac-proxy`; the saved record remains until restoration succeeds. Configuration checks validate URL syntax without changing system settings or contacting the proxy.

<a id="directory-and-preparation"></a>

## Directory builds and preparation

Create a runnable application directory instead of an installer by using the matching `:dir` command, such as:

```sh
pnpm run package:desktop:dir
pnpm run package:desktop:mac:arm64:dir
```

To inspect or troubleshoot the prepared host-target resources without invoking electron-builder, stop the same pipeline after preparation:

```sh
pnpm run prepare:desktop
```

This diagnostic command is an alternative stopping point, not the first half of a two-command build. A later `package:desktop*` command repeats the build selected by its signing mode and all preparation so it cannot consume stale dsh packages, runtime files, or dsh content.

<a id="local-official-bundles-from-a-loopback-registry"></a>

## Local Official bundles from a loopback registry

The test DMG excludes the provider runtimes the Official on-demand catalog advertises, and a release publishes matching bundle versions to npm. To install locally built bundles before that release, start a loopback registry that packs and serves the catalog's complete local dependency closure:

```sh
pnpm run dev:bundle-registry
```

The command validates the catalog and the workspace inventory, runs `pnpm run build:official`, packs the closure into a new `dist/test-bundles/<run-id>/` directory, writes `bundle-registry.json` last as the completion marker, and only then prints the artifact path, the registry URL, and the exact `name@version` specs. It serves `127.0.0.1` on an allocated port under a fresh namespace until Ctrl+C or SIGTERM, and stopping it leaves both the artifacts and the installed packages on disk. It needs no `.env.macos`, Apple credentials, or npm credentials, and it does not change `pnpm run package:desktop:unsigned`.

In the packaged application, open Plugins → Add plugin, paste one printed spec, choose **Custom address**, paste the printed registry URL, and install. A custom registry is asked alone, so this process must answer every dependency: repository-owned packages come from the run's own archives, and third-party packages keep npm's real metadata and bytes through a fixed redirect to `registry.npmjs.org`, which still requires network access. The installed entry stays Official because its package name is in the catalog. The registry choice is remembered in this browser; choose an offered registry again to switch back.

A run's artifacts are immutable, so a rebuild serves a new namespace and a new URL, and the Official **Update** control does not appear while the installed and running versions match. The profile records the previous run's tarball URL in `pnpm-lock.yaml`, and pnpm verifies recorded entries, so installing or reinstalling that bundle against a new URL is refused with `ERR_PNPM_TARBALL_URL_MISMATCH` and can leave the earlier files in place. To test changed code at the same version, clear the stale resolution first — `pnpm clean --lockfile` in `$DSH_HOME/profiles/<profile>`, or install into a fresh profile — then install again from the new URL. `bundle-registry.json` records each archive's version, filename, size, and SHA-512 integrity together with the packing checkout's commit and dirty flag.

The served `time` is the real packing time, so pnpm 11's default 24-hour `minimumReleaseAge` records the exemption it granted in the profile's `pnpm-workspace.yaml` (`minimumReleaseAgeExclude`); an explicitly stricter policy there fails the installation with pnpm's own message instead of being overridden. A `@scope:registry` route in `~/.npmrc` or the profile's `.npmrc` overrides `--registry` for that scope, so it must not route the served scope.

<a id="runtime-file-selection"></a>

## Runtime file selection and installation checks

Desktop packs workspace packages locally and installs external dependencies through the target's bundled Node and pnpm. [Desktop's file policy](../scripts/runtime-file-policy.ts) then filters the immutable `resources/app.asar/dsh/node_modules` copy before signing and integrity sealing. It omits TypeScript declarations, recognized JavaScript/CSS/TypeScript source maps, TypeScript build caches, Domino's test directory and Yarn development metadata, selected native compiler outputs, and node-pty prebuilds for other platforms. Non-Windows targets also omit `node-pty/third_party/conpty`; Windows targets retain that directory. It preserves runtime JavaScript, target native modules and their DLL/EXE helpers, WASM, unknown assets, licenses, and notices. Dependency manifests pass through electron-builder's metadata cleanup before integrity sealing, so archiving preserves their recorded bytes. The policy does not alter npm tarballs, the bundled package manager, or user-installed plugin files.

The [Electron shell file list](../scripts/electron-builder-config.mjs) excludes recognized JavaScript/CSS/TypeScript source maps and TypeScript build caches from the separate `resources/app.asar/node_modules` dependency collection. These exclusions preserve runtime code, native modules, WASM, data files (including ordinary `.map` assets), licenses, and notices; [shell archive tests](../tests/shell-file-selection.spec.ts) check retained bytes and exclusions.

The [Office conversion provider](../../../packages/document/office-to-pdf/README.md) carries the target’s declared native engine, or WASM when the kit declares no matching native target. Preparation rejects a missing target engine before packaging. The complete Office dependencies, including CLI, JavaScript libraries, and the selected engine’s executables, data, licenses, and notices, are unpacked under `resources/app.asar.unpacked/dsh/node_modules/`. The Desktop Host resolves engine manifests to these physical directories and supplies loaded skills with absolute standalone Node and unpacked CLI paths. Node lives in `resources/runtime/primary-runtime/dependencies/node/bin/`; the CLI is the unpacked `@deepseek-ai/libreoffice-kit/lib/cli.js`. On macOS, the native helper receives the JIT entitlement required by [LibreOffice’s UNO bridge](https://github.com/LibreOffice/core/blob/master/sysui/desktop/macosx/hardened_runtime.xcent.in).

The packaged application runs compiled JavaScript and pre-generated Typert metadata; it does not compile TypeScript plugins. Source-level debugger navigation and editor declarations remain available in development packages. [Copy-policy tests](../tests/runtime-file-policy.spec.ts) cover exclusions and retained assets; The [payload smoke](../tests/fixtures/runtime-payload-smoke.mjs) runs under Electron RunAsNode before the Host smoke and final inventory verification. The payload smoke resolves the search tool’s ripgrep executable and verifies text search and file enumeration. Signed Windows builds run these checks after dependency signing; other builds run them during `prepare:dsh`. The [Host smoke](../scripts/smoke-runtime.ts) creates DOCX, XLSX, and PPTX inputs with bundled Python, converts each through the real Office provider, and checks PDF output. Every assembled application, including directory and unsigned builds, repeats the payload and Host checks against ASAR. Archive integrity checks compare the complete archived descriptor with preparation, file bytes and membership in both archive and unpacked trees, recorded executable flags for archived files, and physical permissions for unpacked files. The Host smoke also obtains CLI paths from the loaded skill and runs capabilities and DOCX conversion with an empty PATH. Conversion failures stop packaging before a release record is written; macOS DMG/ZIP builds run these checks before notarization.

Windows release qualification also runs [directory and replacement checks](../scripts/smoke-windows.ps1) manually after the Desktop build. Set `$Makensis`, `$SevenZip`, and `$PluginDir` to the pinned builder’s NSIS compiler, 7-Zip executable, and x86-unicode NSIS plugin directory; pass the prepared `window-frame.dll` as `-FrameLibrary` to exercise the native extraction path and its failure report as well. From the repository root, run the command below. It verifies directory replacement and rollback, and both locked-file replacement modes; it is not part of the unit-test lane.

```powershell
pwsh -NoProfile -File apps/desktop/scripts/smoke-windows.ps1 -Makensis $Makensis -SevenZip $SevenZip -PluginDir $PluginDir -FrameLibrary apps/desktop/.desktop-build/targets/win-x64/installer-ui/window-frame.dll
```

The Windows installer checks for a running application at startup and after destination selection, before extracting the new version beside the installation directory. It checks again before replacing directories through same-volume renames. A running application blocks installation; update launches allow up to ten seconds for it to exit. Same-path upgrades preserve the old directory until promotion succeeds; extraction failure leaves it intact, and promotion failure attempts to restore it. The installer removes the old backup before launch. Forced termination or power loss can leave `.new-*` or `.old-*` directories; installation-location and scope migrations retain electron-builder's old-uninstaller flow.

Directory renames, empty-destination removal, and restoration retry Windows errors 5, 32, and 33 up to ten attempts, with 250 ms increasing delays (11.25 seconds of total waiting per operation). Other errors stop immediately. A replacement failure reports the Windows error, affected paths, and restoration outcome in `directory-failure-<timestamp>.log` beside extraction reports. If restoration fails, the installer removes unlocked staging files and preserves the backup. After reporting that failure, exit cleanup does not retry restoration. Keep the backup path named in the report and contact support before reinstalling. Silent installs save the same diagnostic without a dialog.

When extraction fails, the installer writes a report with the 7-Zip result and its complete error output to the updater cache directory as `%LOCALAPPDATA%\<package-derived name>-updater\installer-logs\extract-failure-<timestamp>.log` (currently `@deepseek-aidsh-desktop-updater`) and shows the first error line with a **Copy error details** button; silent installs write only the report. Unsigned Windows builds (`DSH_DESKTOP_UNSIGNED=1`) name their installer `deepseek-harness-<version>-win-x64-unsigned.exe` so they cannot be mistaken for release artifacts.

Windows packaging fixes the 7-Zip filter to `BCJ` for compatibility with the bundled NSIS decoder. This preserves ARM64 binaries carried by dependencies in x64 installers; automatic ARM64 filtering produces entries that this decoder cannot extract.

`DSH_DESKTOP_WINDOWS_COMPRESSION_LEVEL` in the Windows dotenv or machine preset selects installer archive compression from `0` to `9`. If omitted, the existing `ELECTRON_BUILDER_COMPRESSION_LEVEL` environment override remains effective, otherwise the default is `3` for both test and production. The manual Windows workflow's `compression_level` dropdown defaults to `3` and also offers `7`, matching the Mac ZIP choices; it overrides the file setting for that run. Direct local builds retain explicit machine settings. Mac ZIP workflow overrides must be `3` or `7`; an empty value is invalid even on macOS. Any defined Mac ZIP workflow override, including an empty value, rejects Windows; nonempty Windows workflow overrides reject macOS. Lower levels trade installer size for packaging time; qualify the complete signed workflow and artifact size before changing a release preset.

NSIS removes its temporary extraction tree during installation, before the completion page or an automatic launch. The installed production packages remain ordinary files; startup does not extract them again. Installation still writes the complete application tree.

<a id="desktop-runtime-preparation"></a>

## Desktop runtime preparation

Windows prepares Electron and primary-runtime concurrently; macOS prepares them serially. CLI preparation and `versions.json` publication require both payloads to succeed. If either Windows payload fails, preparation waits for the other to settle before reporting failure and publishes neither CLI resources nor versions. Nested preparation timings overlap and must not be added together.

`DSH_DESKTOP_PACKAGE_CACHE_DIR` in the packaging process environment selects a nonempty absolute directory for shared `downloads` and `pnpm-store` caches; omission uses `.desktop-build`. Temporary installation projects, lockfiles and configuration remain separate per run. Runtime installation verifies store integrity and copies package files so later signing cannot modify cached bytes; cleanup retains these caches. Both packaging workflows use `runner.tool_cache/dsh-desktop-package-cache`; Windows repository dependency installation uses a separate `.pnpm-store` at the workspace drive root. Both installation logs identify their store and report package reuse. A fresh runtime lockfile still resolves dependencies on every run. Share writable caches only among trusted build jobs; integrity checks do not isolate untrusted writers. Clean caches only when no job is using them. Operators manage cache disk usage; no automatic eviction runs.

Desktop [patch policy](../scripts/runtime-patch-policy.ts) explicitly classifies every workspace patch as shared, workspace-only, or runtime-only. Shared entries reuse the root patch bytes and verify their hash against the root lockfile; runtime-only entries use separate repository files without changing workspace installation. Workspace-only patches belong to build tools or dependencies already embedded in client bundles. Unclassified or stale entries, missing files, changed hashes, incompatible resolved versions, and workspace-only packages entering the runtime stop packaging. The [preparation script](../scripts/prepare-runtime-patches.ts) writes only to the temporary project; pnpm applies the selected patches and rejects application failures.

Desktop dependency overrides are declared separately in the patch-policy module, not inferred from patch versions. The pi-ai constraint keeps its runtime version at the version qualified by the shared patch. Desktop still resolves a fresh runtime lockfile for each build, then installs with `--frozen-lockfile`; dependency resolution across separate builds is not yet reproducible. CLI packed-installation tests and other distribution flows retain their own configuration.

Every package command builds the repository, packs the first-party production closures rooted at dsh and the private Desktop Host, and prepares the target Electron distribution plus primary-runtime with its shared pnpm CLI. `prepare:dsh` installs the production graph once at build time, prepares materialized packages for electron-builder to archive under `app.asar/dsh`, removes package-manager metadata, and writes `desktop-runtime.json` with shared package versions and final file hashes. Signed macOS builds sign and verify native files before inventory generation; electron-builder excludes this already-signed tree from nested re-signing. Resource mappings explicitly include `dsh/node_modules`, which the default root-directory filter omits; the prepared runtime inventory is checked after native signing. Native executables and libraries are unpacked beside ASAR; Python, standalone Node and pnpm remain in external runtime resources. Windows packaging checks every prepared PE against its ASAR unpacked entry and byte-identical disk copy, including unsigned builds. Builder glob rules match braces in PE filenames as single-character wildcards, so a matching neighboring file may also be unpacked. Prepared runtime smoke uses the verified target descriptor rather than the build host architecture. Signed installer, notarization, installed upgrade, and target-specific native-module qualification require the release environment.

Windows runtime sealing reads at most eight files concurrently, before and after native signing. A read failure drains outstanding reads without replacing the descriptor; successful sealing still requires the subsequent complete integrity and smoke checks.

Signed macOS packaging writes `Contents/Resources/app-update.yml` while assembling the App and before code signing, including the directory build that feeds the parallel ZIP and DMG lanes. The signing hook verifies the exact feed and updater cache directory. Both lane copies and the promoted App are checked again before the release completion record is written; a missing or mismatched configuration prevents artifact promotion and therefore prevents upload.

An unpacked artifact contains Electron, the materialized dsh production tree, pnpm, and the shell application. Installer size and filesystem size differ; release qualification measures both, plus the profile’s plugin storage and first-launch latency. The runtime trades more application files for eliminating core package installation on the user’s machine.

<a id="verification"></a>

## Installation and release verification

Windows lists the installed application by product name without a version suffix; the version remains in the separate version field. Desktop's `package.json` `author.name` supplies the installer publisher and executable company name, independently of the signing certificate. Windows and macOS retain product-name copyright text. Installation or upgrade with a rebuilt installer applies the new metadata; existing installations retain their previous values until then.

Keep the generated installer, its version and packaging records together. Review signatures and runtime checks before installation, then follow the [installed-update qualification procedure](../tests/installed-update/README.md) for installed launch and upgrade evidence. The [Desktop test record](../tests/README.md) owns verification limits; a successful workflow alone does not establish production preset, new-workstation or installed-upgrade acceptance.

## Dev Note

XXX: Evaluate disk-space monitoring, a maintenance entry point and automatic eviction if disk shortages, sustained cache growth or frequent manual cleanup occur. Any automated cleanup would need coordination with every cache user.
