# Agent Note: Built-bundle exemption for a failing stylesheet

Status: implemented

English | [中文](2026-09-10-built-bundle-css-exemption.zh.md)

## Problem

The [Node import sweep](../../../../packages/experimental/webworker-runtime/tests/compile/transform-corpus-check.ts) exempts the Dockkit bundle because Node cannot load its stylesheets, and admitted one exact stylesheet path as the evidence: `packages/client/ui-dockkit/lib/components/dockkit.module.css`. The built bundle imports the workspace package `@deepseek-ai/dsh-client-ui-primitives` before its own stylesheet, and the `tsx` launcher resolves that specifier through tsconfig `paths` into the dependency's `src` tree, so the sweep reports `ERR_UNKNOWN_FILE_EXTENSION` for `packages/client/ui-primitives/src/StateDot.module.css`. The pinned path cannot match on a tree with client build output, and the Windows complete-gate inventory reported the exempt bundle as an unexpected baseline failure.

## Decision

The Dockkit exemption admits Node's unknown-`.css`-extension refusal for any stylesheet. Another extension, another error code, and an unrelated error message stay findings, as does an exempt bundle that imports cleanly.

## Alternatives considered

**Admit the dependency's source stylesheet alongside the pinned one.** That file is what the sweep reports, but the bundle's import order and the launcher's path mapping select it. Pinning it would certify those two details instead of the `.css` exemption.

**Classify every CSS exemption by the same rule.** The Dockkit pin is the recorded evidence this change corrects; the other two stylesheet exemptions were never classified, and tightening them would change what they admit beyond the reported defect.

**Drop the classification and admit any failure.** A bundle that stopped importing for an unrelated reason would then hide inside the exemption total.

## Consequences

The sweep reports the Dockkit bundle when it stops importing for any reason other than Node's unknown-`.css`-extension refusal, and the entry no longer asserts which stylesheet fails. [Scoped resolve/load hooks](../../../../packages/experimental/webworker-runtime/tests/compile/transform-corpus.spec.ts) exercise an admitted Dockkit stylesheet, the dependency's source stylesheet, another extension, an arbitrary message, another error code, and a stale exemption without modifying shared build artifacts.

The [CI observation decision](../testing/2026-09-08-ci-completion-observations.md) keeps the fixture completion and isolation decisions it owns; its built-client classification paragraph keeps the sweep summary and links here for the admitted evidence.
