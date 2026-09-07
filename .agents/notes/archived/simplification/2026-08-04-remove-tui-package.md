# Agent Note: Remove the TUI package

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-04-remove-tui-package.zh.md)

## Problem

Removing the implicit `dsh` terminal application left `@deepseek-ai/dsh-tui` without a shipped composition. The package still carried a terminal renderer, interactive command and question adapters, extension overlays, snapshot fixtures, a patched `pi-tui` dependency, and SDK scaffolding that advertised TUI as a supported application interface. Keeping that surface required maintaining a product-sized frontend whose only remaining consumer was the project generator itself.

The package also made the repository's supported application inventory misleading. Current runnable products use Web, ACP, JSON-RPC, or one-shot CLI entry points, while the SDK continued to offer a terminal choice that no example or product command exercised.

## Decision

The `packages/ui/tui` package is deleted without a compatibility package or alias. Its source, package tests, terminal snapshots, dependency declarations, patched `pi-tui` artifact, workspace references, generated service catalog entry, and documentation are removed together. Generic host and agent-loop capabilities remain unchanged.

The SDK project toolchain that remained as the TUI package's final consumer is deleted by the [toolchain removal decision](2026-08-11-remove-sdk-project-toolchain.md). Host applications may still mount the provider-neutral `dsh-user-questions`, `dsh-commands`, and presentation services directly.

This decision supersedes the reusable-package retention in [the explicit-config `dsh` entrypoint decision](../../archived/simplification/2026-08-03-explicit-config-dsh-entrypoint.md) and the current applicability of the archived TUI implementation notes. Their historical records remain frozen, but they are not authority for the supported package or application inventory.

This note consolidates the deleted package-only records that could not remain current after removal. The terminal UI had kept session identity visible during long conversations, removed duplicate model labels, attached elapsed timing and phase status to messages, showed workspace and branch context beside the prompt, and conservatively parsed complete XML wrappers for human-readable fallback output. Those choices improved one terminal frontend but do not justify retaining it without a deployment. A future XML fallback must still use a real parser rather than regular expressions.

## Verification

Repository searches and generated catalogs contain no TUI package, dependency patch, service key, or package link. The ordinary source build, typecheck, lint, hygiene, documentation gates, and remaining assembled snapshot suites run without the deleted workspace.

## Alternatives considered

**Keep the package unshipped.** Rejected because it preserves the maintenance cost and continues to present an unsupported terminal frontend as reusable product surface without a real composition proving its lifecycle.

**Keep the SDK option for external consumers.** Rejected because the generator would be the package's only in-repository consumer and would scaffold an application the repository no longer accepts end to end. The pre-release compatibility stance does not require preserving that option.

**Move the package to an examples or experimental group.** Rejected because moving code does not provide a current product need, a maintained deployment, or assembled acceptance. A future terminal frontend should start from its actual host and interaction requirements rather than inherit this implementation by default.

## Consequences

DeepSeek Harness has no terminal UI package. Existing imports and `cordis.yml` rows that depend on the package fail instead of being translated. Web remains the shipped interactive surface; ACP, JSON-RPC, and one-shot CLI remain the non-Web entry points.

The provider-neutral command, user-questions, approval, tool-presentation, PTY, and session-projection capabilities remain available to other hosts. Reintroducing a terminal frontend requires a named product or deployment, an explicit package boundary, a concrete interaction provider, and assembled lifecycle and transcript acceptance for that frontend.
