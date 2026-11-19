# DSH Core Guidelines

English | [中文](core-guidelines.zh.md)

## Summary

Rules for writing DeepSeek Harness code, in the style of the [C++ Core Guidelines](https://isocpp.github.io/CppCoreGuidelines/CppCoreGuidelines). Each rule has a stable ID and the parts that [G.1](#g1) defines.

## Table of Contents

- [Introduction](#in)
- [G: General](#g)
  - [G.1: Write every rule in the standard format](#g1)
  - [G.2: Avoid callbacks in public interface parameters](#g2)
- [F: Frontend](#f)
- [B: Backend](#b)
- [D: Data exchange](#d)

<a id="in"></a>
## Introduction

Before you finish a change, review the code it adds or modifies against every rule on this page. Fix each violation, or state in the change why the rule does not apply. A change does not have to migrate existing code it does not otherwise touch.

Cite a rule by its ID, for example "violates G.2". Artifact-specific review rules live in [defensive patterns](defensive-patterns/README.md); read them as well.

<a id="g"></a>
## G: General

Rules for all code in this repository, and for this page.

<a id="g1"></a>
### G.1: Write every rule in the standard format

#### Reason

A fixed format puts the requirement, its justification, and its limits in the same place in every rule. A stable ID lets reviews cite a rule without quoting it.

#### Example, bad

```md
### Callbacks

Callbacks caused bugs before, so prefer other designs where possible.
```

No ID. No imperative title. The requirement is buried in the rationale, and nothing says how to detect a violation.

#### Example

```md
<a id="g9"></a>
### G.9: <One imperative sentence>

#### Reason
#### Example, bad
#### Example
#### Enforcement
```

#### Note

A rule section is a level-2 heading `<Letter>: <Name>`, preceded by an `<a id>` anchor of its lowercased letter and followed by one paragraph that states its scope. `<Letter>` is one or more capital letters, unique on this page.

A rule is a level-3 heading `<Letter>.<n>: <Title>` inside its rule section. An `<a id>` anchor, the lowercased ID without the dot, precedes the heading. `<n>` counts from 1 in order of addition. A removed rule's number is never reused.

The title is one imperative sentence that states the requirement.

The body is a sequence of level-4 headings in this order. `Reason` and `Enforcement` are required. Give at least one of `Example, bad` and `Example`. Omit any other heading that has no content.

- `Reason`: the defect or cost the rule prevents.
- `Example, bad`: a violation.
- `Example`: compliant code for the same case.
- `Alternative`: what to use instead of a forbidden construct.
- `Exception`: cases the rule does not cover.
- `Note`: definitions and details.
- `Enforcement`: the check that rejects a violation, or what a reviewer flags.

Write short, direct sentences.

#### Enforcement

Review: flag a rule that deviates from this format. `verify-translation-pairing` rejects a page whose two language versions differ in structure.

<a id="g2"></a>
### G.2: Avoid callbacks in public interface parameters

#### Reason

A callback lets the callee run caller code at times the callee chooses. The signature does not say when the callback runs, how often, whether it runs after the returned promise settles, or where its exceptions go. The callee becomes a dispatcher that must [contain callback exceptions](defensive-patterns/general.md#contain-callback-exceptions-in-the-dispatcher) and stop calling after cancellation or disposal. A function cannot cross a process boundary, so the interface cannot later become a `@Remote` or SDK method.

#### Example, bad

```ts
export interface UploadProgress { readonly loaded: number; readonly total?: number }

/** Upload `data`; `onProgress` runs for each chunk. */
export declare function upload(
  data: Uint8Array,
  onProgress?: (progress: UploadProgress) => void,
): Promise<string>
```

Can `onProgress` run after the promise settles? What happens when it throws? The signature does not say.

#### Example

```ts
export type UploadEvent =
  | { readonly type: 'progress'; readonly loaded: number; readonly total?: number }
  | { readonly type: 'done'; readonly fileId: string }

/**
 * Upload `data`. Yields one `progress` per chunk, then one `done`.
 * A failure rejects the next read; leaving the loop cancels the upload.
 */
export declare function upload(data: Uint8Array): AsyncIterable<UploadEvent>
```

Order, failure, and cancellation follow the iteration protocol. The caller's exceptions stay in the caller's loop.

#### Alternative

- One result: return a `Promise`.
- An intermediate result, such as the id of a created child before a later step: split the operation into calls that the caller sequences.
- A sequence of values: return an `AsyncIterable`.
- A notification for any number of listeners: emit a typed Cordis event that consumers subscribe to with `ctx.on()`.
- A replaceable strategy or factory: declare a Cordis service that providers implement.

#### Exception

- A registration API that returns its disposer, such as `ctx.on()`, `ctx.effect()`, or a registry's `register()`, including a registered object with handler members.
- A function that the callee finishes calling before the call returns or its promise settles, whose exceptions reach the caller, and that the callee does not keep, such as a comparator or a task run under a lock.
- A continuation the callee passes to a handler, such as a waterfall `next()`.
- An action callback in a client component prop or slot `inject` member, such as `onClick`.

#### Note

A public interface is a package entry-point export, a Cordis service method, a `@Remote` method, or an SDK method.

#### Enforcement

Review: flag a function-typed parameter, or a function-typed field of an options parameter, in a new or changed public interface that no exception covers.

<a id="f"></a>
## F: Frontend

Rules for client packages and apps that render the Web and Desktop UI. This section has no rules.

<a id="b"></a>
## B: Backend

Rules for Host-side packages: agent runtime, services, tools, and process management. This section has no rules.

<a id="d"></a>
## D: Data exchange

Rules for data that crosses a process, network, or storage boundary: `@Remote` and SDK messages, events, and persisted Session data. This section has no rules.
