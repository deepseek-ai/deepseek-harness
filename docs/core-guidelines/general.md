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
## G.3: Add a gate when a script can detect a new rule's violations

### Reason

Review alone misses repeated violations: a reviewer who does not know the rule lets the same violation in again. A gate stops new violations. Its recorded list makes the existing violations visible. The gate fails until the entries for fixed code are removed, and review rejects a list edit that adds an entry, so the list only shrinks. Recording existing violations lets the rule take effect without fixing them first.

### Example, bad

```md
### Enforcement

Review: flag a direct assertion to `unknown`.
```

A syntax check finds every such assertion, so this rule depends on each reviewer remembering it.

### Example

```md
### Enforcement

`verify-no-unknown-casts` rejects a direct assertion to `unknown` that `scripts/no-unknown-casts.baseline.json` does not record.
```

### Note

A script can detect a violation when it identifies the violation without a reviewer's judgment, for example a syntax form, an import, or a text pattern. A violation that needs judgment, such as whether a callback matches a [G.2](#g2) exception, stays a review check.

Add the gate in the same change as the rule. The gate rejects a violation that its list does not record. The same change writes the initial list from the gate's findings; no command writes it. For a TypeScript or JavaScript syntax form, build it on `scripts/baseline-inventory.ts`, which records violations by file and syntax fingerprint, fails while an entry matches no code, and removes such entries with `--prune`. Register the gate in `scripts/run-gates.ts` and name it in the rule's `Enforcement`.

### Enforcement

Review: flag a new rule whose violations a script can detect, but whose change adds no gate. Flag a change that adds an entry to a gate's list.
