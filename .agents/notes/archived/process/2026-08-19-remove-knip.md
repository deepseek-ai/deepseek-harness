# Agent Note: Remove Knip from repository gates

Status: implemented
Archived: 2026-09-30

English | [中文](2026-08-19-remove-knip.zh.md)

## Problem

Knip derives unused files, exports, and dependencies from a static source graph. DeepSeek Harness also loads Cordis plugins from package manifests and configuration, emits Typert faces into `lib/`, splits Host and Client programs, and declares dependencies consumed only by generated or runtime-loaded code. The repository therefore needed workspace-specific entry lists and ignored-dependency exceptions to make supported paths pass the scan. Package and test-layout changes had to maintain that second approximation of the executable graph.

The repository already has narrower checks for the failures it treats as release contracts: TypeScript and Oxlint validate source imports, workspace constraints validate manifests, `verify-optional-dependency-imports` validates optional imports, `verify-runtime-closure` validates runtime dependencies, `verify-client-packages` validates Client packaging, and publint validates published packages. The generic unused-code result is advisory, while its exceptions are required maintenance.

## Decision

Knip is not a repository dependency or quality gate. The root manifest has no Knip script or devDependency, the gate graph and `hygiene` command do not invoke it, and the repository carries no Knip configuration. Package guidance and comments describe the runtime or generated-code requirement directly instead of teaching Knip exceptions.

The repository has no repo-wide static check for unused files, exports, or dependencies. Maintainers establish that a removal is safe from call sites, manifests, configuration, generated artifacts, tests, documentation, and Cordis Loader paths.

## Alternatives considered

**Keep Knip and its exception inventory.** This retains one broad advisory signal, but every supported dynamic or generated path needs configuration that restates facts already owned by manifests, build configuration, and package-specific checks. The exception inventory makes ordinary package changes depend on a source graph that does not represent the assembled application.

## Consequences

CI and `hygiene` run one fewer command, and package changes no longer update a parallel entrypoint and dependency-exception inventory. The repository gives up automatic broad unused-code and unused-dependency reports; reviewers and simplification work must prove removals against the real loading paths.

A future unused-code check must understand manifest-driven Cordis loading, generated outputs, and the Host/Client split without a per-workspace ignore inventory. Until then, a dependency with no source import is not dead-code evidence by itself.
