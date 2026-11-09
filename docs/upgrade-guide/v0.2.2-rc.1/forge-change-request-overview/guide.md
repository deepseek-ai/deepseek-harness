---
kind: upgrade-guide
description: "ChangeRequestSnapshot gains required overview fields, ChangeRequestCheck gains the required rerun field, and ForgeActionFailure gains the unknown code."
---

# Forge snapshots carry the change request overview, and actions report unknown outcomes

English | [中文](guide.zh.md)

## Change

`ChangeRequestSnapshot` gains seven required fields: `reviewers` and `reviewersTruncated`, `closingIssues` and `closingIssuesTruncated`, `branchUpdates`, `canRequestReviews`, and `canRerunChecks`. `ChangeRequestCheck` gains the required `rerun: ForgeCheckId | null`, which names how the provider reruns the check. The change request card reads these fields to list reviewers, linked issues, and the branch update, and to offer rerunning failed checks, requesting reviews, and updating the branch.

`ForgeActionFailure['code']` gains `unknown`: the host's answer did not confirm the outcome, so the change may have been applied. The GitHub provider returns it for viewed marks, review requests, and branch updates GitHub did not confirm; `ctx.forge.markReady` and `ctx.forge.merge` return it only from a provider that does.

`ForgeProvider` also gains optional `viewedFiles` with `setViewed`, `rerunChecks`, `requestReviews` with `reviewerCandidates`, and `updateBranch`; a provider without them keeps working, and the card then offers none of those actions.

This affects third-party `ForgeProvider` implementations registered with `ctx.forge.register` and other code that builds `ChangeRequestSnapshot` or `ChangeRequestCheck` values. All types come from `@deepseek-ai/dsh-experimental-forge`.

## Migration

1. In every `ChangeRequestCheck` a provider builds, set `rerun: null` unless the provider implements `rerunChecks`; a provider that does names each rerunnable check with a branded `ForgeCheckId` it can resolve again, as [`actionsRun`](../../../../packages/experimental/forge-github/src/graphql.ts) does for GitHub Actions runs.
2. In every `ChangeRequestSnapshot`, set the overview fields the host reports. Without host data, use `reviewers: []`, `reviewersTruncated: false`, `closingIssues: []`, `closingIssuesTruncated: false`, `branchUpdates: []`, `canRequestReviews: false`, and `canRerunChecks: false`; the card then shows the review decision alone and offers no overview action.
3. Optionally implement the new provider methods; [`GitHubProvider`](../../../../packages/experimental/forge-github/src/provider.ts) shows each one, and the [forge subsystem page](../../../subsystems/forge.md#overview-and-viewed-marks) states their contract.
4. Handle `unknown` wherever code switches exhaustively over `ForgeActionFailure['code']`: show that the outcome must be checked on the host, and do not try the change again before it is.
5. Run your type check; it succeeds when every snapshot and check a provider builds sets the new fields and no `ForgeActionFailure` code is unhandled.
