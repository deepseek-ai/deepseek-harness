---
kind: upgrade-guide
description: "workspace-changes.timeoutMs now defaults to 3000 instead of 30000, so a turn whose git command runs longer than 3 seconds gets no changed-files card."
---

# Workspace changes give up a git command after 3 seconds

English | [中文](guide.zh.md)

## Change

The `@deepseek-ai/dsh-workspace-changes` plugin terminated a git command after `timeoutMs`, which defaulted to `30000`. It now defaults to `3000`. Tool calls wait for the turn-start snapshot, so a working directory with many non-ignored untracked files no longer stalls each tool call for up to 30 seconds; when a snapshot or diff command exceeds 3 seconds, that turn records no changes and the Web shows no changed-files card for it. A per-file comparison opened from the card is also abandoned after 3 seconds.

Affected: Web and Desktop users whose repositories need more than 3 seconds for one snapshot command, such as large untracked content, a cold disk cache, or a slow filesystem. A `timeoutMs` set explicitly on the `workspace-changes` row is kept.

## Migration

1. To keep the previous bound, add `- {id: workspace-changes, config: {timeoutMs: 30000}}` to the profile patch `$DSH_HOME/profiles/<profile>/cordis.patch.yml`. Tool calls in such a repository then wait up to that long again.
2. To keep the card without the wait, add the large untracked directories to the repository's `.gitignore`.
3. Confirm with `dsh --profile <profile> --dump-config` that the `workspace-changes` row shows the intended `timeoutMs`.
