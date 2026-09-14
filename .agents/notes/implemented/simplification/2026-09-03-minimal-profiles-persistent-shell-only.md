# Agent Note: Minimal profiles expose only a persistent shell

Status: implemented

English | [中文](2026-09-03-minimal-profiles-persistent-shell-only.zh.md)

## Problem

The shipped Web `minimal` preset and standalone `sdk-minimal` profile exposed `str_replace_editor` beside their persistent shell. The editor added a second file-mutation interface and its complete schema to every minimal model request, although the shell already provides file inspection and mutation. It also required a dedicated `fs-local` service that no other row in either minimal composition consumed.

Using one persistent shell gives the model a consistent file-operation interface and keeps the harness composition aligned with that interface. Leaving the editor mounted but hidden through a presentation filter would preserve an inactive capability that could reappear when presentation configuration changes.

## Decision

The shipped minimal compositions expose exactly one platform-selected persistent shell: `bash` on Linux and macOS, or `pwsh` on Windows. Neither composition mounts `@deepseek-ai/dsh-tool-str-replace-editor`, a filesystem tool, or the `fs-local` service that supported the editor. The fixed complete persona, absence of runtime context and compaction, shell timeout, and launch-specific host services remain unchanged.

The standalone editor package remains available for explicit custom compositions. A trusted user-authored preset or higher profile patch must insert the editor into the Cordis tree with a filesystem provider in the same service scope; the shipped `minimal` and `sdk-minimal` defaults never insert it. The [Python SDK guide](../../../../docs/user/guide/python-sdk.md#opt-in-to-str_replace_editor) provides an executable patch example.

The shared [persistent Bash consumer](../../../../packages/shell/tool-bash-persistent/README.md#model-experience) uses the one-shot shell's command-status wording while retaining its persistent state. Settled commands append `[Command finished with exit code N]`, including success; timeout output includes `[Command timed out or OOM]` and the shell-reset notice. Trailing newlines are removed before the status trailer. Both minimal Bash descriptions state that network access depends on the task environment. Explicit compositions using this consumer share its output behavior; the persistent PowerShell description and output remain unchanged.

Exact composition tests assert the single tool and the absence of a preset-local filesystem service. The `sdk-minimal` bundle test and built config dump assert that its row and dependency allowlists contain neither `fs-local` nor `dsh-tool-str-replace-editor`. Web and packaged-Python model-visible snapshots pin the one-tool schema roster. SDK profile smoke tests execute the guide's editor patch and verify file creation and viewing.

This decision partially supersedes the tool selection in [the bare minimal runtime](../feature/2026-08-11-minimal-profiles-bare-two-tool-runtime.md) and the minimal exception in [the base editor decision](2026-09-05-base-default-file-editor.md). Those notes retain authority for prompt ownership, no-compaction behavior, and base-backed file editing. [The application architecture](../../../../docs/architecture.md) owns profile launch and bundle layering.

## Alternatives considered

**Keep the editor row and hide its schema.** Rejected because a presentation or restriction layer would leave the capability in the minimal composition and make its absence depend on another setting.

**Remove the editor package from the distribution.** Rejected because explicit custom compositions remain valid consumers. The requirement concerns the two shipped minimal defaults.

**Keep the editor only in `sdk-minimal`.** Rejected because the two minimal paths would present different tool contracts to the same model class, and the packaged SDK path would retain the schema cost and unused filesystem service.

## Consequences

Minimal agents inspect and modify files through their persistent shell. Their model requests carry one tool schema, and their compositions own no filesystem service. The editor package and explicit editor compositions remain available. Web and SDK replay fixtures pin the persistent Bash status trailers alongside shell state and file effects.
