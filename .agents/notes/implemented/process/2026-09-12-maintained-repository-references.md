# Agent Note: Maintained repository references

Status: implemented

English | [中文](2026-09-12-maintained-repository-references.zh.md)

## Problem

Historical evidence needs recognizable release, PR, and measured-run identities. Maintained files also serve the public source home, while native publishing uses the repository identity supplied by its workflow. Concrete commit references and deployment-specific organization URLs do not express that distinction.

## Decision

Use release tags and PR, run, or job identifiers for historical evidence, and relative links for current repository files. The [reference gate](../../../../scripts/verify-repository-references.ts) scans tracked files and nonignored new files. Vendor sources and frozen Agent Notes retain their existing exclusions; active notes and historical release records remain checked.

The gate resolves hexadecimal candidates against the local Git object database and rejects only unambiguous commit identities. Pairing hashes that identify blobs, schema digests, unrelated hexadecimal values, and hexadecimal branch names that resolve to different object identities remain valid. Organization URL detection shares decoding and normalization with the existing repository-link policy.

Native source manifests identify the public source home. During workflow packing, the [native packer](../../../../native/system/scripts/pack-release.mjs) projects the workflow repository into disposable inputs so npm trusted publishing can verify the artifact identity. It preserves source manifests and publishes the resulting tarballs unchanged. Local packing without workflow context retains the public source metadata.

## Alternatives considered

**Reject every hexadecimal string.** Persistence schemas and bilingual pairing legitimately use hashes. Git object-type verification separates commit references from these values.

**Check only new diff lines.** The policy applies to every maintained file, including existing references. A complete scan also catches staged and untracked additions before publication.

**Delete required publishing metadata.** Native publishing still needs the workflow repository identity. Projecting that identity during packing removes the source literal without changing the identity npm verifies.

## Consequences

The gate disables network fetching, including Git partial-clone lazy fetching. It checks all locally available commit objects, including unreachable historical PR heads; absent objects cannot match. A checkout with extra PR objects can therefore detect references absent from CI’s full-history clone. Reference validation establishes the maintained-file policy, not remote tag immutability or historical compatibility. Published native tarballs expose the workflow repository in npm’s Repository metadata; source manifests retain the public source home.

Vendored notices link checked-in source locations while retaining upstream names, licenses, and the unchanged vendor manifest.
