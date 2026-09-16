# Agent Note: Narrow pi-ai runtime imports

Status: implemented

English | [中文](2026-09-15-narrow-pi-ai-runtime-imports.zh.md)

## Problem

The base bundle mounts `dsh-llm-pi-ai` with no configured routes so the Models settings page can offer pi-ai providers. Importing pi-ai's aggregate entry point for model helpers also evaluates its exported TypeBox namespace, adding hundreds of modules to every application startup even when all Sessions use `dsh-llm-deepseek`.

## Decision

`dsh-llm-pi-ai` has no runtime import of pi-ai's aggregate entry point. Catalog and login metadata continue through `providers/all`; protocol implementations use their existing `api/*.lazy` entries; overflow detection uses `utils/overflow`. Package-local `models.ts` supplies the three model helpers the adapter needs. Its collection comes from pi-ai's public `builtinModels()` implementation and is cleared before route providers are installed. Its provider constructor implements the static single-protocol case this adapter supplies. Its reasoning-level selection reads pi-ai's public `Model` metadata in pi-ai's escalation order.

Type-only imports from the aggregate entry point remain because TypeScript erases them. Import profiling of the built package resolves 153 pi-ai modules and no TypeBox modules or pi-ai aggregate entry.

## Alternatives considered

- **Add a pi-ai `models` export.** Rejected because this package does not need an upstream export-map change to consume the public provider, API, utility, and model metadata interfaces already available.
- **Dynamically import the aggregate entry point.** Rejected because the dormant adapter needs none of it; excluding the entry entirely removes the work instead of moving it to a later operation.
- **Copy pi-ai's complete Models implementation.** Rejected because `builtinModels()` already returns the upstream implementation with its authentication and storage behavior. Clearing its providers preserves that implementation without maintaining a fork.

## Consequences

Applications still load `providers/all` so configuration and authorization surfaces retain the complete installed provider directory. Constructing an adapter snapshot briefly constructs and then clears the built-in provider set before installing the resolved route providers. The package-local provider constructor deliberately accepts only static models and one protocol implementation; adding dynamic models, filtering, or multi-protocol custom routes requires extending that local function together with its tests.
