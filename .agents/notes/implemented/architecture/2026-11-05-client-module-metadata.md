# Agent Note: Client metadata and renderer-owned stylesheet installation

Status: implemented

English | [中文](2026-11-05-client-module-metadata.zh.md)

## Problem

A script's execution environment need not be its presentation document. CSS injection embedded in JavaScript factories couples those destinations and makes module loading responsible for DOM cleanup. Inferring stylesheet ownership from React components would add component-level tracking without reliable source-file identity.

## Decision

Client artifacts contain `id` and `factory`, with optional `meta` and a `chunk` name for dynamic package-local chunks. `meta()` returns resource descriptions; `stylesheets` is an optional path-keyed record whose values expose independently evaluated `text(context)` functions. Resource paths identify stylesheets, not components. There is no stylesheet dependency field.

Modules owns JavaScript exports, module identity, owner ids, and observed dependency edges. It retains metadata functions without evaluating them and publishes generic module-record changes. Renderer owns metadata/text caches, dependency-ordered stylesheet collection, path deduplication, and main-document nodes. It explicitly installs existing resources before React mounting, updates them on module changes, and releases styles after the root unmounts. Component lifetimes do not own styles.

Static library builds keep their index artifact as ordinary ESM with all imports and dynamic imports for final shell assembly, and add the `__$dsh_client_module_manifest` export carrying the same manifest. The boot shell itself remains ordinary ESM. Modules wraps the existing carrier loading hook in its built-in Main environment; optional Realm providers do not change default startup or select plugin placement.

This decision refines the resource handling in the [loading model](2026-07-23-client-plugin-loading-model.md) and the artifact description in [shell layering](2026-08-15-client-shells-and-dynamic-packages.md). Their module identity, bootstrap, and dependency separation remain active; neither note is fully superseded.

## Alternatives considered

**CSS DOM operations inside each factory.** They target the script's globals and hide presentation effects in module evaluation; metadata separates data production from installation.

**Component analysis, Hooks, or Slot ownership metadata.** The required lifetime is module-level, so precise component tracking adds allocation and cleanup without a required capability.

**Reuse the dynamic plugin's private-dependency bundling for static libraries.** It moves third-party lazy chunking and font delivery into package builds, changing the established shell dependency policy. Static libraries retain that policy instead.

**Document Scope and an early Realm activation phase.** Neither is required when all modules use the existing Main carrier and all styles target the main document. Isolation requests, environment allocation, and multiple presentation destinations remain separate work.

## Consequences

Modules has no stylesheet query or subscription API. A stylesheet failure is reported by the renderer consumer, not a JavaScript factory failure: the renderer leaves out the failing stylesheet, reports it once, and installs the rest, so one module cannot block application mounting or the styles of modules that load later. Live replacement keeps the previous records in `activeRecords()` until the replaced runtime has been torn down, so a running plugin keeps its styles through a pending or failed download. Styles for materialized but currently invisible components remain installed until module invalidation or renderer disposal. Source-level business imports still receive the original exports through factory-backed `require`.
