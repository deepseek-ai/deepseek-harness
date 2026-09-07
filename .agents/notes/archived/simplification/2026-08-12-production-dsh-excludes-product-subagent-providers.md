# Agent Note: Production dsh excludes product subagent providers

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-12-production-dsh-excludes-product-subagent-providers.zh.md)

## Problem

`@deepseek-ai/dsh` receives the `@deepseek-ai/dsh-base` dependency closure. Including the Codex and Claude Code subagent providers there makes every production install download optional product integration code and large platform CLI payloads, even when neither integration is used.

## Decision

This decision partially supersedes only the default-inclusion part of the [shared-host placement](../architecture/2026-08-10-product-subagent-providers-in-shared-host.md): `@deepseek-ai/dsh-base` does not depend on or mount the Codex and Claude Code subagent providers. Each provider package is a directly installable Profile Bundle whose `dsh.bundle.patch` points to one package-owned `cordis.patch.yml`. Each patch contributes exactly one self-provider Host row and no Agent tool row.

The two Bundles remain independent. The Codex Bundle owns the pinned official wrapper and six platform aliases; production starts the package-declared wrapper and never falls back to a host `codex`. The Claude Code Bundle owns the pinned Agent SDK and matching platform CLI; production lets the SDK select that private CLI and never falls back to a host `claude`. Installing one Bundle does not pull in the other, and the default `@deepseek-ai/dsh` production closure contains neither provider nor either product runtime. Each installed Bundle registers a dormant provider on the next Profile start, while an Agent Preset independently decides whether a new Session receives the corresponding tool. Installation does not start a product, authenticate an account, rewrite native settings, or grant model access.

## Verification

Package tests pin both Bundle manifests, published patches, exact self-provider rows, and product runtime dependencies. Claude coverage pins Agent SDK 0.3.241, Claude Code 2.1.241, all eight platform packages, SDK-selected execution, and missing-payload failure without host fallback. Codex coverage pins wrapper 0.149.1, all six platform aliases, package-declared execution, native descendant quiescence, and the same missing-payload behavior. Workspace validation derives each published patch from its Bundle declaration rather than a package catalog. Package/base assertions plus actual pnpm production evidence prove the default and selected-product dependency boundaries, while real Bundle-patch and Agent-Preset composition covers none, either product, both, the tool-grant intersection, later-Session adoption, and zero startup processes.

## Alternatives considered

**Keep dormant providers in the base bundle.** Dormant providers start no product processes, but their packages still enter every production npm install.

**Add a wrapper or meta Bundle.** A third package would duplicate installation ownership and make independent removal less direct without contributing another runtime capability.

## Consequences

Installing `@deepseek-ai/dsh` does not download either product provider through the base bundle. A Profile can add or remove either provider Bundle independently; changed Host availability takes effect on the next Profile start, and selecting a product explicitly accepts its private platform payload. A separately authored Agent Preset grants either model-visible tool only to newly composed Sessions. No wrapper package beyond the products' official distributions, meta Bundle, dynamic installer, or persisted product-enable state is introduced.
