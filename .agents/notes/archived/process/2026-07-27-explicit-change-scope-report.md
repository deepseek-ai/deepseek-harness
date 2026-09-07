# Agent Note: Report an explicit repository change scope

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-27-explicit-change-scope-report.zh.md)

## Problem

The [pre-push workflow](../../../skills/dsh-pre-push-checks/SKILL.md) needs the diff against the actual base, but constructing `origin/<current-branch>` fails for a new worktree branch that tracks `origin/master` before its first push and misstates a stacked branch whose PR targets another feature branch. The [code-review](../../../skills/dsh-code-review/SKILL.md) and [documentation-audit](../../../skills/dsh-doc/SKILL.md) workflows need the same current-base judgment.

An incorrect range undermines evidence selection because it can omit affected paths. A three-dot committed diff also says nothing about Git's separate staged, unstaged, and untracked layers.

## Decision

The root `change-scope` command requires `--base <ref>`, accepts `--head <ref>` with `HEAD` as the default, and writes one versioned JSON report. It resolves both inputs to commits with ambiguity detection and requires one merge base before rendering. The report records the repository root without normalizing legal path whitespace, input refs, resolved base, head, and merge-base commit IDs, plus sorted committed, staged, unstaged, and untracked path sets. Path records are split at raw NUL bytes; the repository root and every path are decoded as strict UTF-8. An invalid value aborts the report instead of substituting characters or collapsing distinct values.

Committed paths compare the resolved merge base with the resolved head. Dirty path sets always describe the current worktree and index, even when `--head` names another commit. Every Git probe disables configured filesystem monitors and optional lock-taking; diff configuration cannot hide submodules or invoke external diff or text-conversion drivers, and rename detection is disabled so both sides of a rename remain visible.

The command never guesses or fetches a base, queries a hosting provider, or selects tests. Each calling workflow verifies current remote or stack state, supplies the base explicitly, and uses the factual report as input to semantic review or evidence selection.

Focused temporary-repository tests cover explicit and stacked refs, every dirty layer, legal path whitespace, strict path decoding, inert probes, invalid refs, the deterministic schema, and unchanged refs, index, config, and status after reporting.

## Alternatives considered

**Keep an ad hoc diff command plus a prose fallback.** This avoids a repository script but leaves normal new-worktree and stacked-base topologies inconsistent across workflows, and it omits dirty layers.

**Infer the base from the configured upstream.** An upstream may be `origin/master` before the first push, the same feature branch after a push, or a head branch whose PR targets another feature branch. No inference is correct for every topology.

**Query GitHub for the base inside the command.** This couples a local read-only report to one forge and to network credentials, yet still cannot resolve a branch with no PR.

**Generate required tests from changed paths.** Paths cannot establish behavior reached through configuration, dynamic loading, subprocesses, workers, built artifacts, or providers. Evidence selection remains judgment under the pre-push workflow.

**Report current branch and upstream and maintain a parallel human renderer.** Callers already verify branch and base state before invocation, no consumer uses those fields, and formatted prose duplicates the JSON schema without improving path completeness.

## Consequences

The explicit input makes an incorrect base possible but visible: both input refs and all three resolved commit IDs appear in the report. Callers pay the small cost of verifying and fetching the live base before running the command.

The string schema deliberately cannot represent non-UTF-8 path bytes. A repository containing them must rename those paths before it can produce a report, preserving exact scope instead of returning a lossy one.

The repository owns one Git-topology helper and focused tests. In return, pre-push selection, code review, and documentation audit share a deterministic, read-only account of committed and local changes without importing forge or policy concerns.
