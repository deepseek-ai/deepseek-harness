---
kind: upgrade-guide
description: "Auto review recognizes user-sourced task instructions across input transports and existing history."
---

# Auto review recognizes user-sourced instructions

English | [中文](guide.zh.md)

## Change

Experimental Auto review recognizes text with `source.kind: 'user'` as task instructions without requiring a browser `rpcId`. This includes Headless, SDK, ACP, custom producers that submit as the user, and existing user-sourced history. An explicit instruction can authorize a medium-risk action within its stated scope. A child's own creation prompt and direct-parent messages retain their subordinate role; inherited and unverified creation prompts remain facts.

## Migration

1. Check custom calls to `createUserMessage`. Use the user source only for input submitted as the user's task. Give background or injected content its own producer-declared `MessageSourceMap` entry.
2. Before resuming Auto, review existing user-sourced instructions that could authorize medium-risk actions. Explicitly replace any obsolete scope in the next task.
3. Verify that injected content appears as `fact` or `constraint` in Auto's filtered history, while admitted user text appears as `user-instruction`. Files, tool results, and checkpoints cannot authorize actions.
