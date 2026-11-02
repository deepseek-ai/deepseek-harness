# Agent Note: Locked Python runtime deployment

Status: implemented

English | [中文](2026-11-01-locked-python-runtime-deploy.zh.md)

## Problem

Python executable packaging needs the same dependency versions and integrity records as the workspace lockfile. Legacy hoisted deployment ignores that lockfile and resolves compatible registry versions again: a manifest permitting `tslib@^2.8.1` can install `2.9.1` while the lockfile records `2.8.1`. Office archive preparation then rejects the missing locked integrity. A successful frozen workspace install does not constrain that later legacy deployment.

## Decision

The Python builder uses pnpm's default deployment, which derives a dedicated production lockfile from the workspace lockfile and installs it frozen. This replaces only the deployment strategy in the [single-executable distribution decision](../architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.md); its runtime architecture and carrier layout remain active.

Deployment retains the source lockfile's peer settings, including `autoInstallPeers: true`. Frozen installation preserves already resolved versions and peer relationships instead of resolving new registry peers. Forcing `autoInstallPeers: false` conflicts with the derived lockfile settings and fails frozen installation. The resulting tree need not equal the legacy tree resolved with peers disabled; selected dependencies must come from the locked graph. `verify-runtime-closure.ts` independently requires explicit workspace peers and preset plugins before deployment, and `verifyStagedDependencies` rejects missing direct dependency directories after materialization and deduplication.

[`scripts/python-runtime-deploy.pnpmfile.mjs`](../../../../scripts/python-runtime-deploy.pnpmfile.mjs) translates reviewed local `file:` approvals to the exact absolute file URLs used in the derived lockfile. Approval, denial, pending decisions, and strict build validation remain unchanged. Default deployment executes approved installation scripts; their generated files can enter the staged payload. Workspace policy and the source lockfile remain unchanged.

## Alternatives considered

**Keep legacy deployment and add missing integrity records.** This would accept versions the source lockfile did not select and repeat the failure after another compatible release.

**Disable automatic peer installation during default deployment.** This conflicts with the source lockfile settings. Re-resolving a separate graph would give up the source lockfile's authority.

**Disable deployment scripts or approve local packages by name.** Skipping scripts omits required postinstall preparation. Name-only approvals do not authorize non-semver local file dependencies; exact identity translation preserves the existing review decisions.

## Testing

A real pnpm comparison with the same manifest and lockfile installs `tslib@2.9.1` through legacy deployment and retains `2.8.1` through default deployment. The Linux executable and locally built installed-wheel SDK smokes pass. Focused tests reject missing dependency directories and deployment flag regressions, preserve approval states, and exercise both metadata path bases. Cross-platform packaging and installed-wheel validation remain owned by CI.

## Consequences

Runtime versions remain traceable to the workspace lockfile, and incomplete direct dependency trees fail before executable packaging. Installation script outputs and locked peer selections can differ from legacy deployment, so byte-identical payloads are not promised. SSH helper deployment has a separate closure manifest and native payload validation; its legacy deployment is outside this Python runtime repair.
