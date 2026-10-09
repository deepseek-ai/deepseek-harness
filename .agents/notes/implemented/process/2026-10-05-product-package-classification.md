# Agent Note: Require product use or an explicit package classification

Status: implemented

English | [中文](2026-10-05-product-package-classification.zh.md)

## Problem

An installation dependency can remain dormant indefinitely. Its presence in the dependency graph does not establish that a shipped profile, runtime import, or optional capability uses it. Conversely, an embedding SDK or a deployment-configured provider can have a maintained product role without appearing in the default GUI.

## Decision

Nonexperimental packages have effective product use or an explicit entry in the [package policy](../../../../scripts/product-package-policy.ts). The policy distinguishes optional integrations, SDKs, build tools, test tools, Web distribution packages, and declaration-only infrastructure. Each exception records its maintained role. [Experimental status](../../../../packages/experimental/README.md#status) describes maturity and support, independently of installation, optional selection, and Official discovery.

The [product-use check](../../../../scripts/verify-product-use.ts) follows effective shipped profiles, preset children, runtime source imports, and explicit dynamic mounts. It preserves disabled state through groups and Includes and applies patches before counting use. Manifest dependencies and type-only references do not create runtime use. Optional-bundle reachability remains separate from default reachability. Unknown packages and invalid or stale policy entries fail static CI and package hygiene.

The [default-product isolation rule](2026-09-12-default-product-experimental-isolation.md) remains independent: its conservative installation and declaration traversal rejects unintended experimental dependencies even when they are disabled. That traversal cannot establish active product use.

## Alternatives considered

**Treat every installed package as used.** A redundant dependency would satisfy its own classification requirement and conceal dormant code.

**Classify every nondefault capability as experimental.** Deployment prerequisites and installation cost do not establish immaturity; supported optional providers and SDKs need separate categories.

**Count every declared patch row.** A disabled Include, missing target, or later replacement can prevent that row from mounting. Only the effective composition establishes use.

## Consequences

Adding a nonexperimental package requires a product consumer or a reviewed classification. Renames and reduced in-box availability require upgrade instructions, while recorded events and released data keep their existing obligations. Regression fixtures reject manifest-only dependencies, disabled subtrees, ineffective patches, and stale classifications. SDK, test, build, and declaration packages remain independently installable without acquiring a runtime mount requirement.
