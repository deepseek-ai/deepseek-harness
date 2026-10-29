---
description: "Publish completed Desktop installers and update feeds to the selected download service. This reference covers deployment identity, upload credentials, fixed downloads and audit records. Build configuration and signing operations have separate owners."
---

# Desktop publication

English | [中文](README.zh.md)

## Summary

Publish completed Desktop installers and update feeds to the selected download service. This reference covers deployment identity, upload credentials, fixed downloads and audit records. Build configuration and signing operations have separate owners.

## Table of Contents

- [Publication prerequisites](#prerequisites)
- [Deployment and test release identity](#upload-updates)
- [Publish installers and update feeds](#publish-feeds)
- [Fixed installer downloads](#fixed-downloads)
- [Upload credentials](#credentials)
- [Upload audit and recovery](#audit-and-recovery)

For retained self-hosted builds, use the [CI publication workflow](ci/README.md), which keeps installers on their original machine and supports resumable publication. The commands below remain the existing manually authorized local uploader: they retain checkout-local audit records and use the operator's Git identity. They do not share the CI publisher's locks, approval or tag-only recovery. Do not run both writers against one channel concurrently. Both use the same upload-plan validation; separate orchestration preserves existing manual commands while adding immutable-attempt recovery for CI. Consolidating or retiring the manual commands is separate work.

<a id="prerequisites"></a>

## Publication prerequisites

Publication requires completed release artifacts and explicit operator authorization. Building an installer or downloading an Actions artifact does not publish it. Read the [release version rules](../packaging/README.md#release-versions) and retain the packaging evidence. Machine presets are for packaging, not upload/COS commands: unset `DSH_PACKAGING_PRESET` and provide the existing target dotenv upload configuration. The configuration and actual COS/CDN acceptance must be verified by the release operator.

<a id="upload-updates"></a>

## Deployment and test release identity

`DSH_DESKTOP_AUTO_UPDATE_ENV` selects `test` or `production` for both the URL embedded during packaging and the later COS upload; an absent value selects `test`. Test packaging requires its HTTPS origin in `DOWNLOAD_TEST_ORIGIN`; production uses `https://download.deepseek.com`. Upload requires the selected bucket in `DOWNLOAD_TEST_COS_BUCKET` or `DOWNLOAD_PROD_COS_BUCKET`. Production feeds use `dsh-desk/feeds/<target>/` and binaries use `dsh-desk/bin/<target>/`. Test releases require `DOWNLOAD_TEST_RELEASE_ID`: 32 lowercase hexadecimal characters inserted as `dsh-desk/<release-id>/feeds/<target>/` and `dsh-desk/<release-id>/bin/<target>/`. YAML references, stable-channel aliases, and blockmaps stay inside that release directory. Targets are `mac-arm64`, `mac-x64`, and `win-x64`.

The update destination and upload credentials follow the selected deployment; production fixed downloads also require the [EdgeOne settings](#fixed-downloads):

| Environment | Public origin | COS bucket | COS credentials |
|---|---|---|---|
| `test` or unset | `DOWNLOAD_TEST_ORIGIN` | `DOWNLOAD_TEST_COS_BUCKET` | `DOWNLOAD_TEST_COS_SECRET_ID`, `DOWNLOAD_TEST_COS_SECRET_KEY` |
| `production` | `https://download.deepseek.com` | `DOWNLOAD_PROD_COS_BUCKET` | `DOWNLOAD_PROD_COS_SECRET_ID`, `DOWNLOAD_PROD_COS_SECRET_KEY` |

Generate a fresh ID for each test release batch with the command below and copy its output into `DOWNLOAD_TEST_RELEASE_ID` in `.env.macos` or `.env.windows`. These Git-ignored platform files own the value; shell variables do not override it, and dotenv values are not shell-expanded. Keep the ID through packaging, upload, and retries; upload rejects a completion record with a different update URL. To test an upgrade between versions, reuse the installed client’s ID for the later version. Production does not use this field.

```sh
node --input-type=module -e "import { randomBytes } from 'node:crypto'; console.log(randomBytes(16).toString('hex'))"
```

Distribute each test batch through its complete download links. Installed test clients retain their batch feed and do not discover a new ID automatically. Format validation cannot establish randomness; use the generator output. Random paths reduce guessing, not access by link holders; withdrawing a batch requires deleting its COS objects and purging its CDN directory.

<a id="publish-feeds"></a>

## Publish installers and update feeds

Configure the update origin and selected COS bucket, SecretId, and SecretKey in the target dotenv file, then package and upload the same target:

```sh
pnpm run package:desktop:mac:arm64
pnpm run upload:mac:arm64
```

The target dotenv file for internal-test packaging explicitly sets `DSH_DESKTOP_AUTO_UPDATE_ENV=test` and `DOWNLOAD_TEST_ORIGIN=https://download-test.deepseek.com`; uploads use `DOWNLOAD_TEST_COS_BUCKET=bj-toc-download-test-1320056602` and separate test credentials. Both test and production use the fixed Nightly channel; deployment selection does not enable channel switching.

Early internal-test packages use the `test` deployment. Select `production` explicitly only for a production release; changing upload credentials does not retarget an existing package. Packaging requires no COS credentials, disables electron-builder publishing, strips COS credentials from child processes, and records completion only after signing and notarization succeed. Upload validates this record, deployment, target, shared version, filenames, sizes, and SHA-512 before reading credentials. Packages and blockmaps upload before YAML; historical objects are retained. Every release publishes `nightly.yml` or `nightly-mac.yml`; stable releases also publish `latest.yml` or `latest-mac.yml` pointing at the same artifacts. Published YAML uses absolute binary URLs. The uploader leaves Cache-Control unset, including the empty header the COS SDK would otherwise add: deployment infrastructure owns cache policy, with uncached feeds and separately configurable binary caching. Serialize publication per target and verify public artifacts and feed contents before release qualification.

Windows NSIS uploads require the generated, nonempty `.exe.blockmap` beside the installer. The blockmap is uploaded before channel YAML; NSIS installer metadata does not require the embedded `blockMapSize` used by the separate web-installer format. File-plan tests use the pinned builder's blockmap generator, not a hand-authored embedded-map field.

<a id="fixed-downloads"></a>

## Fixed installer downloads

Fixed installer downloads use `pnpm run upload:latest:mac:arm64`, `pnpm run upload:latest:mac:x64`, or `pnpm run upload:latest:win:x64` from the repository root. They upload the completed target's DMG or EXE to `desktop/dsh-latest-macos-arm64.dmg`, `desktop/dsh-latest-macos-x64.dmg`, or `desktop/dsh-latest-windows-x64.exe`. Production URLs start with `https://download.deepseek.com/`; test URLs use `DOWNLOAD_TEST_ORIGIN`. Both deployments reuse the target dotenv's deployment, bucket, and credentials, all normal release validation, and the upload audit below. Each command replaces one fixed object without publishing feeds, blockmaps, or release tags. Test fixed downloads are shared across release IDs in the test bucket; the packaged update URL still requires its original release ID. Publication is explicit, including prerelease versions. Production commands then submit one EdgeOne URL purge and report its task ID; they do not query or wait for cache completion. Test uploads retain deployment-managed cache policy. Local loopback tests cover the upload; release operators own real COS and CDN acceptance.

Production fixed downloads require `DOWNLOAD_PROD_EO_ZONE_ID` in the target dotenv and `teo:CreatePurgeTask` permission for that zone on the existing `DOWNLOAD_PROD_COS_SECRET_ID` / `DOWNLOAD_PROD_COS_SECRET_KEY` identity. The release operator must confirm that permission before use; no additional CI Secret is required. Required settings are resolved before uploading. The submission has a 30-second request timeout and is never retried automatically.

The command reports submission acceptance, not completed cache invalidation. EO results go to the console without separate purge record files; the existing upload audit records only COS writes. A rejected or unconfirmed submission exits unsuccessfully; the uploaded installer stays published. Check EO task history before submitting again after a connection loss or missing response. To submit a purge without uploading, use `pnpm run purge:latest <target>` with production settings and credentials; no local installer is needed. DPAPI users reuse the original credential launcher and add `-PurgeOnly` to their `-Upload -Latest` invocation. Serialize uploads and cache-only submissions per target. The CI publisher does not publish fixed downloads or run this refresh.

<a id="credentials"></a>

## Upload credentials

Windows operators can keep a CLIXML object with DPAPI-encrypted `SecretId` and `SecretKey` SecureString fields outside the repository. The [credential launcher](../scripts/upload-with-credentials.ps1) requires an explicit `-CredentialFile` and `-Environment production` or `test`; without `-Upload`, it only verifies decryption and injection into a local Node child, with no network request. It requires Node on `PATH` and the Windows user and machine that encrypted the file. Plaintext, empty, and whitespace-only fields fail. The parent environment is unchanged; the child receives only the selected COS pair after unrelated secrets and Node preload options are removed. Raw child stderr is suppressed and credential values in stdout are redacted. This check does not prove COS authorization. An explicit upload additionally requires `-Upload -Target <target> -Bucket <bucket>` and the normal completed-release prerequisites below; actual cloud upload remains release-operator qualification. Add `-Latest` to that upload invocation to replace the fixed installer without publishing update feeds or a release tag. For a cache-only submission, add `-PurgeOnly` to `-Upload -Latest -Environment production`. Deployment and bucket must still match the dotenv, while package artifacts are not read. This launcher supports permanent keys, not STS credentials. An explicit upload requires the selected deployment and bucket to match the target dotenv and completed package record before network writes; it uses the DPAPI credential pair even if the dotenv contains other COS keys.

<a id="audit-and-recovery"></a>

## Upload audit and recovery

Test and production uploads through `upload:*` retain a fresh `.desktop-build/upload-records/<environment>-<target>-*` directory after release preflight. `plan.json` records destination, version, every file's size/SHA-512, and published YAML bytes; flushed `events.jsonl` records PUT intent and available response status/request ID; `result.json` records completion or the last failed stage. A missing final result means interruption or unavailable storage, not success. No credential values, authorization headers, or raw SDK errors are recorded. Audit-write failures stop later PUTs. Every object is one streamed Tencent COS PUT with an explicit length and Content-MD5; the COS SDK repeats a request only when its body is not a stream, and this uploader does not retry either. Retain partial records and inspect remote state before another operation: a timeout or failed receipt write does not prove that the object was not stored. These records are local, not tamper-proof or automatically backed up; archive each release's records with its build evidence in controlled storage. Public CDN readback remains separate release qualification, explicitly marked `not-performed` in the upload result.

## Dev Note

None.
