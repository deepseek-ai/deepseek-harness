# Agent Note: Remove the stdio and Echo agents

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-20-remove-stdio-and-echo-agents.zh.md)

## Problem

DeepSeek Harness exposed two redundant product agents beside the TUI and Headless coding agents. The line-oriented stdio agent duplicated terminal interaction and non-interactive execution with a mixed prompt/output protocol. Echo duplicated Headless as a network-free mock model plus one teaching tool, making a test fixture into a user-facing agent and the default quick-start path.

Both agents carried support surfaces beyond their leaf configurations. Stdio owned a UI plugin, app package, SDK interface, REPL leaf, prompt protocol, and Loader tests. Echo owned a runnable command, mock adapter, tool, CI demo gate, graph entry, teaching references, and a shared test fixture. Keeping any of those product paths would preserve the redundant agent indirectly.

Standard input and output remain protocol boundaries for ACP, JSON-RPC, MCP, and child processes. Deterministic model adapters also remain valid inside tests. Those mechanisms do not justify a line-oriented or mock-only product agent.

## Decision

The stdio and Echo agents are removed without compatibility packages, modes, commands, or aliases. The stdio UI and app packages, `examples/repl-agent`, `examples/echo-agent`, `demo:repl`, `demo:echo`, their dedicated tests, and supporting manifests, gates, graphs, and documentation entries are deleted.

The remaining application roles are explicit:

- `@deepseek-ai/dsh-tui` owns terminal-interactive execution. It rejects non-TTY streams before Loader boot; `apps/cli/config/base.cordis.yml` plus the `tui.cordis.yml` overlay own the complete coding composition, with PTY plus terminal-snapshot coverage in `apps/cli/tests/`.
- [`dsh --profile headless`](../../../../apps/cli/README.md) owns non-interactive execution. Its `headless` profile is the product composition; recorded sessions live under `snapshots/session/`, profile integration tests under `apps/cli/tests/profiles/headless/`, and shared Loader drivers under `packages/test-support/loader-smoke/tests/fixtures/`.
- [`dsh --profile acp`](../../../../apps/cli/README.md) and `@deepseek-ai/dsh-sdk-jsonrpc-server` own their framed protocol integrations.

The SDK project model that carried the `stdio` run-interface option is deleted by the [SDK project toolchain removal](2026-08-11-remove-sdk-project-toolchain.md). Repository-facing demo documentation requires a DeepSeek API key and leads with a current runnable product.

Keyless validation is test-owned. The Headless Loader smoke uses a fixture adapter to exercise a real tool round trip, the `dsh` built-bin suite pins the published one-shot entry and output, the product Headless snapshot pins persistence, and the Headless PTY shutdown e2e pins signal escalation. Package-specific Loader tests keep deterministic adapters beside their scenarios. None is exposed as a runnable mock agent.

## Verification

TUI and Headless Loader coverage run the real app packages in source and built modes. PTY-driven subprocess coverage is reserved for the TUI lifecycle; other entry-point smokes use the one-shot pipe protocol. Headless proves its task/result and tool-call contracts. Generated graphs and repository searches reject stale package, command, leaf, SDK-interface, `createStdioChat`, and `StdioRuntime` references.

The built `dsh` bin rejects a piped TUI launch before Loader boot and points at `dsh --profile headless`; `apps/cli/tests/built-bin.e2e.ts` pins the product one-shot entry under plain Node, including output and invalid arguments. `apps/cli/tests/profiles/headless/tests/headless.expected.e2e.ts` pins product persistence, while `apps/cli/tests/headless-shutdown.e2e.ts` owns bounded signal escalation. The headless expected-output test preserves assembled canonical events without creating a second CLI contract. PTC mode runs through the headless profile's `DSH_TOOLS_MODE=ptc` composition. Time-context integration uses its package-owned Loader composition for two ordered turns, while its package tests own finer elapsed-time behavior.

## Alternatives considered

- **Keep the line agent only for pipes** — rejected because Headless has a bounded task contract, format-pure stdout, durable completion, and process exit status.
- **Keep, fold, or promote the readline helper as a package** — rejected because it had one app consumer and no independently swappable contract. Folding it into the stdio app removed an unjustified support-package boundary but still retained the redundant product; a future standalone line UI needs a real second consumer before reintroducing that package.
- **Keep Echo as the keyless quick start** — rejected because the first product experience should exercise the real model and supported coding agent, not a scripted adapter with a bespoke tool.
- **Keep Echo only as a CI demo command** — rejected because test-owned Headless fixtures cover the same Loader and built-artifact boundaries without preserving a mock product leaf.
- **Remove every stdio or mock mechanism** — rejected because framed protocols, process I/O, and deterministic test adapters are independent infrastructure, not the removed agents.

## Consequences

- Interactive and non-interactive product execution each have one owner and one runnable coding leaf.
- The repository has no keyless user-facing agent demo; local agent demos require `DEEPSEEK_API_KEY`.
- CI retains keyless real-entry coverage through test fixtures rather than a product command.
- Existing stdio-agent configurations and Echo commands fail instead of being translated.
- Piped multi-turn interaction in one process and the readline provider for non-TTY `ask_user_question` are intentionally gone; resume covers durable multi-turn work, and a non-TTY composition must supply its own interaction provider.
