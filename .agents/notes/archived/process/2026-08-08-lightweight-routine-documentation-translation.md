# Agent Note: Lightweight routine documentation translation

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-08-lightweight-routine-documentation-translation.zh.md)

## Problem

Routine bilingual edits automatically selected the full [translation skill](../../../skills/dsh-translate-docs/SKILL.md). Even after the [briefed-update optimization](2026-07-26-briefed-minimal-translation-updates.md), a small documentation change could still load a specialized workflow, generate a briefing, delegate prose to a subagent, and perform a separate verification pass. That orchestration consumed more time, context, and model tokens than translating the changed text itself, and automatic skill discovery exposed the workflow on ordinary documentation turns.

## Decision

- **Routine translation is one shot and one pass.** The active agent loads [terminology.md](../../../../docs/i18n/terminology.md), translates only the changed content directly, moves a terminology annotation when the true first occurrence crosses the edit boundary, otherwise preserves reviewed counterpart prose outside the change, and re-records the pair. It does not invoke a translation skill, generate a briefing, start a separate translation-review pass, or delegate translation to a subagent.
- **The extended workflow is manual-only.** [dsh-translate-docs](../../../skills/dsh-translate-docs/SKILL.md) retains its briefing, delegated prose, whole-document, and scoped-verification paths. The [Claude Code skill contract](https://code.claude.com/docs/en/skills#control-who-invokes-a-skill) reads `disable-model-invocation: true` with `user-invocable: true` in `SKILL.md`; Codex reads `policy.allow_implicit_invocation: false` in `agents/openai.yaml`. The repository's `.claude/skills` symlink projects the same skill directory to Claude Code, so both products share one committed workflow while enforcing their own invocation metadata. The `doc-sync` skill-invocation-metadata gate keeps those independent policies aligned.
- **Automatic workflows do not chain into the manual skill.** Root and documentation instructions own the lightweight default. Documentation, website-sync, prose, and code-review skills link to those instructions or the i18n contracts instead of loading `dsh-translate-docs` from an inferred bilingual change.
- **The pairing and review contracts stay intact.** Both language files still update together, untouched counterpart wording remains stable, terminology stays binding, the consistency record is rewritten only after the active agent confirms the pair, and `doc-sync` retains the corpus-wide mechanical checks. Human review still owns semantic translation quality.

## Alternatives considered

- **Delete the extended skill and briefing tools** — rejected: explicit manual use remains valuable for whole-document translations, difficult reconciliation, and callers that deliberately choose the guarded workflow.
- **Replace the extended skill with an automatically invoked lightweight skill** — rejected: another automatic skill would still add discovery context and an invocation boundary around a task the active agent can complete directly from the terminology table and standing instructions.
- **Keep automatic invocation only for new pairs or large changes** — rejected: size-based inference is another hidden policy and can unexpectedly activate the expensive workflow. The user, not the agent, chooses when the extended path is worth its cost.
- **Drop the terminology load as well** — rejected: the glossary is the small, binding input that prevents repository-wide term drift; removing it would trade token savings for inconsistent product language.

## Consequences

- Ordinary development pays for the changed source text, its local counterpart context, and the terminology table rather than the extended workflow's briefing and subagent context.
- The active agent owns the final routine translation in the same turn. The lightweight path deliberately gives up the extended workflow's generated alignment, delegated isolation, and separate prose-verification pass.
- Explicit users can still invoke the full workflow through `/dsh-translate-docs` in Claude Code or `$dsh-translate-docs` in Codex.
- The Claude Code frontmatter and Codex policy file are separate product contracts; `doc-sync` rejects a skill that becomes manual-only on only one product or becomes unavailable to the Claude Code user as well as the model.
