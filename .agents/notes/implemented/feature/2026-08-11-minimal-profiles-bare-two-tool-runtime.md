# Agent Note: Minimal profiles use a bare runtime

Status: implemented

English | [中文](2026-08-11-minimal-profiles-bare-two-tool-runtime.zh.md)

## Problem

The Web `minimal` preset and standalone JSON-RPC minimal composition exposed persistent `bash` and `str_replace_editor`, but their supporting services did not match the intended training runtime. Both mounted context compaction, while the Web preset inherited the host's sandboxed filesystem and the JSON-RPC composition mounted `fs-sandbox` plus filesystem policy. A long session could therefore replace history, and the editor advertised and enforced a filesystem policy that the bare local reference runtime does not have.

The two launch paths also have different configuration owners. Web mounts a per-agent preset over a running host, while the Python SDK initializes a complete stdio JSON-RPC child process. Treating them as one interchangeable Cordis leaf would hide those lifecycle differences, and the SDK example had no environment path for selecting its model or system prompt.

## Decision

The shipped Web minimal preset exposes persistent `bash`; the standalone profile exposes persistent `bash` on Linux/macOS or `pwsh` on Windows. Both mount no context-compaction or filesystem provider and suppress every `dsh-system-prompt` runtime-context contribution for fresh sessions. The [persistent-shell-only decision](../simplification/2026-09-03-minimal-profiles-persistent-shell-only.md) removes the editor and its otherwise-unused `fs-local` provider from both compositions. The Web preset's persona remains the fixed complete prompt owned by the earlier [minimal-preset composition decision](../../archived/bug-fix/2026-08-10-minimal-preset-owns-rl-composition.md) and applies runtime-context suppression only to that agent scope. The standalone spine forwards the same setting to its process-owned system-prompt service. The Web host retains its sandbox and approval services; the standalone profile mounts a danger-full-access sandbox policy and no approval service. Neither contributes model-facing policy context.

The standalone [`@deepseek-ai/dsh-sdk-minimal` bundle](../../../../packages/bundle/sdk-minimal/README.md) remains a complete JSON-RPC process composition behind `dsh --profile sdk-minimal`. It mounts SDK startup and JSON-RPC serving, the local PTY and subprocess services required by the platform-selected persistent shell, that shell's tool consumer, and uncompressed JSONL persistence under `$DSH_HOME/sessions`. It does not mount `token-meter`, `compaction-basic`, `fs-local`, `fs-sandbox`, `fs-observation-policy`, or a filesystem tool. The persistent shell consumes the profile's danger-full-access sandbox policy. [docs/architecture.md](../../../../docs/architecture.md) owns this bundle placement and its separation from `dsh-base`.

`DSH_SYSTEM_PROMPT` selects the standalone persona, and `DSH_CONTEXT_WINDOW` supplies fallback capacity for a model without exact catalog metadata. The SDK client's JSON-RPC `initialize` request is the sole runtime model selection. [`minimal.py`](../../../../python/sdk/examples/minimal.py) may read `DSH_MODEL` only as the command's default `model` argument; an explicit `--model` needs no matching child environment value. Endpoint and credential variables stay owned by the DeepSeek adapter's existing environment-resolution path.

## Verification

The Web replay boots the complete Web host, creates the agent through the preset service, and asserts that no scoped filesystem or compaction service exists, no system-prompt-owned runtime-context message was appended, and the assembled request contains exactly the fixed prompt and persistent Bash. It then executes persistent Bash against the real scoped services.

The SDK keyless source test boots real `dsh --profile sdk-minimal`, completes a turn with an environment-selected prompt, and asserts the generated one-bundle manifest. The Python SDK bundled-runtime snapshot owns the assembled prompt, exact single-tool catalog, and absence of every system-prompt-owned runtime-context message. Packaged-runtime coverage initializes the standalone profile through each available carrier with environment-selected model, model capacity, and prompt values, then executes the selected persistent shell. Cordis validation checks that both configurations resolve their declared plugins and configuration fields.

## Alternatives considered

**Keep `compaction-basic` mounted with a high threshold.** Rejected because even an inert-for-short-tests provider permits history replacement in longer sessions and leaves the minimal composition dependent on model-capacity metadata and the token meter.

**Keep `fs-local` after removing the editor.** Rejected because neither minimal composition has another filesystem consumer. Retaining the provider would increase the runtime roster without adding a model-visible capability.

**Use one Cordis leaf for Web and Python SDK startup.** Rejected because a Web preset contributes agent-scoped services to an existing multi-session host, while the Python SDK must launch a complete process containing the JSON-RPC server and its process-wide dependencies.

**Mirror the requested model into `DSH_MODEL`.** Rejected because the direct adapter accepts model ids outside its advisory catalog and resolves fallback context metadata for them. Mirroring creates two inputs for one selection; the SDK initialization request is authoritative, while `DSH_MODEL` remains only a convenience default in `minimal.py`.

## Consequences

Minimal sessions never summarize or replace earlier history and never add a runtime-context snapshot; callers must keep turns within the selected model's context capacity and must not rely on model-visible narration of standing sandbox or approval policy. The two launch paths share their single-tool, no-filesystem, no-context, and no-compaction guarantees while retaining different prompt and model configuration appropriate to their owners. The Python SDK path communicates only through the bundled `dsh` stdio JSON-RPC profile.
