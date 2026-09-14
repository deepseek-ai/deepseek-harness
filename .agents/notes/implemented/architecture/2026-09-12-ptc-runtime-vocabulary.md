# Agent Note: PTC runtime vocabulary

Status: implemented

English | [中文](2026-09-12-ptc-runtime-vocabulary.zh.md)

## Problem

PTC mode and its execution providers need one searchable name across package manifests, service lookup, public types, configuration, and documentation. Mixed runtime prefixes make it difficult to trace a provider from a profile to its implementation and packaged bootstrap.

## Decision

The execution capability uses the `ptc-runtime` package family, `PtcRuntime` types, and `ctx.ptcRuntime`. The Node and private experimental Python providers share this vocabulary. Profile entry identifiers, internal bootstrap selectors, compiler references, package exports, and generated catalogs use the same names; no compatibility package or second service registration is supplied.

The PTC names for runtime packages and SDK language types supersede the exceptions recorded in [the earlier naming decision](../../archived/architecture/2026-08-25-rename-code-mode-to-ptc.md), giving providers and callers one searchable vocabulary.

The model-facing `run_code` operation, its `code` source argument, and its stable failure identity keep their descriptive names. General source-code terminology, error codes, external project names and URLs, historical migration identifiers, and sealed Agent Notes retain their meanings and recorded spelling. The naming decision does not change program execution, sandbox authority, deadlines, bindings, or Session formats.

## Alternatives considered

**Keep a separate generic runtime prefix.** The providers remain independent of tool and Session ownership, but their package and service names identify the PTC execution capability. A separate prefix adds a second name without separating an independently evolving feature.

**Replace every occurrence of “code.”** Program source, operation names, external references, and historical records describe different subjects. Replacing them would change public operations or recorded facts beyond the runtime naming decision.

**Publish old-name aliases.** The APIs are pre-stable and every repository consumer moves together. Aliases would preserve duplicate package and service identities and make subsequent discovery ambiguous.

## Consequences

Deployments and source consumers use the PTC package names and configuration identifiers together. Existing `run_code` transcripts and error routing remain readable. Mechanical audits compare renamed source tokens, preserve external URLs and frozen records, and inspect every residual old runtime name; built profile, package, and snapshot checks exercise the consumers that static imports cannot cover.
