# Agent Note: TypeScript-only PTC tool execution

Status: implemented

English | [中文](2026-11-12-typescript-only-ptc.zh.md)

## Problem

The Python tool SDK originally let a provider change the program language while retaining typed tool calls. Removing the experimental Python runtime left that presentation available to external providers, together with Python completion rendering and binding-name restrictions imposed on the Node provider. Shipped PTC compositions use TypeScript, so those paths maintain a second language without a repository-owned execution provider or profile replay.

## Decision

`dsh-tool-executor-ptc` supports TypeScript only. It removes Python schema rendering and exports, language dispatch, completion presentation, and Python-specific binding exclusions. Unsupported providers fail during prompt assembly or execution through the selected executor, or when a private program tool is created. The PTC selection remains active so an invalid provider cannot expose inherited native tools. TypeScript programs retain their SDK, parameters, explicit output selection, canonical nested results and cancellation behavior.

The runtime service remains independent of tools. Its source-language descriptor lets each consumer check its own requirements; direct runtime and workflow consumers retain completion values. The Harness Python SDK, runtime wheels and other tools' Python environments have separate consumers and remain supported.

The [PTC foundation](../feature/2026-06-15-ptc.md) and [typed returns](../feature/2026-07-20-ptc-typed-tool-returns.md) remain active for their independent dispatch, durability and value semantics. Their language-specific facts follow this decision. The [archived language-dispatch decision](../../archived/feature/2026-07-31-ptc-language-dispatch.md) remains frozen history.

## Alternatives considered

**Keep external Python providers working.** This preserves a capability after deleting its implementation, but still requires a renderer, alternate output semantics and cross-language naming restrictions. Full removal gives one supported tool-program language and a clear migration.

**Remove Python SDK and runtime packaging too.** Those packages launch the Harness and consume its public protocol; they do not execute Python PTC programs. Removing them would discard an independent supported client.

## Consequences

External Python PTC compositions must migrate to a TypeScript provider and rewrite their programs; the [upgrade guide](../../../../docs/upgrade-guide/v0.2.2-rc.2/python-ptc-removal/guide.md) owns the steps. There is no Python compatibility branch. Reintroduction requires an owned provider, a concrete consumer need, language-specific rejection and output tests, and a shipped-profile replay.

Rejection tests mount the executor and compatibility selector through Cordis, then cover prompt assembly, schema projection, direct execution and the private factory. Built-export checks pin removal of Python renderers. Existing keyless TypeScript profile replays compare unchanged model prompts and execution output. Binding validation and real-process execution cover names that no longer need Python exclusions. Existing Session logs and committed historical generations retain their bytes.
