# Agent Note: Plugin CLIs by absolute path in runtime context

Status: implemented

English | [中文](2026-10-27-plugin-cli-absolute-paths.zh.md)

## Problem

CLI app plugins such as Feishu, WeCom, DingTalk, and Tencent Meeting install a vendor CLI outside PATH. The upstream guides, the CLIs' own messages, and the DingTalk and WeCom skill scripts call it by name. The model must run the plugin's installation, not another installation or none, and the harness should not change how model commands run to make that happen.

## Decision

Each app plugin registers its CLI's absolute path with `ctx.cliAccounts`, the Service of [`@deepseek-ai/dsh-cli-account`](../../../../packages/connector/cli-account/README.md). The Service registers required runtime context at the `PLUGIN_CLIS` context order, without interpolation, that tells the model to run the CLI by that path. For a skill whose scripts call the CLI by name, which applies to DingTalk and WeCom, the context also tells the model to prefix only the commands that run those scripts with `PATH="<directory>:$PATH"`, and never to export PATH or run the CLI by name. On Windows, where the shipped compositions mount `tool-pwsh` instead of `tool-bash`, the text uses PowerShell syntax: the call operator, `& '<path>'`, and the prefix `$env:PATH = '<directory>;' + $env:PATH`. Skills tell the model to use the path from the current runtime context. The plugin's own sign-in, status, and sign-out commands spawn the same path through the Service's command runner.

The harness changes no command environment: Bash, PowerShell, the sandbox, persistent terminals, and hooks run as they do without these plugins. Tencent Meeting registers its platform executable, `dist/tmeet-<platform>`. The DingTalk context contributes nothing until dws and its skills are installed. No load-time check requires commands to run on the Host; when a composition runs commands over SSH, a command fails when it reaches the missing path.

## Alternatives considered

**A private PATH.** Shell executors and the plugin backend put each plugin's bin directory first on PATH, and a system-prompt section listed the plugin CLIs. This needed a path prefix in every shell request, a prepared environment for backend commands, a Host-runtime check, and a `tmeet` symlink for Tencent Meeting. Persistent terminals and hooks did not get the prefix, and it hid a CLI of the same name that the user installed.

**Paths in skill text.** The model sees a skill's text only after loading it, compaction can reduce that text to a summary, and history keeps the old path after an upgrade. Static skill files would also have to be generated at run time.

**One shared registry and one combined entry.** Rewriting shell-env or adding a package for it states the rule once, but adds a service and its documentation for four callers. Other runtime contexts, such as the working directory and the sandbox policy, are registered by the package that owns the fact; a separate entry per plugin only repeats one sentence.

**A Host check.** Shipped profiles always run commands on the Host. The check would only move an SSH composition's failure from first use to load, at the cost of a `runsOnHost` member on the subprocess and shell services.

**A hint after a failed bare-name command.** Appending the path to the tool result when a command cannot find a registered name would correct the model after the failure, but no evidence yet shows that the context text alone is insufficient.

## Consequences

The model, not PATH, maps each name to its path. Counted on 2026-10-23, the upstream guides call the CLIs by name on 3,004 lines for DingTalk, 2,542 for Feishu, 321 for WeCom, and 248 for Tencent Meeting, and 33 DingTalk scripts call `dws` by name. A command that still uses the bare name runs the installation that PATH resolves, or fails because none is found; nothing rewrites it. The script sentence forbids exporting PATH and running the CLI by name because, in real-model runs, a sentence that only asked for the prefix on script commands led the model to export PATH and then run the CLI by name. Approval details, tool cards, and job lists show the full path.

A CLI that the user installed under the same name is no longer hidden, and persistent terminals and hooks need no PATH handling. Runtime context stays out of the cached system prompt and is admitted again after compaction; installing, enabling, or disabling a plugin appends one runtime-context snapshot. The text's dialect follows the Host platform with the same test the compositions use to choose the shell tool, so a composition that mounts the other shell on a platform gets the wrong syntax.

Unit tests in the kit pin the text, required status, literal paths, readiness, and removal on disposal; each plugin's recorded Session snapshot pins its rendered context.
