---
kind: upgrade-guide
description: "The `agent-instructions` row no longer accepts `dshHome`; instruction loading always resolves the harness home from `$DSH_HOME` or `~/.dsh`."
---

# Instruction loading resolves one harness home

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-agent-instructions` removed its `dshHome` config field. The plugin resolves the harness home through `resolveDshHome()` from `@deepseek-ai/dsh-home-paths`, like every other harness consumer: the home is `$DSH_HOME` when it is set and non-blank, otherwise `~/.dsh`, with tilde expansion.

A `cordis.yml`, profile patch, or `--patch` overlay that still sets `dshHome` on the `agent-instructions` row has no effect: the row keeps the stray key and the plugin ignores it, so instruction loading follows the process home. Other providers, such as `dsh-skill-filesystem` and `dsh-shell-env`, keep their own home fields; this removal covers the instruction loader only.

## Migration

1. Delete `dshHome` from the `agent-instructions` row in `cordis.yml`, `$DSH_HOME/cordis.patch.yml`, `$DSH_HOME/profiles/<profile>/cordis.patch.yml`, and any `--patch` overlay.
2. Where the override pointed at a non-default home, export `DSH_HOME` for the process instead, so every harness consumer reads that home.
3. Confirm with `dsh --profile <profile> --dump-config` that the `agent-instructions` row lists only its remaining fields, and that a new session's first request shows `Instructions from: $DSH_HOME/AGENTS.md` (or `~/.dsh/AGENTS.md`) when that file exists.
