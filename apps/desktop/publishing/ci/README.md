---
description: "Operate retained Desktop package publication from dedicated macOS and Windows runners."
---

# Desktop CI publication

English | [中文](README.zh.md)

## Summary

Publish a completed package from its original machine without downloading its installer again. Both test and production publish binaries followed by update YAML. Both deployments require GitHub Environment approval; only production creates a GitHub App tag. Real COS, CDN and administrator-permission acceptance remain deployment checks; local fixtures do not establish those permissions.

## Table of Contents

- [Machine setup](#machine-setup)
- [Package and publish](#package-and-publish)
- [Recovery and records](#recovery-and-records)
- [Restore a channel](#restore-a-channel)

<a id="machine-setup"></a>

## Machine setup

Keep `DSH_PACKAGING_CONFIG_DIR` pointed at the existing machine packaging directory. Completed attempts are copied to its sibling `releases/<run-id>/<attempt>/`; `DSH_DESKTOP_RELEASES_DIR` overrides that root with an absolute path. The inventory includes installers, update archives, blockmaps, completion metadata and a credential-free manifest. Debug packages are retained but cannot publish. Copies are checked before the attempt directory becomes visible, and an existing attempt cannot be replaced. GitHub retains the same file inventory for 14 days. Local files remain until an operator removes them; do not delete an attempt while it is being verified or published.

Create `publishing/test.json` and, when authorized, `publishing/production.json` below the configuration directory. Each declares `bucket`, HTTPS `origin` without a path, and an absolute `credentialsFile`. The credential file contains only `secretId` and `secretKey`. macOS also requires `macOS.signingIdentity` and `macOS.teamId`; Windows requires `windows.certificateThumbprint`. Production requires the exact origin `https://download.deepseek.com` and `githubApp.clientId` plus an absolute `githubApp.privateKeyFile`. These files stay outside Git. The uploader supports permanent COS credentials, not STS session credentials. Administrators must keep test and production buckets unversioned (neither enabled nor suspended). Publication assumes this deployment prerequisite and does not call `GetBucketVersioning` or require its permission. Immutable binary PUTs retain `x-cos-forbid-overwrite`; their protection depends on administrators maintaining the bucket configuration.

Set the repository variable `DESKTOP_PUBLISH_RUNNERS` to a JSON mapping of registered runner names to unique labels and targets, for example `{"mini":{"label":"dsh-mini-publish","target":"mac-arm64"}}`. Assign that label to exactly that runner. Windows uses target `win-x64`. The routing job checks the original successful job, and the publisher checks its own runner name against the recorded name. Machines need no shared filesystem or LAN connection to each other.

An administrator must create `desktop-test` and `desktop-production`, each with required reviewers and an allowed `master` deployment branch. The workflow checks reviewers for either deployment. Test can allow self-approval. The GitHub App needs installation access to this repository and Contents write permission, plus permission under the `desktop-v*` tag ruleset to create release tags. Reviewer approval does not transfer the reviewer's tag permissions to the App. Missing configuration stops publication; there is no personal-token fallback. The App action creates and later revokes a short-lived token. Protect the local private key and COS credential files with the publishing account's filesystem permissions. The token action accepts key contents, so the masked PEM also passes through the runner's temporary `GITHUB_OUTPUT` file during the job; masking hides logs, not local file access.

Environment approval gates this workflow, not arbitrary code running under the same machine account. Account isolation and forced source-branch restrictions are separate operational work. Keep existing release Environments unchanged. The test job uses its own reviewers and never creates a real release tag; local simulated transports exercise tag creation and recovery without verifying App permissions.

<a id="package-and-publish"></a>

## Package and publish

For publication to either test or production, choose Windows `signing=signed` or leave macOS **Skip notarization** unchecked. Unsigned and unnotarized packages are only for internal debugging; they cannot publish or provide automatic updates. Before installing dependencies, the hosted routing job rejects debugging artifacts identified by the selected run and attempt. Missing artifact metadata does not establish eligibility: the original machine still validates its retained manifest and signatures. A debugging-package rejection requires a new signed/notarized package and its run ID / attempt; retrying publication cannot qualify the existing bytes.

Select the platform's `Package Desktop` workflow, preset, source, channel and version mode. `source_ref` accepts repository branch names (for example `feature/desktop-update`) or `dsh-v*` tags for test; production accepts only `master` or `dsh-v*` tags. Names matching `dsh-v` followed by a digit and letters, digits, dots or hyphens are treated as tags, even if a branch has that name. Tags must match the selected product version. We recommend dispatching the packaging workflow from `master` and enter the source separately; raw commit SHAs, PR refs and fork repositories are not supported. The selected source must contain the CI adapters, so older sources fail before dependency installation. Only select trusted branches: their build code runs on the signing machine. This is an operating convention, not enforced workflow-origin or credential isolation. Publication uses the recorded commit and requires it to remain in the selected branch history; normal branch advances are allowed, deletion or a diverging force-push rejects. Tag publication requires the tag to still resolve to the recorded commit. Dispatch the publisher from `master`; its hosted routing job rejects other refs before scheduling the original machine. The packaged source commit is recorded separately. `version_mode=default` selects product for production and auto for test; product preserves the selected checkout version, auto appends date/run/attempt, and manual requires `build_version`. A latest package requires a stable version, so test/latest needs product or a stable manual version. The optional `test_release_id` is the test URL prefix: blank retains the machine default, successive upgrade tests on that platform need the same value, and defaults should be rotated periodically. It is not a GitHub run ID. See [packaging configuration](../../packaging/README.md#configuration-and-local-builds) for its validation and rotation limits.

Packaging only retains files. After success, open **Publish Desktop · COS → Run workflow** on `master`, enter `package_run_id` from the packaging run URL, and optionally enter `package_run_attempt`. Blank selects the latest attempt, which must have succeeded; it never falls back to an older success. An explicit attempt selects that exact successful build. Windows must be signed; macOS must finish notarization and stapling. GitHub job evidence selects the original runner; its local manifest supplies the preset, version, source and channel before approval. No installer or request artifact is downloaded. Retained packages with the old `publishRequested=false` flag remain eligible; missing or changed local files stop publication.

Before uploading, the publisher hashes all retained files, checks version and destination metadata, and rechecks the platform signatures. macOS verifies the DMG and extracts the ZIP to verify the app's ticket; Windows checks Authenticode, the configured signer thumbprint and the timestamp. Preparation writes a Chinese approval summary with separate version, channel, platform and deployment fields, the retained test release ID, full installer/feed URLs, a link to the original packaging attempt, source ref/SHA, platform verification results and proposed tag. Folded details include the COS bucket and file sizes/SHA-256 of the upload bytes, including rewritten YAML. Public-repository summaries expose the test prefix and download URLs; the prefix is not authentication. Both publishing jobs wait for **Review deployments → Approve and deploy**, then recheck the approved manifest and upload plan digest. Changed bytes or destinations reject. Approval cannot edit a version; reject and rebuild instead. Both deployments upload missing binaries, verify remote bytes, then update YAML. There is no files-only mode in this workflow. Production finally creates `desktop-v<version>` at the recorded packaging commit; an existing tag must name the same commit.

<a id="recovery-and-records"></a>

## Recovery and records

After resolving a failure, re-run the failed publishing job to keep its prepared package attempt, or start a new publication with the explicit original package run and attempt. Re-running all jobs with a blank attempt resolves the latest package attempt again and requires a new approval. Do not rebuild solely to retry an upload. Missing objects are uploaded, identical objects are skipped, and conflicting same-name bytes stop the operation. Unknown write outcomes are reconciled by reading remote bytes. A newer channel version prevents a stale upload from replacing it. Each package updates only its embedded channel: nightly writes `nightly.yml` / `nightly-mac.yml`, latest writes `latest.yml` / `latest-mac.yml`. Latest binaries use a `latest/` subdirectory under the target binary prefix, separate from existing nightly objects. Publishing the same source/version to both channels requires two packages; an existing release tag is reused only for the same source commit.

The sibling `upload-records/` directory retains an operation identity, newline-delimited events and terminal result. Feed-write intents retain both previous and requested YAML. Failures record their stage, safe error classification and diagnostic; COS failures also identify `GetObject` or `PutObject`, plus a validated HTTP status and request ID when available. Access-denied reports name the permission to inspect. Raw provider responses and credentials are excluded. Audit initialization becomes visible only after its files are complete; abandoned `.initializing-*` directories are not scanned for completed publication. Writes and readback are recorded before proceeding; missing terminal results mean interruption, not success. Actions also keeps its operation record as a diagnostic artifact for 30 days. These local records are not tamper-proof. COS readback verifies storage bytes, not public CDN behavior; public download acceptance is separate.

If the feed completed but tagging failed, the result is `published-tag-pending` and the job fails visibly. On retry, durable feed-completion evidence permits only tag recovery, even if a later release has advanced the channel. It never re-publishes old YAML. An existing conflicting tag requires administrator investigation and is never moved automatically.

Normal publication and manual restoration acquire the same local channel lock. A crash can leave a lock directory under the sibling `publish-locks/`; verify no writer is running before manually removing it. A runner label alone does not coordinate writers on other machines. Keep one publishing machine per channel and preserve its records when migrating.

<a id="restore-a-channel"></a>

## Restore a channel

Run the repository script `apps/desktop/scripts/rollback-desktop-channel.ts` through `node --import tsx` on the publishing machine. Keep `GITHUB_REPOSITORY`, `RUNNER_NAME`, `DSH_PACKAGING_CONFIG_DIR` and `DESKTOP_PUBLISH_ROUTE` set to the original package context. The route JSON contains `runId`, `attempt`, `commit`, `runnerName`, `target`, `preset`, `sourceRef` and `channel`, available in the retained manifest's source fields. Pass `--record` with that successful publication's audit directory, `--expected-version` with the version currently online, and `--reason` with the operational reason.

Without `--execute`, the script reads remote objects and prints the exact YAML change without writing. Preview requires COS read credentials. With `--execute`, it verifies historical files, preserves before/after YAML in a new audit record, checks the current channel again, and restores only YAML. It neither uploads binaries nor changes tags. A channel already matching the target bytes is skipped; other channels must match the expected current version. This permits recovery after one feed was restored before an interruption. A different current version aborts the operation. Restoration is not a multi-object transaction; inspect the audit after any partial failure before continuing.

The Desktop client disables automatic downgrade. Restoring an old feed can stop additional clients receiving a bad release; clients already on a newer version do not downgrade. A higher-version corrective release is a separate recovery path.

## Dev Note

None.
