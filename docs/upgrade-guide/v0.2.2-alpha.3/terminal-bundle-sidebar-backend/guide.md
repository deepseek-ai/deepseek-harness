---
kind: upgrade-guide
description: "The experimental terminal bundle opens Agent terminals in the Web sidebar and replaces its optional-terminal-bash and optional-terminal-pwsh rows with optional-terminal-panel."
---
# Persistent terminals open in the Web sidebar

English | [中文](guide.zh.md)

## Change

The **Persistent terminals** bundle (`@deepseek-ai/dsh-experimental-terminal-bundle`) used to run Agent terminals through `@deepseek-ai/dsh-terminal-bash`: a profile-free Bash on POSIX and PowerShell on Windows, invisible to the person, with sandbox-mode changes refused while one was open. Its `optional-persistent-terminals` group now mounts [`@deepseek-ai/dsh-terminal-panel`](../../../../packages/experimental/terminal-panel/README.md) instead. Each `terminal_open` becomes a sidebar tab running the execution environment's default shell with the person's startup files, or `pwsh` then `powershell` on Windows; the person can type into it and take it over. The bundle also registers `user_terminal_list` and `user_terminal_read`, and it requires the Web or Desktop composition, which mounts the terminal controller.

Profile patches that target the removed `optional-terminal-bash` or `optional-terminal-pwsh` rows, or that configure `@deepseek-ai/dsh-terminal-bash` options such as `pollIntervalMs` through them, no longer apply. Headless or other compositions without the terminal controller no longer get a working `shell` backend from this bundle.

## Migration

1. In your profile patch (`cordis.patch.yml`), remove entries for the ids `optional-terminal-bash` and `optional-terminal-pwsh`. To tune the new backend, target `optional-terminal-panel` with [its configuration fields](../../../../packages/experimental/terminal-panel/README.md#use-this-package), for example `config: { timeoutMs: 60000 }` or `config: { readUserTerminals: false }`.
2. For headless use, mount `@deepseek-ai/dsh-terminal`, `@deepseek-ai/dsh-terminal-bash` and `@deepseek-ai/dsh-tool-terminal` in your own patch instead of enabling the bundle.
3. Confirm the migration by keeping `@deepseek-ai/dsh-experimental-terminal-bundle` in `dsh.profile.bundles` of `$DSH_HOME/profiles/<name>/package.json`, restarting that profile, and asking the Agent to open a terminal: a tab with an **Agent** badge appears in the sidebar.
