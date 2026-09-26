# Agent Note: Creator skills disclose progressively and may read sources

Status: implemented

English | [中文](2026-09-21-creator-skills-progressive-disclosure.zh.md)

## Problem

The shipped `cordis-plugin-development` skill carried three mutually exclusive recipes and a verification checklist in one 8.7 KB file, above the 8192-character threshold at which the standard preset's tool-result pruner keeps only the head and tail. Both creator skills forbade reading DSH package sources, which made the skill text the only knowledge source and left the agent guessing whenever it did not cover a case. The skills also addressed the profile as `$DSH_HOME/profiles/<profile>`, a name the agent's shell never received.

## Decision

`SKILL.md` keeps the procedure, the knowledge-source order, and an index table; recipes move to `references/` files and copyable bundles to `templates/`, all resolved through the skill's base directory that the `skill` tool already reports. A test keeps the leading file under the pruner head and checks that every referenced file exists and every template parses.

Knowledge sources are ordered, never forbidden: inspection through `cordis_inspect_query`, the package README under the `packageDir` that `Config.listConfigs` resolves through the profile package lookup, then built `lib/` declarations or checkout sources when a question remains. Bundled packages resolve from the dsh installation and profile-installed ones from the profile, so skills never derive a package path from the profile directory. The shell registry exposes `DSH_PROFILE` and `DSH_PROFILE_DIR` as reserved built-ins whenever the launcher provided a profile context.

A third skill, `cordis-composition-reference`, holds the Loader patch dialect and a generated list of loadable plugin packages, freshness-gated in `doc-sync`, so procedure skills stop growing.

## Alternatives considered

Adding creator-mode text to the system prompt is paid every turn; the skill catalog already routes on demand. Shipping `docs/` to the agent would dilute maintainer material into a runtime context that needs installed-profile facts. Keeping the source-reading ban would have required the skills to restate every declaration they might need.

## Consequences

The first skill load costs about 3.9 KB, and each recipe 1 to 3 KB more. Recorded sessions that load `editing-cordis-compositions` refresh when its text changes. Compositions booted without a profile omit the two profile variables, and the skills say so.
