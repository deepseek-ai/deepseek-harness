---
description: "Operator checklist for a Windows installed update with a failed download, explicit retry, and retained evidence."
---

# Windows installed-update walkthrough

English | [中文](README.zh.md)

## Summary

Prepare a private test application and fresh test distribution namespace, then let the operator install, inject a fault, retry, and confirm restart. A local manifest or complete journal sequence does not certify an installer or preserved data. The installed-app steps below remain unverified until the operator performs them with verified packages.

## Table of Contents

- [Prepare materials](#prepare)
- [Operator sequence](#sequence)
- [Evidence and recovery](#evidence)
- [Dev Note](#dev-note)

<a id="prepare"></a>

## Prepare materials

From the repository root with dependencies installed, allocate a run with two increasing derived test versions. This writes only an ignored local manifest; it does not build, sign, upload, install, or read credentials.

The examples use base version `0.1.6-alpha.1`. Before creating new material, substitute the actual base, Asia/Shanghai date, and unused index according to the [release version rules](../../README.md#release-versions).

```powershell
node --import tsx apps/desktop/scripts/prepare-installed-update.ts init 0.1.6-alpha.1.20260916.1 0.1.6-alpha.1.20260916.2
```

Retain the returned `run.json` and reuse its random identity and `qualification/<id>` paths for both packages. The source commit and dirty-file list identify the starting checkout, not the contents of a later package. Record final build source identifiers and artifact hashes separately; do not regenerate the manifest midway through an update.

Prepare fresh source resources with the repository's preparation-only workflow, then generate the shared bootstrap, two private version-bound runtime copies, and frozen application files. Replace `<run.json>` with the allocator's manifest path. Preparation-only builds and checks the source runtime but stops before signing; the other commands never invoke a signer or installer. These commands refuse to overwrite existing per-run outputs; retain partial material after an error instead of retrying over it.

```powershell
node apps/desktop/node_modules/pnpm/bin/pnpm.mjs --dir apps/desktop run prepare:package win-x64
node --import tsx apps/desktop/scripts/prepare-installed-update.ts bootstrap "<run.json>"
node --import tsx apps/desktop/scripts/prepare-installed-update.ts runtime "<run.json>"
node --import tsx apps/desktop/scripts/prepare-installed-update.ts application "<run.json>"
```

Package both files from the generated `bootstrap` directory beside `lib/`, and set the package main entry to `qualification-bootstrap.mjs`. That entry validates the installed application ID and version before loading production main. It assigns Electron user/session data, Harness home, and journals under the operating system's application-data directory at `dsh-update-qualification/<id>/`; both versions use the same paths. The runtime copier changes only release-family package versions and matching dependency references, preserves third-party versions, and re-verifies both copied inventories and the untouched source. Its `runtime-preparation/result.json` records hashes and explicitly does not claim signing or startup qualification of the copied versions. These synthetic versions are test materials, not npm releases.

The `application` command copies built main/preload modules, renderer files, and the prepared bootstrap into `application/files`, with SHA-256 values in `application/result.json`. It does not copy the app's root `.env.windows` or freeze `node_modules` and build tools. The [qualification builder configuration](../../scripts/installed-update-builder.ts) verifies this inventory and the selected private runtime, selects the shared frozen files and isolated package metadata, and preserves ordinary installer and signing hooks. Its tests substitute the signer and pass the pinned builder's configuration validator; they do not produce an installer. A separately authorized supervised build must still record dependency/tool inputs and verify final package contents and signatures.

The [packaging entry](../../scripts/package-installed-update.ts) defaults to checks. A retained signing interlock rejects before credentials are loaded; it never clears that interlock. With no interlock, checks load `.env.windows`, validate prepared inputs, and launch no child. The shared builder requires a valid `DOWNLOAD_TEST_RELEASE_ID` from the [test release settings](../../README.md#upload-updates); qualification still publishes through the manifest’s separate `qualification/<id>` paths. Run this from the repository root with one exact version:

```powershell
node --import tsx apps/desktop/scripts/package-installed-update.ts "<run.json>" 0.1.6-alpha.1.20260916.1 --check
```

Actual packaging remains unverified and requires separate hardware-recovery approval and a present operator. The `--execute` mode requires a terminal and an exact confirmation containing the version and run ID; there is no piped approval option. It rechecks the interlock and exclusively allocates that version's `packaging` directory. The supervised child builds only that version, disables publication, strips unrelated credentials, and stops on failure or a 15-minute overall deadline. This deadline does not bound individual CSP authentication attempts. Records retain source/tool hashes, redacted output, events, and artifact file hashes; an existing attempt or output refuses reuse. `builderCompleted` and a successful supervisor result do not establish package verification, signature acceptance, or installation success; `packageVerification` remains `pending` until those checks are performed independently.

Before the operator starts, supply both verified installers, generated metadata and blockmaps, packaging and signature records, the exact installed executable path, and fixed test feed URL. Both packages must use the same test identity, isolated data directories, and absolute external `DSH_DESKTOP_UPDATE_JOURNAL_DIR` on every launch, including an installer-triggered restart. A variable set only in the original launch terminal is insufficient. The [Windows signing rules](../../README.md#windows-ev-signing) still apply; a manifest never clears a signing interlock.

The Windows [read-only signature helper](../../scripts/installed-update-signature.mjs) uses the real updater verifier with a publisher derived from the trusted public certificate, then requires valid Authenticode and timestamp attributes and unchanged SHA-512. Verification children receive no inherited signing/upload secrets or PowerShell module-path overrides. The helper never loads `.env.windows`, signs a file, or executes the inspected executable. Signed-probe acceptance and unsigned-installer rejection have been observed locally; they do not certify either prepared version, package identity, or installation behavior.

The [package verifier](../../scripts/verify-installed-update-package.ts) checks the final installer before extracting it with a reviewed local 7-Zip executable. Supply absolute paths for the manifest, trusted public certificate, and tool; never select a tool extracted from the installer being verified. This command creates a fresh `verification/check-*` directory, preserves partial records, and fails immediately when the installer is absent:

```powershell
node --import tsx apps/desktop/scripts/verify-installed-update-package.ts "<run.json>" 0.1.6-alpha.1.20260916.1 "<public.cer>" "<reviewed-7za.exe>"
```

The verifier checks actual archived application identity, entry, frozen application bytes, updater dependency versions, feed/cache/publisher configuration, and the bundled Harness runtime against prepared inputs; the mandatory test policy must be valid. It extracts the runtime from `app.asar` and checks executable signatures at their `app.asar.unpacked` paths. Changed runtime executables require separate signature checks; other runtime bytes must match the prepared bytes after electron-builder's dependency-manifest transformation. It rejects unsafe archive paths before extraction and records installer, application, and runtime-executable signatures. Before success, it rechecks installer, feed/blockmap, manifest, certificate, and tool hashes. `passed` covers these checks only: dependency bytes are not frozen, and installer registration, startup, upgrade, and data retention remain explicit manual checks. Real archive reading has been observed on a retained older package; complete signed-package verification for the prepared versions remains pending.

Follow the separate [upload and publication procedure](publication/README.md). Leave the fixed feed absent for the 404 case, then publish version 1 for the same-version case. Keep version 2 metadata local until both cases finish in the installed version 1 application. Retain publication records and remote objects for diagnosis; do not delete a published feed to recreate an earlier case.

The local `files` command accepts `<run.json>` and one exact run version. It reads that version's `installer/nightly.yml`, verifies the expected installer name, size, SHA-512, and nonempty external blockmap, and prints separate binary destinations and a fixed-feed body. Missing installers fail validation. It writes nothing and reads no credentials. Its `file-integrity-only` result cannot authorize upload or replace verification of signed package contents and application identity; those remain required before publication.

<a id="sequence"></a>

## Operator sequence

Proceed manually only after preparation passes. Use disposable test conversations and settings, never a production workspace or unsaved work.

1. Install version 1. Record installer path, hash, signature result, and time. Start the installed shortcut and verify its executable path and displayed version; do not launch an unpacked build or development server.
2. Confirm version 1 `started` and `workspace-ready` in a new journal. Create an identifiable test conversation and change a harmless setting; record expected values privately. Complete the two feed checks below and keep version 1 running.
   - **Missing feed:** retain a timestamped GET of the configured fixed URL returning 404. Observe startup automatic checking without a disruptive dialog, then manually check: expect checking followed by failure, not “no updates,” and no download or installation. Save screenshots and journals before publishing anything.
   - **Same-version feed:** after separate authorization, publish version 1 to that same URL and retain the complete 200 response, version, and SHA-512. Check manually in the still-running version 1: expect no available update and its current version, no download or installation, and no stale error indicator from the 404 case. Automatic no-update checking must remain quiet. Retain evidence before authorizing version 2.
3. Authorize version 2 metadata publication at the existing fixed feed URL. Re-read that URL and verify version 2 and its binary hash. Preserve publication evidence after version 1 startup evidence.
4. In version 1, check manually and confirm availability without automatic download. Prepare the reviewed [application-scoped fault and recovery](network/README.md). Never disable the adapter, VPN, shared proxy, remote-control connection, or domain-wide access.
5. Click download and interrupt only the test application's transfer after progress begins. Capture one failure and persistent retry feedback; confirm no installation or silent retry. A connection failure before progress begins is a different observation and does not satisfy a transfer-interruption test.
6. Remove the exact run-owned fault and verify recovery. Click retry yourself. Record progress, verification, and readiness. Expect a separate installation confirmation; download completion alone must not approve restart.
7. Confirm installation. With active tasks, inspect the warning and explicitly authorize stopping them; without tasks, the confirmation must not claim tasks exist. Record the last version 1 window and let installation and restart finish without manually starting another instance.
8. Verify the installed version 2 executable and displayed version. Check the conversation and setting from step 2 and capture the result. Find version 2 `started` and `workspace-ready` in the same external evidence directory. Report missing automatic restart separately from successful manual startup; one cannot substitute for the other.

<a id="evidence"></a>

## Evidence and recovery

The intentional 404 is a check-failure case, not the later interrupted-download case. A browser response alone does not prove application behavior. Keep each observation's URL, UTC time, HTTP status, feed body/hash when present, screenshot, and journal snapshot together. The journal inspector does not certify the two feed cases or record raw HTTP diagnostics; the operator supplies those observations. A later successful manual check must recover without restarting the application.

Retain the manifest, build records, original feeds, binary hashes, publication receipts and readbacks, fault setup/removal evidence, screenshots, and all process journals. Installer logs and test data may contain private paths or content; review before sharing. The inspector is read-only and copies only milestone references, not raw diagnostics. Replace the directory placeholder and use the manifest's exact versions:

```powershell
node --import tsx apps/desktop/scripts/prepare-installed-update.ts inspect 0.1.6-alpha.1.20260916.1 0.1.6-alpha.1.20260916.2 "<journal-directory>"
```

Exit 0 means the ordered journal milestones are present; exit 2 means missing milestones; exit 1 means input or command validation failed. A failure/retry sequence cannot combine different version 1 processes. A successor started before the original process quit is not counted; clock changes can leave evidence incomplete and require investigation. `recordedFlow: complete` is not overall acceptance. The report always requires independent operator checks for publication timing, network failure and recovery, installer completion and path, preserved data, and screenshots and confirmations.

To retain a local journal snapshot and its report, use `collect` with the matching installed application's `dsh-update-qualification/<run-id>/journals` directory. It validates all selected records before creating a fresh `evidence/collection-*` under the material run. The copied journals and `report.json` describe the same in-memory snapshot, with SHA-256 values and `operatorAcceptance: pending`; original files are unchanged. Other files, settings, conversations, build output, and credentials are not collected. Keep their separately reviewed evidence alongside the report, not inside the journal directory.

```powershell
node --import tsx apps/desktop/scripts/prepare-installed-update.ts collect "<run.json>" "<journal-directory>"
```

Collection exit 0 means files were saved, even if the recorded flow is incomplete; inspect `report.json` before drawing conclusions. Failed writes retain partial output and a failure marker when storage permits. Repeated collection creates another directory without replacing earlier evidence. Inspection and collection reject partial tails, unknown fields or diagnostic values, files over 10 MiB, and snapshots over 50 MiB. Collect after the relevant actions settle; a live application can append records after the snapshot, and a racing partial append requires a later collection rather than truncating the original log. Real installed-app collection remains an operator step; tests use the actual journal writer with synthetic lifecycle actions.

Use this report template; leave unobserved results pending:

| Item | Evidence location | Result |
|---|---|---|
| Both installers and signatures verified | | pending |
| Feed 404: automatic quiet failure and manual visible failure, no download | | pending |
| Version 1 feed: no available update in running version 1, prior error cleared | | pending |
| Version 1 running before version 2 publication | | pending |
| Test-only fault and observed download failure | | pending |
| Fault removed and explicit retry reached readiness | | pending |
| Separate confirmation and installer completion | | pending |
| Automatic restart into installed version 2 | | pending |
| Test conversation and setting preserved | | pending |
| Journals and screenshots retained | | pending |
| Test network changes absent afterward | | pending |

Stop at the first failed prerequisite. Signing failure stops packaging and preserves its record; do not retry PIN authentication automatically. A feed mismatch stops the test before download. If a fault affects remote control, stop and restore only its owned change with the prepared recovery action. Do not uninstall, clear caches, delete evidence, or overwrite failed batches to make a later attempt appear successful. Allocate a new run for a clean attempt and retain the failed one.

<a id="dev-note"></a>

## Dev Note

Local allocation and journal inspection have automated tests. Signed package production, isolated network-fault tooling, late feed publication, installer-triggered restart, and this full operator sequence require separate qualification; this page does not report them as completed.
