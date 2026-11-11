# Agent Note: Reject silent empty catch clauses

Status: implemented

English | [中文](2026-09-21-reject-silent-empty-catch.zh.md)

## Problem

An empty `catch` discards every failure of its `try`, including defects the author did not expect. The root rule requires such a clause to name the error, state why discarding it is safe, and keep its `try` to one statement, so that the clause discards only the failure its author considered. Without a check, new clauses drifted from the rule, and existing clauses broke it across many unrelated package and test owners.

## Decision

The [checker](../../../../scripts/verify-empty-catch.ts), exposed as `pnpm run verify-empty-catch`, parses first-party JavaScript and TypeScript with the TypeScript syntax tree and reports an empty clause, one whose body holds no statement other than `;`, that is unnamed, unexplained, or wraps a multi-statement `try`. A bare `_` counts as unnamed; lint requires an unused binding to start with `_`, so a conforming name such as `_alreadyGone` states the expected failure. A clause body with any other statement is out of scope because syntax cannot show whether it handles the error. The checker establishes the form; review establishes that the name and the reason are true, using the guidance in [dsh-error-handling](../../../skills/dsh-error-handling/SKILL.md#empty-catch-clauses).

Existing clauses have an exact baseline keyed by repository-relative path, a SHA-256 digest of the clause's syntax tokens together with its broken conditions, and occurrence count. Including the broken conditions makes turning a recorded one-statement `try` into a wider one, or deleting a recorded reason, a new finding, while edits inside the `try` that keep its conditions keep the clause's identity. The baseline follows the [unknown-cast inventory](2026-09-19-no-unknown-casts.md), and both checkers share [the inventory module](../../../../scripts/baseline-inventory.ts): baseline edits only delete entries or decrease counts, `--prune` removes retired entries and refuses to write while new findings exist, and no command adds an allowance. Unlike the unknown-cast inventory, which requires resolving an assertion before moving it to an unlisted file, moving a file that holds recorded clauses renames its baseline key in the same change, because narrowing a recorded `try` belongs to its owner rather than to the change that moves the file.

The checker runs in the `hygiene` and `check-all` profiles and the CI static and primary modes of [the gate runner](../../../../scripts/run-gates.ts). Empty Promise rejection handlers such as `.catch(() => {})` are outside this rule and tracked separately in issue #8033.

## Alternatives considered

**Fix every existing clause before enforcing the rule.** Rejected because narrowing a multi-statement `try` changes which failures the clause discards, which only each owner can judge. The baseline lets enforcement start while the existing clauses remain recorded findings for their owners to fix.

**Fingerprint the whole `try` statement.** Rejected because every edit inside a recorded `try` would become a new finding and force its owner to fix the clause during unrelated work. Fingerprinting the clause with its broken conditions rejects a new broken condition on a recorded clause without tying its identity to the statements inside the `try`; a `try` that is already wide can gain statements without a new finding.

**A command that records clauses from a named revision.** Rejected because a local command cannot prove that the revision is the target branch: naming the current branch would record the branch's own clauses. Once the target branch carries the checker, merging it brings that branch's baseline along, so no command is needed.

**Search text for `catch {}`.** Rejected because comments, strings, whitespace, and binding patterns defeat a text pattern, and the rule's conditions depend on the syntax tree.

## Consequences

New and changed empty clauses must conform, and fixing a recorded clause requires pruning its baseline entry. A partial fix, such as adding a name while the `try` stays wide, changes the clause's identity and therefore fails; the owner fixes the clause completely before pruning. The baseline key carries no line number, so a recorded clause can move within its file; identical clauses in one file share one fingerprint whose count covers each of them.

Passing the checker establishes the form of every unrecorded empty clause. It does not establish that a reason is true, that a non-empty handler handles its error, or that a `try` holding one block or compound statement discards only one operation's failures.
