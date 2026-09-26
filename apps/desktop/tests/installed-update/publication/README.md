---
description: "Separate test binary uploads from operator-authorized fixed-feed publication for installed Windows update qualification."
---

# Test update upload and publication

English | [中文](README.zh.md)

## Summary

Upload both verified versions without advertising version 2, then publish its fixed feed after the operator starts installed version 1. Default commands check local materials without credentials or network access. Actual COS writes require separate operator authorization and verification.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Operator sequence](#sequence)
- [Evidence and recovery](#evidence)
- [Dev Note](#dev-note)

<a id="prerequisites"></a>

## Prerequisites

Complete both package verifications in the [walkthrough](../README.md). Retain successful `verification/check-*/result.json` receipts and unchanged materials. The publisher revalidates each receipt against current installer, blockmap, feed, and manifest bytes. It never signs or installs anything.

The existing `.env.windows` loader supplies `DSH_DESKTOP_AUTO_UPDATE_ENV=test`, `DOWNLOAD_TEST_ORIGIN=https://download-test.deepseek.com`, `DOWNLOAD_TEST_COS_BUCKET=bj-toc-download-test-1320056602`, and `DOWNLOAD_TEST_COS_SECRET_ID` / `DOWNLOAD_TEST_COS_SECRET_KEY`. Only those two upload secrets enter the COS client; never put them in commands or records. The transport restricts requests to the test bucket and private Windows qualification paths.

The binary-upload operation adds a bucket-versioning query and refuses writes unless the query succeeds with neither enabled nor suspended status. Feed publication reuses a successful binary-upload receipt instead of repeating that query or downloading binaries. COS documents that [`x-cos-forbid-overwrite`](https://cloud.tencent.cn/document/product/436/7749) does not protect objects in versioned buckets. A denied query leaves that configuration unknown; it does not establish that uploads are denied.

Use one publisher across all machines. A local `publication.lock` excludes overlapping operations sharing the material directory, not other machines. Version 2 publication checks the existing version 1 feed before replacement; this read and write are not an atomic compare-and-swap. No other publisher may write the same feed concurrently.

<a id="sequence"></a>

## Operator sequence

These are pending manual steps, not completed remote qualification. Run from the repository root with the retained manifest, exact version, and matching verification receipt. Without `--execute`, both commands print a local plan and send no request:

```powershell
node --import tsx apps/desktop/scripts/publish-installed-update.ts upload-binaries "<run.json>" "<version>" "<verification/result.json>"
node --import tsx apps/desktop/scripts/publish-installed-update.ts publish-feed "<run.json>" "<version>" "<verification/result.json>"
```

1. Check both versions locally. For each separately authorized upload, append `--execute` to `upload-binaries` and type `UPLOAD <version> <run-id>` in an interactive terminal. Installer and blockmap uploads never publish a feed. Matching existing binaries are read back, not overwritten; different bytes stop the operation.
2. Leave the fixed feed absent. Install and start version 1 through its installed shortcut; confirm its displayed version and journal `workspace-ready`. Complete the walkthrough's 404 case before authorizing any feed write. Keep version 1 running.
3. Authorize version 1 `publish-feed` with `--execute` and `PUBLISH <version> <run-id>`. Its binaries must already exist and pass public readback. The initial feed must be absent or contain the exact version 1 bytes. After full feed readback, complete the same-version case in the running version 1 application; retain evidence and obtain separate authorization before publishing version 2.
4. Authorize version 2 publication with the command below and its exact confirmation. Supply the original installed application's `dsh-update-qualification/<run-id>/journals` directory. Startup evidence and the expected previous feed are required. The operator independently verifies the installed path and that version 1 is still running.

```powershell
node --import tsx apps/desktop/scripts/publish-installed-update.ts publish-feed "<run.json>" "<version-2>" "<version-2-verification/result.json>" --journals "<journal-directory>" --execute
```

Continue the walkthrough only after successful publication and public readback. The tool uses fixed public URLs without cache-busting parameters, uploads with `Cache-Control: no-store`, and verifies returned bytes and hashes. Binary uploads retain complete public readback. Feed publication reads only the feed remotely and requires a successful `upload-binaries` result with an exactly matching local plan under this run's `publication-records/operation-*`; missing, failed, or mismatched receipts stop publication. The publication result records the reused receipt path and receipt/plan hashes. This proves prior delivery, not continued availability of immutable objects; do not delete or replace those objects. SDK writes have no automatic retries.

<a id="evidence"></a>

## Evidence and recovery

Each operation retains `publication-records/operation-*`: plan, timestamped stages, final result, and feed body when applicable. Records include safe request IDs and available HTTP status, not raw SDK errors or authorization headers. Failure stops later writes; a timeout does not prove that the server rejected an earlier write. Preserve records and remote objects, inspect the last stage and actual remote state, and obtain separate confirmation before another operation.

Diagnose `403 AccessDenied` by the exact API: `GetBucketVersioning`, `GetObject`, and `PutObject` require distinct permissions. Before requesting broader access or changing CDN settings, compare retained successful runs and check the failing operation with the current credentials. An added configuration query must not be reported as an upload failure when no upload was attempted. Successful reads alone do not prove current write permission; prefer reviewing an unnecessary new preflight over expanding a least-privilege upload identity.

A manually requested later operation verifies matching objects without rewriting them. `alreadyPublished: true` means reconciliation of an existing desired feed, not a new publication; use the original operation's evidence for publication timing. Unexpected feed bytes stop the operation, including attempted replacement of version 2 with version 1. A crash can leave `publication.lock`; confirm no publisher remains and preserve failed records before an operator removes that exact empty directory. Never delete a lock to bypass an active publisher.

Qualification COS version queries have a 30-second total deadline, and object reads and PUTs have a 15-minute total deadline. Expiration aborts the underlying HTTP requests and waits for closure before releasing the operation lock; ongoing transfer activity does not extend the budget.

<a id="dev-note"></a>

## Dev Note

Sequencing tests use an in-memory store; transport tests exercise real SDK serialization with a substituted HTTP handler. Neither certifies COS writes. On 2026-09-14, the current credentials read the retained test probe with HTTP 200 and matching SHA-512, while `GetBucketVersioning` returned 403; no PUT was attempted. A separate 2026-09-11 probe verified test uploads, fixed-feed refresh, and updater download. TODO: review the extra bucket-configuration prerequisite without weakening namespace isolation, integrity checks, or fail-stop behavior; its removal is not implemented by this documentation correction.

The later operator-authorized run `installed-update-r5dYNH` retains `object-overwrite-probe/result.json` and `binary-upload/result.json` under `.desktop-build/qualification/`. Creating a new 49-byte test object succeeds; a second PUT of identical bytes with overwrite forbidden returns `409 FileAlreadyExists`, and origin/public hashes remain unchanged. A fixed-run binary-only driver then uploads both signed installers and their blockmaps with the same header, revalidates package receipts, and verifies all four complete public responses. It records four successful new-object PUTs, no retries, no feed or configuration writes, and keeps the probe. A HEAD observation of the private feed URL returns 404. This operator run uses observed object-level protection instead of querying bucket configuration; the general CLI prerequisite above remains unchanged. These receipts establish test-object delivery, not feed publication, installed startup, or an installed upgrade.
