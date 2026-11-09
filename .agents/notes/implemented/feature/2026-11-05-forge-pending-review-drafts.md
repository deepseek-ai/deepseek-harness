# Agent Note: Pull request comment drafts in the code host's pending review

Status: implemented

English | [中文](2026-11-05-forge-pending-review-drafts.zh.md)

## Problem

The [forge panel](2026-10-09-forge-panel.md) kept a pull request's comment drafts in a browser tab occurrence, published them as one review, and recorded what it published. Once the changes view shows the code host's review threads and lets the user reply to them, browser drafts leave four gaps. A reply cannot join a later review, because the drafts and the threads live in different places. A review the user started on the GitHub page, or in another browser, does not appear, and GitHub refuses a review submitted while the user has one. Drafts are lost with the tab and invisible on another device. And GitHub keeps one pending review per user and pull request, so two stores of one review would disagree.

## Decision

A pull request comment that the user keeps for a later review goes to the user's pending review on the code host through the provider's optional `writeReview`. The first such comment or reply starts the pending review at the head the user saw; later ones join it. The changes view reads the pending review with the threads, shows its comments as threads tagged Pending, and Submit review submits or discards that review with the summary and decision. Replies, resolving and unresolving, and editing and deleting the user's own comments use the same write, which re-checks the head and is never retried.

The browser keeps what the code host does not hold: the review summary and decision until submission, the records of Agent references and published comments, and the outgoing direct write whose outcome needs confirmation. Comments on local changes never had a host destination; they go to the main input as before. Comment drafts an earlier panel kept in the browser stay readable: they show beside their code as browser drafts, can move into the pending review, and keep Submit review disabled while a pending review exists; without one, Submit review publishes them as one review as before.

GitHub measurements on a private test repository decided three rules. While the user has a pending review, GitHub refuses a directly created review and a single comment (HTTP 422, "can only have one pending review per pull request"), so the view offers neither; a reply sent without the review's id still joins the review, so the view offers no reply at once and the provider refuses one. GitHub refuses Approve and Request changes on the user's own pull request, so the dialog offers only Comment there.

## Alternatives considered

**Keeping drafts in the browser tab.** It needs no host write until submission, but replies cannot join the same review, a review started elsewhere blocks submission without explanation, and the drafts do not follow the user to another device.

**Keeping both stores.** Mirroring browser drafts into the pending review or the reverse gives one review two owners whose contents can diverge, and every edit would need reconciliation of two writes.

**Recording drafts in the Session log.** The log records what reaches the model; review drafts are host state the model never sees, and other Sessions on the same pull request would not see them.

**Retrying a write after an unknown outcome.** A lost response does not show whether GitHub applied the mutation. A submission of the pending review is kept as the write to reconcile, as a direct submission is, and blocks another submission until the user checks GitHub; a reply, resolution, or comment change reads the threads again and asks the user to check them before trying again.

## Consequences

A comment kept for later is visible on the GitHub page to its author before submission, and is lost only when the user discards the review. Each comment, reply, or thread change costs one GraphQL query for the head check and one mutation. Resolving a thread does not change the pull request's update time, so every write from the panel drops the panel's kept threads; another view of the same pull request shows the change at its next status or after `reviewRefreshMs`. A provider without `writeReview` reports no write permissions, so its threads stay read-only and its pull request comments are published at once or added to the input. Comment drafts from an earlier panel remain until the user moves, publishes, or deletes them, or closes their tab.
