# Agent Note: Workspace version coherence is a static gate

Status: implemented
Archived: 2026-09-04

English | [中文](2026-09-03-workspace-version-coherence-gate.zh.md)

## Problem

The dsh release sequence shares one version across its publishable members (`packages/` non-experimental members and `apps/*`), every private dsh package, and the workspace root; `release:dsh` writes that version, and the release lane's `verifyVersions` fails when the publishable members diverge. The always-run static lane enforced the same rule only for `packages/*`: a manifest named `@deepseek-ai/dsh-*` under `apps/`, or the root-named CLI manifest `@deepseek-ai/dsh`, carried the shared version with no static check of its own, and only the release lane's pack job (`release:verify`, `verify-npm-install-layout`) noticed a drift there.

That coverage hole is how a mismatched version entered master on 2026-09-03. `packages/util/http-proxy` was added while the family carried `0.1.2-alpha.5`, and merged after the family had bumped to `0.1.2-rc.1`, with `0.1.2-alpha.5` still in its manifest. `constraints` failed on the merged state, and the release lane's Dependency layout and Pack npm tarballs jobs failed with it, reddening every pull request based on the broken master. The introducing pull request's last CI run predated the bump (2026-09-02 13:40, green; the bump merged 2026-09-03 03:21, the pull request merged 09:19 later), so every gate that would have caught the version ran green on a stale snapshot. No in-repo gate re-runs a pull request's checks when its base moves, and master had no branch protection requiring an up-to-date base.

## Decision

`check-workspace-constraints` owns the version rule for the whole family. Its `checkDshFamilyVersion` names the boundary: any scanned workspace manifest named `@deepseek-ai/dsh` or `@deepseek-ai/dsh-*` must carry the workspace root's version. The test is name-based, so it covers `packages/` (publishable and private/experimental members), `apps/`, and the root manifest itself, and it leaves the vendored framework and the Landlock sequence on their own version lines. The previous `packages/`-scoped comparison was the only static home of the rule; the shape checks next to it (cordis peer/dev pairing, `type`, `main`/`types`/`exports`, payload `files`) stay scoped to `packages/`.

The boundary equals what `release:dsh` writes: the root, the publishable members, and every private dsh package under `packages/*/*`. A divergence therefore fails the zero-build static lane — `constraints` in `ci-static`, `ci-primary`, and `hygiene`, which run on every pull request and master push — instead of only surfacing in the release lane.

## Alternatives considered

**Importing the release family object for the member set.** The family object's `members()` discovers only publishable members, which is the release lane's boundary; the invariant also covers private packages, so the static gate would need the bump script's private discovery as a second rule. A name predicate states the whole boundary once and imports none of the release machinery.

**Enforcing the rule only in the release lane.** That lane already fails on member drift and caught the apps/ gap, but it is a separate workflow whose runs have the same snapshot exposure as any other pull-request check; the shared static lane is one cheap check that puts the failure on the standard PR panel and protects the release lane itself.

**Replacing the gate with the branch-protection setting.** Requiring an up-to-date base before merge (or a merge queue) is the protection that stops a stale-base merge from landing its green snapshot, and no repository-level gate sees a base move. It is a repository setting, not a change expressible in this repository; this gate closes the coverage half, and the setting remains the complementary protection.

## Consequences

Every current dsh-named manifest carries the root version — 252 manifests at `0.1.2-rc.1` plus the root itself as of 2026-09-03 — so the strengthened gate passes the present tree. A manifest that drifts anywhere in the family now fails static CI with an error naming the manifest, the root version, and the manifest's own version. The gate cannot prevent a stale-base merge: it observes only the snapshot its run was triggered against, so landing a merged state still requires the merged state to be checked, which is the branch-protection setting's role. The [release-sequence note](2026-08-10-npm-release-sequences.md) keeps the version scheme decision; this note records where the rule is enforced and the hole that enforcement previously left.
