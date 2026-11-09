---
kind: upgrade-guide
description: "ChangeRequestSnapshot gains required overview fields and ChangeRequestCheck gains the required rerun field."
---

# Forge snapshots carry the change request overview

English | [中文](guide.zh.md)

## Change

`ChangeRequestSnapshot` gains seven required fields: `reviewers` and `reviewersTruncated`, `closingIssues` and `closingIssuesTruncated`, `branchUpdates`, `canRequestReviews`, and `canRerunChecks`. `ChangeRequestCheck` gains the required `rerun: ForgeCheckId | null`, which names how the provider reruns the check. The change request card reads these fields to list reviewers, linked issues, and the branch update, and to offer rerunning failed checks, requesting reviews, and updating the branch.

`ForgeProvider` also gains optional `viewedFiles` with `setViewed`, `rerunChecks`, `requestReviews` with `reviewerCandidates`, and `updateBranch`; a provider without them keeps working, and the card then offers none of those actions.

This affects third-party `ForgeProvider` implementations registered with `ctx.forge.register` and other code that builds `ChangeRequestSnapshot` or `ChangeRequestCheck` values. All types come from `@deepseek-ai/dsh-experimental-forge`.

## Migration

1. In every `ChangeRequestCheck` a provider builds, set `rerun: null` unless the provider implements `rerunChecks`; a provider that does names each rerunnable check with a branded `ForgeCheckId` it can resolve again, as [`actionsRun`](../../../../packages/experimental/forge-github/src/graphql.ts) does for GitHub Actions runs.
2. In every `ChangeRequestSnapshot`, set the overview fields the host reports. Without host data, use `reviewers: []`, `reviewersTruncated: false`, `closingIssues: []`, `closingIssuesTruncated: false`, `branchUpdates: []`, `canRequestReviews: false`, and `canRerunChecks: false`; the card then shows the review decision alone and offers no overview action.
3. Optionally implement the new provider methods; [`GitHubProvider`](../../../../packages/experimental/forge-github/src/provider.ts) shows each one, and the [forge subsystem page](../../../subsystems/forge.md#overview-and-viewed-marks) states their contract.
4. Run your type check; it succeeds when every snapshot and check a provider builds sets the new fields.
