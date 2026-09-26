# Agent Note: Desktop primary runtime

Status: implemented

English | [中文](2026-09-14-desktop-primary-runtime.zh.md)

## Problem

Desktop agents need predictable Python data-processing libraries and an independent Node interpreter on machines without development environments. System interpreter selection must remain under user control.

## Decision

Desktop ships Python, Node.js, pnpm, data-processing libraries and Office authoring libraries as one release-bound payload. The path-query tool installs the payload from application resources into the fixed Harness-home directory and returns absolute paths and the bundled Python distribution versions. The version report excludes packages added by users. It does not change PATH, environment variables or package-manager configuration. pnpm uses its native global-install rules.

The application version, top-level interpreter/package-manager versions, Python distribution map and locked-input digest live in `runtime.json`, not the directory name. The digest covers the selected target's interpreter and wheel archives, shared wheel inputs, Python distribution versions, pnpm version and assembly format; other targets do not invalidate it. Key order within the selected target, wheel records and distribution map, plus wheel-entry order, participates in this identity; top-level lock key order does not. Extraction or assembly changes that alter payload bytes without changing locked inputs require an explicit format bump. Installation publishes a completed staged copy and retains the previous directory until replacement succeeds. Matching payloads reuse installed files; replacements also replace user-added Python dependencies inside the managed tree. Older manifests without a digest remain readable and differ from the current payload. Distribution names use PEP 503 normalization; duplicate normalized names are rejected. The reader normalizes legacy `components` files and retains their numpy/pandas consistency checks; current manifests carry Python libraries only in the distribution map. The Desktop single-instance owner and the tool's shared installation promise serialize normal installation requests.

The shared Node build entry downloads and hash-verifies the complete locked wheel set and unpacks library files into site-packages. This avoids build-host Python and pip version selection without implementing dependency resolution or general wheel installation. Auxiliary scripts, including XlsxWriter's VBA extraction script, remain under the wheel's `.data/scripts` directory; command-line entry-point wrappers are outside this library payload. Other `.data` installation schemes are rejected. Native smoke executes the final payload after temporary files are removed, checking the exact locked distribution set plus bundled pip, Python and pinned wheel versions, dependency completeness and editable Office document round trips, so interpreter links must survive relocation. Smoke checks disable bytecode writes to keep validation artifacts out of the shipped payload.

macOS grants `com.apple.security.cs.allow-jit` only to the standalone Node executable. Hardened-runtime signing without that entitlement prevents V8 from allocating its code region. Interpreter and library smoke checks run after signing as well as after staging cleanup; a valid signature alone does not establish executable behavior.

Windows signed packaging separates materialization from execution with supervised signing stages for the primary runtime and application production dependencies. PE inspection identifies content independently of extensions, excludes non-PE foreign-platform Node addons and refuses directory links. Public-key verification uses batches of 32 files with at most four processes and drains each batch before returning failure; hardware operations remain serial. Valid vendor signatures remain intact; only unsigned files receive the configured EV signature. Invalid existing signatures fail before hardware access, and each new signature is checked for validity, timestamp and certificate identity before the next file. Electron-builder's copy-time signing hook preserves runtime executables only after exact-byte and signature verification; the same serial queue rejects later tasks if preservation fails. The existing per-user interlock, serialized signer and redacted journal own hardware calls; hardware failures prohibit retries and later stages. Public timestamp attempts follow the [signature completion policy](../process/2026-09-17-windows-signature-completion.md). Runtime execution receives no signing credentials and follows complete verification. Development and unsigned preparation retain native smoke without automatic hardware access. Runtime inventories record signed bytes. Electron-builder unpacks detected dependency PE files and preserves signed copies. Final signature verification and ASAR payload and Host smoke use a private native cache before release completion.

Desktop ZIP extraction pins `extract-zip` to `yauzl` 3.4.0 through a scoped dependency override. The 2.x reader can leave large deflate entries unfinished on Node 26 ([upstream issue](https://github.com/thejoshwolfe/yauzl/issues/176)); retaining the existing extractor preserves its path validation and wheel-entry checks. The development launcher uses top-level await so unfinished preparation cannot exit successfully. A large compressed wheel regression checks the complete extracted bytes.

The [shared-runtime decision](../architecture/2026-09-17-shared-office-runtime.md) owns builder, lock and query-package placement for Desktop and SDK carriers, including GNU/Linux x64 and Python-only payloads. Desktop retains the installation and signing behavior described here and requires the full Python, Node.js and pnpm payload.

## Alternatives considered

**System interpreters only.** They do not provide predictable availability or preinstalled numpy and pandas.

**PATH injection and dedicated pnpm global directories.** They change command selection or require pnpm's global command directory to be on PATH. Absolute interpreter paths and native pnpm behavior satisfy the requested scope without those changes.

**Independent updates and version-named directories.** Runtime releases are coupled to Desktop, and the requested installation location is stable.

**Multi-file SignTool requests.** A software-certificate probe with a missing first file still signs the second file before returning an error. One process cannot guarantee stopping hardware operations at the first failure; token signing remains one file per supervised request.

**Signing only the interpreter or bypassing native smoke.** Windows code integrity also evaluates DLLs and Python extensions. A signed launcher cannot make an unsigned extension load, and skipping execution would hide unusable installed dependencies. Preserving valid upstream signatures avoids unnecessary hardware operations and retains upstream attribution.

Dependency manifests use electron-builder's own cleanup before inventory sealing. Its archive writer otherwise changes package metadata after signing; pre-applying that transformation keeps the final archive verifiable without replacing the sealed inventory after packaging.

## Consequences

The application carries additional native files and replaces the complete managed payload on upgrade. Running interpreters can prevent replacement on Windows. Native build smoke, install/reuse/recovery tests and a keyless tool-error session cover distinct installation and model-output paths; macOS signing uses the existing native-runtime signer. Interpreter archives and Python wheels are hash-pinned, and licenses remain with their distributions.
