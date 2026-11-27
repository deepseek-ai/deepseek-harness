# G: General

English | [中文](general.zh.md)

Rules for all code in this repository, and for these guidelines.

<a id="g1"></a>
## G.1: Write every rule in the standard format

### Reason

A fixed format puts the requirement, its justification, and its limits in the same place in every rule. A stable ID lets reviews cite a rule without quoting it.

### Example, bad

```md
## Callbacks

Callbacks caused bugs before, so prefer other designs where possible.
```

No ID. No imperative title. The requirement is buried in the rationale, and nothing says how to detect a violation.

### Example

```md
<a id="g9"></a>
## G.9: <One imperative sentence>

### Reason
### Example, bad
### Example
### Enforcement
```

### Note

A rule section is a bilingual pair in this directory other than `README.md`, named for the section, such as `general.md` and `general.zh.md`. Its level-1 heading is `<Letter>: <Name>`, followed by one paragraph that states its scope. `<Letter>` is one or more capital letters, unique among sections. [README.md](README.md) lists every section and rule; add each new rule there in the same change.

A rule is a level-2 heading `<Letter>.<n>: <Title>` in its section file. An `<a id>` anchor, the lowercased ID without the dot, precedes the heading. `<n>` counts from 1 in order of addition. A removed rule's number is never reused.

The title is one imperative sentence that states the requirement.

The body is a sequence of level-3 headings in this order. `Reason` and `Enforcement` are required. Give at least one of `Example, bad` and `Example`. Omit any other heading that has no content.

- `Reason`: the defect or cost the rule prevents.
- `Example, bad`: a violation.
- `Example`: compliant code for the same case.
- `Alternative`: what to use instead of a forbidden construct.
- `Exception`: cases the rule does not cover.
- `Note`: definitions and details.
- `Enforcement`: the check that rejects a violation, or what a reviewer flags.

Write short, direct sentences.

### Enforcement

Review: flag a rule that deviates from this format. `verify-translation-pairing` rejects a section whose two language versions differ in structure.

<a id="g2"></a>
## G.2: Avoid callbacks in public interface parameters

### Reason

- Hard to read and reason about. The type of a callback parameter does not say when the callee calls it, how often, or what happens when it throws.
- Not serializable. A function cannot cross a process boundary, so the interface cannot be a `@Remote` or SDK method.

### Example, bad

```ts
export interface UploadProgress { readonly loaded: number; readonly total?: number }

/** Upload `data`; `onProgress` runs for each chunk. */
export declare function upload(
  data: Uint8Array,
  onProgress?: (progress: UploadProgress) => void,
): Promise<string>
```

Can `onProgress` run after the promise settles? What happens when it throws? The signature does not say.

### Example

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

### Alternative

- One result: return a `Promise`.
- An intermediate result, such as the id of a created child before a later step: split the operation into calls that the caller sequences.
- A sequence of values: return an `AsyncIterable`.
- A notification for any number of listeners: emit a typed Cordis event that consumers subscribe to with `ctx.on()`.
- A replaceable strategy or factory: declare a Cordis service that providers implement.

### Exception

- An event handler: a function or object that a caller registers to receive events, such as a `ctx.on()` listener (the registration returns its disposer), or a client component's event prop such as `onClick`. A waterfall `next()` passed to a handler is part of the handler's signature.
- A function that the callee finishes calling before the call returns or its promise settles, whose exceptions reach the caller, and that the callee does not keep, such as a comparator or a task run under a lock.

### Note

A public interface is a package entry-point export, a Cordis service method, a `@Remote` method, or an SDK method.

### Enforcement

Review: flag a function-typed parameter, or a function-typed field of an options parameter, in a new or changed public interface that no exception covers.

<a id="g3"></a>
## G.3: Add a gate with every new rule that a script can check

### Reason

Reviewers forget rules, so the same violation comes back. A gate rejects new violations automatically. It records existing violations in a list, so the rule takes effect now and the existing code can be fixed later.

### Example, bad

```md
### Enforcement

Review: flag a direct assertion to `unknown`.
```

A script can find every direct assertion to `unknown`, yet this rule relies on each reviewer remembering it.

### Example

```md
### Enforcement

`verify-no-unknown-casts` rejects a direct assertion to `unknown` that `scripts/no-unknown-casts.baseline.json` does not record.
```

### Note

A script can check a rule when it finds violations without human judgment, such as a syntax form, an import, or a text pattern. A rule that needs judgment stays review-only, such as whether a callback falls under a [G.2](#g2) exception.

In the same change as the rule:

- Add the gate. It fails on any violation that its list does not record.
- Write the list of existing violations. No command generates it.
- Register the gate in `scripts/run-gates.ts`.
- Name the gate in the rule's `Enforcement` section.

The gate also fails when a list entry no longer matches any code. Reviewers reject changes that add entries to the list, so the list only shrinks.

For a TypeScript or JavaScript syntax form, build the gate on `scripts/baseline-inventory.ts`. It records each violation by file and syntax fingerprint, and `--prune` removes entries that no longer match code.

### Enforcement

Review: flag a new rule that a script can check but that has no gate. Flag a change that adds an entry to a gate's list.
