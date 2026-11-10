# Agent Note: Scoped REPL evaluator for retained PTC

Status: implemented

English | [中文](2026-11-09-retained-ptc-scoped-repl.zh.md)

## Problem

`persistent-in-memory` runs every `run_code` call of one Agent in one global scope through node:repl ([best-effort persistent PTC](../../implemented/architecture/2026-09-23-best-effort-persistent-ptc.md)). When a later call declares a `const`, `let`, or `class` name again, V8 rejects the program before it runs with `SyntaxError: Identifier 'x' has already been declared`, and no statement executes. Model guidance can only ask for no redeclarations, and models rarely track every name across many calls.

Rewriting declarations as `var` removes the error, but every call then shares one binding, so a later declaration changes the value that earlier functions, closures, and background tasks read:

```js
// call 1
var value = 1
var read = () => value
// call 2
var value = 2 // no error
// call 3
read() // 2: call 2 changed the read written by call 1
```

Five requirements must hold together:

1. A later call may declare an earlier name again with any keyword without an error.
2. A redeclaration applies to that call and later calls; earlier functions, closures, and still-running code keep their original values.
3. Syntax matches the existing REPL: top-level `await` works, the final expression is the result, and top-level `return` is not supported.
4. Errors in asynchronous callbacks are handled as in the existing REPL: the process keeps running and variables are retained.
5. No scope analysis and no rewriting of declarations or references in model code; acorn only lists top-level declarations and finds the last statement.

## Decision

The scoped REPL evaluator is split into a kernel and an evaluator:

| File | Contents |
|---|---|
| `packages/ptc-runtime/ptc-runtime-node/src/evaluators/scoped-repl.ts` | Kernel: the `ScopedReplScopes` scope chain, which owns binding state, copies and fallback values, redeclarations, and Script compilation; plus the acorn scan, top-level declarations and keywords, top-level `return` check, final expression, reserved-name check, syntax-error layout, and source generation |
| `packages/ptc-runtime/ptc-runtime-node/src/evaluators/scoped-repl-evaluator.ts` | Evaluator: exports `createScopedReplEvaluator(options)` implementing the existing `ProgramEvaluator` interface and connects the kernel to the existing modes: context and options, dynamic imports and the import handler, starting programs from a microtask and reading completions, the domain, and the injected `reportRedeclarations` |
| `packages/ptc-runtime/ptc-runtime-node/tests/scoped-repl.spec.ts` | Kernel tests only; runs on its own and covers scanning, source generation, and scope layering across consecutive programs in a plain vm context |
| `packages/ptc-runtime/ptc-runtime-node/tests/scoped-repl-evaluator.spec.ts` | Integration tests: completions, environment, modules and imports, errors, and asynchronous failures; every option tested on and off |

The `scoped-repl` format connects the evaluator to the existing execution modes; see Integration.

### Exact behavior

#### Syntax and results

- A program is a list of statements and supports top-level `await`.
- When the last non-empty top-level statement is an expression statement, its value is the result. A Promise value is not awaited: the Promise itself is the result, so the host reports `program completion must be lossless JSON`, as with the existing REPL. The `finalExpression` option controls this and defaults to on; when off, the final value is discarded, results come only from printing, and model guidance must change accordingly. `run_code` passes `discardCompletion: true` for TypeScript runtimes, so the host discards completion values and the model displays output with `inspect(...)`; callers that keep completions, such as workflow-ptc, still take the final expression's value as the result.
- When the last statement is a declaration, `if`, `for`, block, or another statement, there is no result.
- Top-level `return`, including inside top-level `if`, loops, and blocks, reports `SyntaxError: Illegal return statement`, and no statement of that call runs. Through `run_code`, the host's TypeScript erasure rejects it first with `Return statement is not allowed here`, as with the existing REPL.
- A static `import` or `export` reports acorn's `SyntaxError: 'import' and 'export' may appear only with 'sourceType: module'`; acorn also rejects top-level `using` and `await using`, which remain available inside blocks and functions.
- A program that starts with `#!` reports `SyntaxError: Hashbang lines are not supported` and does not run: a hashbang is valid only at the very start of a Script, and the generated prefix precedes the program.
- Output is the printed text, such as `inspect(...)`, plus the final expression's value when the caller keeps completions.

#### Across calls

- Each call starts by copying every top-level name left by earlier calls into a same-named declaration; objects are shared by reference, so changes inside an object are visible on both sides.
- A call may declare an earlier name again with any keyword, including a `var`→`let`→`const`→`class`→`function` sequence. A name the call declares with `let`, `const`, `class`, or `function` is not copied, and the call's declaration wins; a name it declares again only with `var` is still copied, so that `var` starts from the earlier value.
- Assigning to an earlier name without declaring it changes this call's copy: later calls see the new value, and earlier functions keep the old one. This includes names declared with `const`, which are read-only only in the call that declares them.
- After a function is redefined, earlier callers still call the old function.
- Assignments that earlier code, such as timers and callbacks, makes to top-level variables after a call starts are not visible to later calls; keep shared mutable state in objects.
- Earlier functions cannot see names declared later; referencing them reports `ReferenceError`.
- When a call declares a name again with `let`, `const`, or `class`, every reference in that call resolves to the new declaration, including references written before it, and the old value is unreachable: reading the name before its declaration runs reports the native `ReferenceError: Cannot access 'x' before initialization`. Such code is a program error and is not handled. A `var` redeclaration starts from the earlier value until it assigns a new one, so `var count = count + 1` adds to the earlier value; a `function` name holds the new function from the start of the call.
- When a call fails partway: declarations completed before the throw are kept; an existing name redeclared but not yet initialized falls back to its earlier value in later calls; an uninitialized new name is dropped.
- A `var` declared inside a block, including `try`/`catch`/`finally`, `if`/`else`, loop bodies, `switch`, and labeled statements, hoists to the top level of the call and counts as the call's declaration like a top-level `var`: it carries to later calls and may reuse a name that an earlier call declared with any keyword. A `var` inside a nested function or class does not count.
- A `var` redeclaration that does not run, after a throw or in a branch that is not taken, keeps the earlier value, and so does `var x;` without an initializer.

#### Environment

These are the defaults; one option controls each of the first two items, see Context and options.

- Strict mode: assigning an undeclared name reports `ReferenceError`; intentional globals use `globalThis.x`. With the option off, strict mode is not forced: a program that starts with `"use strict"` runs strict, and other programs run sloppy.
- No code generation from strings: the context's own `eval` and `new Function` report `EvalError`, and compiling WebAssembly from bytes reports `CompileError`. This is no isolation: main-realm functions copied into the context, such as `setTimeout.constructor`, still generate code in the main realm.
- Modules load only through dynamic `import()`, whose relative specifiers resolve from the working directory of the environment's first call and keep doing so after later calls change directory; there is no `require`, `module`, or built-in module global such as `fs` and `path`. Relative file access still follows the current directory.
- Top-level `this` is `undefined`, or `globalThis` when a program runs sloppy; top-level `arguments` is an empty arguments object with length 0.
- Top-level `var` and `function` declarations do not become `globalThis` properties.
- Node globals such as `setTimeout`, `Buffer`, `fetch`, `URL`, and `structuredClone` are available.

#### Errors

- Runtime error lines and columns are native positions in the model's code, and functions defined in an earlier call show that call's filename, for example `<directory>/.ptc-repl-1.js:2:9`. On the line of the final expression, columns after the insertion point shift right by 17, which is left as is.
- Syntax errors that acorn finds are reported with acorn's message and position, laid out like V8's: filename and line, source line, and caret. Two messages use V8's wording: top-level `return` reports `Illegal return statement`, and an error positioned at the end of the code reports `Unexpected end of input`.
- Errors that acorn accepts and V8 rejects during compilation report V8's native message; with the `strict` option on, strict-mode syntax violations such as `with` are reported this way.
- These are the evaluator's own reports. Through `run_code`, the host's TypeScript erasure parses the whole program first and reports most syntax errors itself, as with the existing REPL; only code that the erasure accepts and the scan rejects, such as reserved names, static `import`, or top-level `using`, shows the layout above.
- Runtime errors report the error name and stack, without an `Uncaught ` prefix and without evaluator frames.

#### Asynchronous failures and lifecycle

- Errors thrown by timers, callbacks, Promise continuations, and EventEmitters that a program starts, and unhandled rejections, do not end the process, and variables are retained. Exception: when a callback throws a frozen or non-extensible object, Node's domain fails to add its properties before notifying the listener, and the process ends, as with node:repl; rejecting with such an object is unaffected.
- If an evaluation is active, it fails with `Uncaught ` followed by the error text; otherwise the error is discarded. The error text is the error's `stack`, or `name: message` when the stack is not a string; a value that is not an error is formatted with `util.inspect` after removing the `domain` and `domainThrown` properties the domain added; a failure while formatting reports `program threw an unrenderable value`. An error belongs to the evaluation that created its callback, so a timer from an earlier call failing during a later call is not charged to the later call.
- Output printed after an evaluation ends is discarded; timeout, cancellation, and reset keep the existing host behavior ([retained PTC interruption](../../implemented/architecture/2026-10-29-retained-ptc-interruption.md)).

### Comparison with node:repl and vm-script

✓ means supported, ✗ means not supported, and "—" means not applicable: `vm-script` without persistence starts a new process for every call and has no cross-call state. "Persistent vm-script" is vm-script with `scriptPersistence: true` (#7992), and "both vm-script columns" means it and vm-script without persistence. The "ours" column is the default behavior, and its parenthesis names the columns it matches; the Environment table splits it into strict mode on, the default, and off. The Across calls table adds an implementation expected to support cross-call behavior, called the "expected implementation" in parentheses and notes.

**Syntax and results**

| Capability | node:repl (existing REPL evaluator) | Ours | vm-script (no persistence) | vm-script (persistent, #7992) | Notes |
|---|---|---|---|---|---|
| Top-level `return`, including inside `if` blocks | ✗ | ✗ (matches node:repl, vm-script, persistent vm-script) | ✗ | ✗ | All report `Illegal return statement` |
| Final expression as the result | ✓ | ✓ (default; matches node:repl, vm-script, persistent vm-script) | ✓ | ✓ | Ours can turn it off with `finalExpression` |
| Awaiting a final Promise | ✗ | ✗ (matches node:repl) | ✓ | ✓ | Without awaiting, the host reports a non-JSON completion |
| A result when ending with `if`, `for`, or a block | ✓ | ✗ (matches node:repl, vm-script, and persistent vm-script when the code contains `await`) | ✓ | ✓ | node:repl and both vm-script columns have a result only without `await` |
| Top-level `await` | ✓ | ✓ (matches node:repl, vm-script, persistent vm-script) | ✓ | ✓ | node:repl and both vm-script columns rewrite the whole program; ours rewrites only the final expression |
| Static `import` | ✗ | ✗ (matches node:repl, vm-script, persistent vm-script) | ✗ | ✗ | Ours reports acorn's message |
| Top-level `using` | ✗ | ✗ (matches node:repl, vm-script, persistent vm-script) | ✗ | ✗ | Available inside blocks and functions |
| A program that starts with `#!` | ✓ | ✗ (matches none of node:repl, vm-script, persistent vm-script) | ✓ | ✓ | Ours reports `Hashbang lines are not supported` |
| Two `function` declarations of one name, or a `var` and a `function` of one name, in one call | ✓ | ✓ (matches node:repl, vm-script, persistent vm-script) | ✓ | ✓ | |
| Dynamic `import()` | ✓ | ✓ (matches node:repl, vm-script, persistent vm-script) | ✓ | ✓ | |

**Across calls**

| Capability | node:repl | An implementation expected to support cross-call behavior | Ours | vm-script | Persistent vm-script | Notes |
|---|---|---|---|---|---|---|
| Variables retained across calls | ✓ | ✓ | ✓ (matches node:repl, the expected implementation, persistent vm-script) | ✗ | ✓ | node:repl and persistent vm-script share one scope; ours copies; the expected implementation copies as well |
| Redeclaration with any keyword | ✗ | ✓ | ✓ (matches the expected implementation) | — | ✗ | In node:repl and persistent vm-script, 21 of the 25 keyword pairs report `already declared`, and only `var` and `function` may replace each other; ours reserves a redeclaration notice that prints nothing; the expected implementation prints an extra warning when a `const` is declared again as `const` |
| Earlier functions unaffected by a later assignment without declaration | ✗ | ✓ | ✓ (matches the expected implementation) | — | ✗ | |
| Assigning to an earlier `const` without declaring it again | ✗ | ✓ | ✓ (matches the expected implementation) | — | ✗ | node:repl and persistent vm-script report `TypeError`; ours prints nothing; the expected implementation prints a warning first |
| A `var` redeclaration reads the earlier value of its name (`var n = n + 1`) | ✓ | ✗ | ✓ (matches node:repl, persistent vm-script) | — | ✓ | node:repl and persistent vm-script only when the earlier declaration is also `var`, and report `already declared` after `let`; ours also after `let` or `const`; the expected implementation yields `NaN` |
| Earlier callers keep calling the old function after a redefinition | ✗ | ✓ | ✓ (matches the expected implementation) | — | ✗ | |
| Later calls see values earlier code assigns afterwards | ✓ | ✗ | ✗ (matches the expected implementation) | — | ✓ | A timer-incremented variable read twice 30 ms apart: node:repl 23, 50; persistent vm-script 22, 44; ours 0, 0; the expected implementation 15, 15 |
| Earlier functions see names declared later | ✓ | ✗ | ✗ (matches the expected implementation) | — | ✓ | Ours reports `ReferenceError` |
| Changes inside an object visible on both sides | ✓ | ✓ | ✓ (matches node:repl, the expected implementation, persistent vm-script) | — | ✓ | |
| A name stays usable after its initializer throws | ✗ | ✓ | ✓ (matches the expected implementation) | — | ✗ | In node:repl and persistent vm-script a new name stays unusable, and declaring it again reports `already declared`; ours falls back to the earlier value for existing names and drops new names |
| Declarations completed before a throw are kept | ✓ | ✓ | ✓ (matches node:repl, the expected implementation, persistent vm-script) | — | ✓ | |
| A `var` redeclaration not reached before a throw keeps the old value | ✓ | ✓ | ✓ (matches node:repl, the expected implementation, persistent vm-script) | — | ✓ | Ours copies the earlier value into the call's `var`, which also keeps it through an untaken branch; the expected implementation inserts marker code to achieve this |
| A new `var` declared in a block is carried to later calls | ✓ | ✗ | ✓ (matches node:repl, persistent vm-script) | — | ✓ | Ours collects block-level `var` declarations |
| A block-level `var` with the same name as an earlier `let` is accepted | ✗ | ✗ | ✓ (matches none of node:repl, the expected implementation, persistent vm-script) | — | ✗ | node:repl and persistent vm-script report `already declared`; ours treats it as the call's new declaration; the expected implementation reports `already declared` as well |

**Environment**

| Capability | node:repl | Ours (strict, default) | Ours (non-strict) | vm-script | Persistent vm-script | Notes |
|---|---|---|---|---|---|---|
| Strict mode | ✗ | ✓ (matches none of node:repl, vm-script, persistent vm-script) | ✗ (matches node:repl, vm-script, persistent vm-script) | ✗ | ✗ | With the option off, a program's own leading `"use strict"` still applies |
| Assigning an undeclared name creates a global | ✓ | ✗ (matches none of node:repl, vm-script, persistent vm-script) | ✓ (matches node:repl, vm-script, persistent vm-script) | ✓ | ✓ | Without strict mode the global is shared by every call and earlier function and is not copied |
| Top-level `var` and `function` become `globalThis` properties | ✓ | ✗ (matches none of node:repl, vm-script, persistent vm-script) | ✗ (matches none of node:repl, vm-script, persistent vm-script) | ✓ | ✓ | |
| Top-level `this` is `globalThis` | ✓ | ✗ (matches none of node:repl, vm-script, persistent vm-script) | ✓ (matches node:repl, vm-script, persistent vm-script) | ✓ | ✓ | Ours is `undefined` in strict mode |
| Top-level `arguments` | ✗ | ✓ (matches none of node:repl, vm-script, persistent vm-script) | ✓ (matches none of node:repl, vm-script, persistent vm-script) | ✗ | ✗ | Ours is an empty arguments object |
| `eval` and `new Function` | ✓ | ✗ (default; matches none of node:repl, vm-script, persistent vm-script) | ✗ (default; matches none of node:repl, vm-script, persistent vm-script) | ✓ | ✓ | Can be turned on; limits only the context's own functions, while copied main-realm functions still generate code |
| WebAssembly compilation | ✓ | ✗ (default; matches none of node:repl, vm-script, persistent vm-script) | ✗ (default; matches none of node:repl, vm-script, persistent vm-script) | ✓ | ✓ | Same option as `eval` |
| Node globals (`setTimeout`, `Buffer`, `fetch`, `URL`, `structuredClone`) | ✓ | ✓ (matches node:repl, vm-script, persistent vm-script) | ✓ (matches node:repl, vm-script, persistent vm-script) | ✓ | ✓ | |
| `require`, `module`, and built-in module globals such as `fs` | ✓ | ✗ (matches vm-script, persistent vm-script) | ✗ (matches vm-script, persistent vm-script) | ✗ | ✗ | Only `import()` |
| Relative `import()` follows later directory changes | ✓ | ✗ (matches none of node:repl, vm-script, persistent vm-script) | ✗ (matches none of node:repl, vm-script, persistent vm-script) | ✓ | ✓ | Ours keeps the directory of the environment's first call |
| `_` and `_error` | ✓ | ✗ (matches vm-script, persistent vm-script) | ✗ (matches vm-script, persistent vm-script) | ✗ | ✗ | |
| Code starting with `{ a: 1 }` is an object literal | ✗ | ✗ (matches node:repl, vm-script, persistent vm-script) | ✗ (matches node:repl, vm-script, persistent vm-script) | ✗ | ✗ | node:repl treats it as an object; the existing REPL evaluator forces a block |

**Errors**

| Capability | node:repl | Ours | vm-script | Persistent vm-script | Notes |
|---|---|---|---|---|---|
| Accurate error positions (code without `await`) | ✓ | ✓ (matches node:repl, vm-script, persistent vm-script) | ✓ | ✓ | Ours excepts the final expression's line |
| Accurate first-line positions in code with `await` | ✗ | ✓ (matches none of node:repl, vm-script, persistent vm-script) | ✗ | ✗ | node:repl and both vm-script columns report column 22 as column 54 |
| Syntax errors show the source line and caret | ✓ | ✓ (matches node:repl, vm-script, persistent vm-script) | ✓ | ✓ | Ours lays out acorn's position; this is evaluator behavior, and through `run_code` the host's TypeScript erasure reports most syntax errors first, matching the node:repl column |
| Syntax error messages are V8's wording | ✓ | ✗ (matches none of node:repl, vm-script, persistent vm-script) | ✓ | ✓ | Ours uses acorn's message, and V8's wording for errors acorn accepts and V8 rejects |
| Incomplete code gets a clear message | ✗ | ✓ (matches vm-script, persistent vm-script) | ✓ | ✓ | node:repl reports an empty message; through `run_code` the host's erasure reports it first as well |
| Errors carry the error name and stack | ✓ | ✓ (matches node:repl, vm-script, persistent vm-script) | ✓ | ✓ | |
| `Uncaught ` prefix on synchronous and awaited failures | ✓ | ✗ (matches vm-script, persistent vm-script) | ✗ | ✗ | |
| `Uncaught ` prefix on asynchronous callback failures | ✓ | ✓ (matches node:repl) | — | — | Both vm-script columns end the process instead of reporting |

**Asynchronous failures and lifecycle**

| Capability | node:repl | Ours | vm-script | Persistent vm-script | Notes |
|---|---|---|---|---|---|
| A callback failure after an evaluation keeps the process and variables | ✓ | ✓ (matches node:repl) | — | ✗ | Persistent vm-script exits, the next call reports `worker-exit`, and every variable is lost; without persistence the process has already closed; a callback throwing a frozen object ends the process in node:repl and ours |
| A callback failure during an evaluation fails only that evaluation and keeps variables | ✓ | ✓ (matches node:repl) | ✗ | ✗ | Both vm-script columns exit with `worker-exit`, and persistent vm-script loses its variables |
| Output printed after an evaluation ends is discarded | ✓ | ✓ (matches node:repl, persistent vm-script) | — | ✓ | |
| Variables can survive a timeout or cancellation | ✓ | ✓ (matches node:repl, persistent vm-script) | — | ✓ | Requires the program to acknowledge the stop |
Sources: the node:repl, vm-script, and persistent vm-script columns come from running master's evaluators directly (Node v24.18.0). Persistent vm-script reuses one evaluator; its single-call rows equal vm-script's, and its cross-call rows and the two asynchronous rows were measured separately, the asynchronous ones through a real child process. `scoped-repl.spec.ts` tests the cross-call items of the "ours" column and `scoped-repl-evaluator.spec.ts` the rest. The two asynchronous rows of vm-script without persistence are inferred from the current implementation; node:repl, persistent vm-script, and ours share the host's timeout, cancellation, and reset behavior. The expected-implementation column was measured on that implementation with a fresh environment per case.

### Context and options

One evaluator owns one context. With the `codeGeneration` option off, the default, it is created as:

```ts ignore-check
const runtimeContext = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } })
```

- Node globals are copied by the same rule as `createScriptContext` in `vm-script`: every own property of the main `globalThis` that the new context lacks, with `global` pointing at the new context. The evaluator file contains its own copy of these lines and leaves [vm-script.ts](../../../../packages/ptc-runtime/ptc-runtime-node/src/evaluators/vm-script.ts) unchanged.
- The child still writes `tools`, binding error classes, `console`, and `process` to `evaluator.globals`, which is `runtimeContext`, before each evaluation.
- The sandbox object has no prototype, as in the vm-script and AsyncFunction evaluators, so global lookups do not reach the main realm's `Function` through a prototype chain, as `constructor.constructor("…")()` would. Main-realm values copied into the context, such as `setTimeout`, `console`, `process`, and tool namespaces, still have the main realm's `Function` as their `constructor`, and the main realm has no `codeGeneration` limits, so the option restricts only the context's own `eval`, `Function`, and WebAssembly and is no isolation; the process sandbox provides isolation.
- Only dynamic `import()` loads modules, with no option: each Script gets `importModuleDynamically`. There is no `require`, `module`, or built-in module global; host bindings under those names stay available unchanged. Static `import` is unsupported.
- The generated filename is `<directory>/.ptc-repl-<number>.js`; no file exists at that path, and the name starts with a dot as a hidden file. The directory is the working directory when the evaluator is created, which is the directory of the environment's first call, and never changes. Node's default loader uses the filename as the `import()` referrer, so relative imports always resolve from that directory, and the directory cannot be left out. Following later directory changes would need an explicit operation, such as `js_switch_cwd`.
- Values from bindings and imports belong to the main realm, so cross-realm checks such as `instanceof Array` can be false, as with the REPL and `vm-script`.

The three options are evaluator creation parameters, not Config fields:

```ts ignore-check
interface ScopedReplEvaluatorOptions extends ProgramEvaluatorOptions {
  /** Force strict mode for every program; when off, a program's own leading "use strict" decides. Defaults to true. */
  strict?: boolean
  /** Allow eval, new Function and WebAssembly compilation inside the program context; defaults to false. */
  codeGeneration?: boolean
  /** Use the last top-level expression statement as the completion value; defaults to true. */
  finalExpression?: boolean
}
```

| Option | On | Off | Notes |
|---|---|---|---|
| `strict` (default on) | The whole Script starts with `"use strict";`, so every call runs strict | Not forced: when a program starts with a `"use strict"` directive, the inner function body starts with `"use strict";`, so the copy declarations cannot void it; other programs run sloppy | acorn scans with script rules in both states, and V8 reports strict-mode syntax violations at compilation. When off, in calls that run sloppy, assigning an undeclared name creates a global that every call shares without copies, top-level `this` is `globalThis`, and a name declared with a strict-mode reserved word such as `package` makes later strict calls fail to compile; see Risks |
| `codeGeneration` (default off) | The context is created without the `codeGeneration` limits | The context is created as above | When on, a `var` declared inside `eval` is not in the scanned list and is not carried; when off, it still restricts only the context's own code generation and is no isolation |
| `finalExpression` (default on) | The final expression becomes `return { value: (…) }` | No rewrite; the final value is discarded and the result is empty | When off, output comes only from printing; model guidance and consumers of the completion value, such as workflow-ptc, must change; top-level `return` fails in both states |

The integration uses the default of every option; the other values are intended uses kept by design, and each has tests.

### Wrapper

Each call compiles to its own `vm.Script`. For example, after earlier calls left `a` (`const`), `b` (`let`), and `v` (`var`), the model writes:

```js
let c = a + b
c * 2
```

The compiled source is:

```js
"use strict";(function (__$binding_vals, __$binding_getters) { return async function () { let a = __$binding_vals[0]; let b = __$binding_vals[1]; var v = __$binding_vals[2]; __$binding_getters.push(() => a, () => b, () => v, () => c);
let c = a + b
return { value: (c * 2) }
} })
```

| Part | Contents | Reason |
|---|---|---|
| `"use strict";` | With the `strict` option on, the whole Script is strict; when off, it is omitted, and a program that starts with `"use strict"` gets one at the start of the inner function body instead | On forces strict mode; off keeps the copy declarations from voiding the model's directive |
| Outer `function (__$binding_vals, __$binding_getters)` | Receives the copied values and an empty array and returns the inner function; the evaluator calls it synchronously | The internal values reach the program through a closure and stay out of its `arguments`; the outer function returns before the program runs, so its frame never appears in program stacks |
| Inner `async function ()` | The model's program is its body | Supports top-level `await`; top-level declarations are function locals, so calls never conflict; it is called without a receiver and without arguments, so `this` is `undefined` (`globalThis` when the program runs sloppy) and `arguments` is an empty arguments object |
| Copy declarations | Generated only for names that earlier calls left and this call does not declare or declares again only with `var`; values come from `__$binding_vals` by index | Index access is unaffected by names such as `__proto__` |
| `__$binding_getters.push(...)` | Before the model's code, pushes one read function per name, copied or declared, in the order the evaluator generated | The evaluator maps the i-th read function to the i-th name, so the prefix needs no name strings; a read function can be created early and read later, and it throws while its declaration is uninitialized |
| Final expression | Inserts `return ` before the statement, `{ value: (` before the expression, and `) }` after it | The same handling of the last statement as Node's `processTopLevelAwait`; the box keeps the async function from awaiting a returned Promise |
| Prefix on line 0 | Compiled with `lineOffset: -1` | Line N of the model's code reports as line N |
| Closing on its own line | `} })` | The model's last line can end with a `//` comment |

A copy declaration exists when the call does not declare the name or declares it again only with `var`; when the call declares it with `let`, `const`, `class`, or `function`, there is no copy and the call's declaration wins. Copy keywords:

| Case | Generated copy |
|---|---|
| Not declared by this call; earlier `let`, `const`, `function`, or `class` | `let` |
| Not declared by this call; earlier `var` | `var` |
| Declared again by this call only with `var` | `var` |

A copy only carries the earlier value in, and writing it as `const` would only forbid later calls from assigning to it, so an earlier `const` is copied as `let` too: later calls can assign to it, changing only the copy, while it stays `const` in the call that declares it. The kernel does not check whether a call assigns the name, so it needs no syntax-tree walk and prints no warning.

A call that declares a name again only with `var` gets a copy too: repeated `var` declarations in one function are one variable, so that `var` starts from the earlier value and a declaration that does not run never replaces it with `undefined`, as a global `var` behaves in node:repl. A `function` of the same name in the same call initializes at the start of the function and takes precedence over the `var`, so it gets no copy.

Compilation and execution:

```ts ignore-check
// Kernel: ScopedReplScopes.compile
const factory = new Script(source, { filename, lineOffset: -1, ...importOption }).runInContext(context) as ScopedReplFactory
const getters: (() => unknown)[] = []
const program = factory(values, getters)
this.compiled = { bindings, getters, replaced }
return program

// Evaluator: evaluate
const filename = resolve(baseDirectory, `.ptc-repl-${++submissions}.js`) // baseDirectory: process.cwd() at creation
const program = scopes.compile(code, { filename, context, finalExpression, ...importOption })
const start = Reflect.apply.bind(undefined, program, undefined, []) as ScopedReplProgram
void programDomain.run(() => Promise.resolve().then(start)).then(
  (completion) => { finish({ ok: true, value: completion?.value }) },
  (error: unknown) => { finish({ ok: false, error }) },
)
```

- The kernel always compiles with `filename` and `lineOffset: -1`, and the evaluator always passes `importModuleDynamically`: `VmModuleImportLoader.forFile(filename)` with an import handler, otherwise `vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER`.
- A microtask calls the program directly, so synchronous throws carry no evaluator frames. The host receives the result with `.then` rather than `await`, which would append a host async frame.
- Measured: `this` is `undefined`, `arguments.length` is 0, and a synchronous throw's stack holds only the program's frame; the domain catches timer errors from programs started this way; a boxed Promise is returned without being awaited.
- Any occurrence of `__$binding_` in the code, including strings and comments, reports `SyntaxError: Names starting with '__$binding_' are reserved` at the first occurrence, and nothing runs.

### Kernel: scope chain, acorn scan, and compilation

The kernel depends only on acorn and `node:vm`, not on the child process or the evaluator, so its tests compile and run consecutive programs in a plain vm context to check scope layering on their own. Its interface:

```ts ignore-check
class ScopedReplScopes {
  constructor(options: { strict: boolean; onRedeclaration?: (redeclarations: readonly ScopedReplRedeclaration[]) => void })
  /** Scan and compile one program against the current bindings; throws SyntaxError and leaves the chain unchanged. */
  compile(code: string, options: { filename: string; context: Context; finalExpression: boolean; importModuleDynamically?: ScriptOptions['importModuleDynamically'] }): ScopedReplProgram
}
type ScopedReplProgram = () => Promise<{ value: unknown } | undefined>
interface ScopedReplRedeclaration { name: string; previous: ScopedReplBindingKind; current: ScopedReplBindingKind }
type ScopedReplBindingKind = 'var' | 'let' | 'const' | 'function' | 'class'
interface ScopedReplBinding { name: string; kind: ScopedReplBindingKind }
interface ScopedReplScan {
  /** Top-level bindings declared by the program, in source order. */
  declarations: ReadonlyMap<string, ScopedReplBindingKind>
  /** Whether the program starts with a "use strict" directive. */
  useStrict: boolean
  /** Last top-level statement when it is an expression statement. */
  finalExpression?: { statementStart: number; expressionStart: number; expressionEnd: number }
}
/** Parse once; throws a SyntaxError laid out like V8's for every error acorn reports. */
function scanProgram(code: string, options: { filename: string }): ScopedReplScan
/** Build the Script source and every binding in the order of the read functions it pushes. */
function buildProgramSource(
  code: string, scan: ScopedReplScan, carried: readonly ScopedReplBinding[], options: { strict: boolean; finalExpression: boolean },
): { source: string; bindings: ScopedReplBinding[] }
```

**Parsing**: regardless of the `strict` option, the kernel calls `parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowAwaitOutsideFunction: true })`. These rules mostly match an async function body: top-level `await` is valid, top-level `return` is a syntax error, and two `function` declarations of one name, or a `var` and a `function` of one name, are valid. They differ in rejecting top-level `using`, `await using`, and static `import` and `export`. The scan does not decide strictness: with the option on, the Script's leading `"use strict";` does, and V8 reports strict-mode syntax violations at compilation.

Before parsing, the kernel checks two things: a program that starts with `#!`, or any occurrence of `__$binding_`, reports an error, and the code is not parsed.

**One parse yields four things**:

1. The call's own top-level declarations, from top-level statements only:

   | Top-level statement | Collected names | Recorded keyword |
   |---|---|---|
   | `const`, `let`, and `var` declarations, including destructuring (objects, arrays, defaults, rest elements) | Every bound name | The original keyword |
   | `function` declarations, including async and generator functions | The function name | `function`; a `var` of the same name in the same call is recorded as `function` too |
   | `class` declarations | The class name | `class` |
   | `var` in the head of `for (var …; …; …)` and `for (var … in/of …)` | Every bound name | `var` |
   | `var` inside blocks, `try`/`catch`/`finally`, `if`/`else`, loop bodies, `switch`, labeled statements, and `with`, including `for` heads there; nested functions and classes are skipped | Every bound name | `var` |

2. Whether a top-level `return` exists: acorn reports `'return' outside of function` with its position.
3. The last statement: skipping empty statements from the end, the first statement found, if it is an expression statement, records the statement's and expression's offsets.
4. Whether the leading directives include `"use strict"`: acorn marks directive statements with `directive`, and the kernel records `useStrict`.

Out of scope: no search inside nested functions and classes; inside blocks only `var` is collected, while `let`, `const`, `class`, and `function` stay in their blocks; no reference analysis and no assignment search; no rewriting besides the three insertions around the final expression.

**Syntax errors**: when acorn fails, the kernel throws a `SyntaxError` directly without a V8 compilation. Its `stack` follows V8's layout:

```text
/work/.ptc-repl-3.js:1
const x = ;
          ^

SyntaxError: Unexpected token
```

- The message is acorn's text without its trailing `(line:column)`.
- Two messages use V8's wording: `'return' outside of function` reports `Illegal return statement`, and an error positioned at the end of the code reports `Unexpected end of input`.
- An occurrence of `__$binding_` reports an error with the same layout at its first position.

### Scope chain state and the steps of a call

`ScopedReplScopes` holds:

- `bindings: Map<string, { kind: ScopedReplBindingKind; read(): unknown }>`: the names available for copying and their read functions. `kind` is the keyword of the name's most recent declaration; a name that is only copied keeps its recorded keyword, so a `function` copied as `let` stays `function`.
- `replaced: ReadonlyMap<string, { kind: ScopedReplBindingKind; value: unknown }>`: the values that names redeclared by the most recently adopted program had when it was compiled.
- `compiled`: the binding order, read-function array, and `replaced` values of the most recently compiled program.

Each `compile(code, options)`:

1. Adopts `compiled`: when the read-function array holds at least one function per name, that program's prefix has run, so `bindings` maps the i-th name to the i-th read function and `replaced` takes its values. The child rejects overlapping evaluations (`overlapping PTC evaluation`), so the previous prefix always runs in a microtask before the next compilation; only two compilations in one synchronous run leave the first program unadopted.
2. Scans the program for its declarations and final expression; a syntax error is thrown and the state stays unchanged.
3. Calls every read function in `bindings` for its current value. When a read throws because its declaration never finished, the value from `replaced` is used; without either, the name is dropped.
4. Copies names the call does not declare or declares again only with `var`, and collects their values in `values`; for existing names the call declares, records the value in the new `replaced` and a redeclaration `{ name, previous, current }`.
5. Generates and compiles the source. With the `strict` option off and `useStrict` true, the inner function body starts with `"use strict";`. A V8 compile failure throws the native `SyntaxError` without the compiler frames after the error heading (the same handling as `vm-script`, in a separate copy) and leaves the state unchanged.
6. Calls `onRedeclaration(redeclarations)` when there are redeclarations.
7. Calls the outer function for the program, records `compiled`, and returns the program.

Each evaluator `evaluate(code, finish)`:

1. Increments the submission number, including for submissions with syntax errors; the filename is `<directory at creation>/.ptc-repl-<number>.js`.
2. Calls `scopes.compile`; a thrown error ends the evaluation.
3. Starts the program from a microtask inside the domain and calls `finish` when its Promise settles, taking `completion?.value` without further awaiting.

Reads happen in kernel step 3, when a new program is compiled. Later assignments by earlier code change only that code's own variables.

### Failed calls

| Call | Code | Result |
|---|---|---|
| 1 | `const data = 1` | `data` is 1 |
| 2 | `const data = await tools.fetch()`, where `fetch` throws | Fails; call 2 declared `data` but never initialized it |
| 3 | `data` | 1: reading call 2's `data` in kernel step 3 throws, so the value recorded when call 2 was compiled is used |
| 4 | `let fresh = await tools.fetch()`, which throws | Fails; `fresh` is a new name |
| 5 | `typeof fresh` | `"undefined"`: there is no earlier value, so the name is dropped |

- Declarations completed before a throw are kept. For example, after `let y = 5` runs and the call then throws, `y` is still 5 in later calls.
- A `var` redeclaration starts from the copied earlier value, so reading it never throws and needs no fallback: an unreached `var` keeps the earlier value. For example, when call 2 throws before `var v = 6`, or the tool call in `var config = await tools.loadConfig({})` fails, later calls still read the earlier value. A `function` name holds the new function from the start of the call.

### Asynchronous failures: aligned with the REPL

The REPL catches errors from the asynchronous work a program starts with Node's `domain`. The evaluator does the same:

- On creation, the evaluator calls `domain.create()` for `programDomain` and starts every program inside `programDomain.run(...)`. Timers, callbacks, Promise continuations, and EventEmitters that the program creates belong to that domain.
- `programDomain.on('error', ...)` passes `Uncaught ` followed by the error text to `options.reportError`. The text is the error's `stack`, or `name: message` when the stack is not a string; errors are not formatted with `util.inspect` because the domain adds `domain` and `domainThrown`, which inspect would print. A value that is not an error is formatted with `util.inspect` after deleting those two properties, as node:repl does.
- Programs can make this formatting throw through a `stack` accessor, `toString`, or custom inspection. A throw from the listener would end the process, so the formatting runs in `try`/`catch` and a failure reports `program threw an unrenderable value`, the same fallback text as `prepareException` for synchronous failures. The `reportError` call stays outside the `try` because it is the child's own code, whose failures must surface.
- When a callback throws a frozen or non-extensible object, Node's domain fails to add its properties before calling the listener, and the process ends, as with node:repl.
- The child handles `reportError` unchanged: an active evaluation fails with the error; otherwise the error is discarded. Errors belong to the evaluation that created their callback (AsyncLocalStorage).
- No process-wide `uncaughtException` or `unhandledRejection` handler is registered, so errors in the child's own code still surface.
- When a program calls a tool, the asynchronous callbacks that the child creates for the call, such as RPC callbacks, also belong to the program's domain: an asynchronous error in the child's own code inside those callbacks is reported as the program's `Uncaught …` failure, and the child keeps running. The existing REPL evaluator behaves the same.

Verified cases:

- REPL: timer throws and unhandled Promise rejections are caught both after and during an evaluation; an EventEmitter `error` event is caught after an evaluation.
- A standalone domain: in the main realm it catches timer throws, rejections created in timers, failures of unawaited async functions, and EventEmitter `error` events; in a context with the default `codeGeneration` limits it catches timer throws and rejections created in timers; timer throws from programs started by a microtask are caught too.

### Dynamic import

- A program's `import()` goes through its Script's `importModuleDynamically`: `vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER` without an import handler, and the existing `VmModuleImportLoader.forFile(filename)` with one, as in `vm-script`.
- Relative specifiers resolve from the directory where the evaluator was created, which is the working directory of the environment's first call; later directory changes do not move it. node:repl and `vm-script` follow each call's directory; after the Agent changes directory with `working_directory`, import with an absolute path to use the new directory.
- There is no `require`: node:repl's `require` resolves inconsistently (relative paths follow the current directory but are cached after their first resolution; packages resolve from the startup directory), so dynamic `import()` is the only way to load modules.

### Redeclaration notice (reserved)

The kernel calls `onRedeclaration` in step 6; the evaluator injects its `reportRedeclarations(redeclarations: readonly ScopedReplRedeclaration[])`, whose body stays empty with one `TODO` comment and prints nothing. A future notice writes to the program's `console` here, which makes it model-visible output.

### Out of scope

- Memory reclamation: not handled; every call copies every name. Earlier calls without surviving closures are collected; when a call leaves a surviving function, that function keeps every value copied into that call.
- Resolving `import()` from the working directory as it changes: an explicit operation such as `js_switch_cwd` can be added when needed.
- Reading the earlier value of a name in its own `let`, `const`, or `class` redeclaration, such as `let count = count + 1`: a program error.
- Problems from mixing strict and sloppy calls with the `strict` option off, listed under Risks: left to a future reset tool.
- The column shift on the final expression's line.

### Integration

The `scoped-repl` format connects the evaluator with only the changes the connection requires, without refactoring or reusing existing code, so rebases and merges with other ongoing PTC work stay simple. The program format is `scoped-repl` and the Config field is `replScoped`.

| Location | Change |
|---|---|
| `PtcProgramFormat` in `ptc-runtime` | Includes `'scoped-repl'` |
| `config.ts` in `ptc-runtime-node` | The boolean field `replScoped`, default false, accepted only with `persistent-in-memory` and rejected at load otherwise |
| `execution.ts` in `ptc-runtime-node` | In the `persistent-in-memory` branch with `replScoped`, format `scoped-repl`, `retainsState` true, REPL-statement TypeScript erasure, and new model guidance |
| `evaluators/index.ts` in `ptc-runtime-node` | The evaluator table maps `scoped-repl` to this evaluator with the default of all three options |
| `protocol.ts` in `ptc-runtime-node` | The protocol version is 3, so older bootstraps fail at readiness; the upgrade guide `docs/upgrade-guide/v0.2.2-rc.1/ptc-bootstrap-protocol/` also covers the new `PtcProgramFormat` member |
| `host.ts` in workflow-ptc | `scoped-repl` uses the same wrapper as `repl`, `await (async () => {…})()` |
| `configuration.ts` in `ptc-runtime-node` (used by CUA to merge settings) | `resolvePersistentExecution` returns `executionMode`, `scriptPersistence`, and `replScoped` to merge together: `scoped-repl` yields `replScoped: true` and every other format `false`, replacing a stale profile value |
| Documentation, snapshots, and tests | Package README configuration, behavior, and known limitations; the config catalog; the snapshot scenario `ptc-scoped-repl`; a built-artifact e2e case with `replScoped: true` |

tool-executor-ptc is unchanged: for every format other than `function-body` it uses its printing guidance. The model guidance states the exact behavior above, especially: output uses `inspect(...)`, in a sentence shared with the other modes; top-level `return` is unsupported; copies happen when a call starts and earlier code is unaffected; shared mutable state belongs in objects; an assignment without declaration changes only the copy, including for earlier `const` names; a `let`, `const`, or `class` redeclaration cannot read the earlier value of its name, so assign to the name or use a new one to compute from it; a `var` redeclaration starts from the earlier value; when a call fails, an unfinished `let`, `const`, `class`, or `var` redeclaration keeps the earlier value; a `var` inside a block is also a top-level name of the call, while other block declarations stay in their block; modules load only with `import()`, whose relative specifiers resolve from the directory of the environment's first call. Tests pin the model guidance verbatim.

## Alternatives considered

**Nesting each call in the previous call's scope with direct eval.** Calls can share live bindings, but earlier scopes are never reclaimed, positions require a source map or stack rewriting, and direct eval is unavailable in a context that forbids code generation from strings.

**Rewriting declarations as `var` or global assignments.** Every call shares one binding, which violates requirement 2, and model code must be rewritten.

**Compiling each call as an ES module.** Each module receives values through a synthetic module for the previous call and an appended `export`. Modules allow neither `return` nor a final value, and the prelude shifts every reported line; function parameters already pass values without modules.

**Scope analysis with rewritten references.** Allows finer memory reclamation, but needs scope analysis and code rewriting, which violates requirement 5.

**Printing only, without a final expression.** workflow-ptc and the `repl` format contract depend on completion values, and it departs from the existing REPL syntax.

**Results from top-level `return`.** Conflicts with requirement 3, requires the function-body format, and changes the run_code guidance.

**Awaiting a final Promise.** Matches `vm-script` but not the existing REPL; boxing as Node does keeps the REPL behavior.

**Results for programs ending with `if`, `for`, or a block.** Only Script top-level code has V8 completion values, which a function body lacks; supporting them requires rewriting more statements. node:repl has no result there either when the code contains `await`.

**Writing the wrapper as `async function (__$binding_vals, __$binding_getters)`.** `this` is also `undefined`, but the program's `arguments` exposes both internal values and has length 3.

**An async arrow wrapper.** `this` is `globalThis` and `arguments` does not exist, as in the REPL; ours uses `undefined`, as a strict function call without a receiver does.

**Returning read functions through a callback.** The prefix would need name strings and protection against repeated calls; pushing into an array that the evaluator maps by index is simpler.

**Recompiling with V8 for syntax errors.** Yields V8's wording at the cost of another compilation; acorn already provides the position and message.

**Module rules for strict programs.** Module rules are stricter than an async function body: two `function` declarations of one name, a `var` and a `function` of one name, and `await` as a variable name in a nested ordinary function are rejected, and HTML-like comments are handled differently from V8's Script compilation. They are unusable with strict mode off, because module code is always strict.

**Scanning inside the same function wrapper as the runtime.** Matches the runtime grammar exactly and accepts top-level `using`, as Node's `processTopLevelAwait` does. It requires a statement walk to find top-level `return`, position mapping for the wrapper, and a guard against an extra `}` in the code closing the wrapper early; top-level `using` is not needed, so script rules are simpler.

**Copying only assigned `const` names as `let`, with a warning.** This walks the new call's syntax tree and tracks shadowing, which is scope analysis and violates requirement 5. Ours copies every `const` as `let` without a notice.

**Starting a `var` redeclaration from `undefined` without a copy.** `var count = count + 1` then yields `NaN`, but a `var` not reached before a throw or in a branch that is not taken replaces the earlier value with `undefined`; for example, a failed tool call in `var config = await tools.loadConfig({})` leaves later calls without the earlier `config`. With the copy, `var count = count + 1` adds to the earlier value, as in node:repl, which is accepted for now.

**Falling back only when a call failed and the value reads `undefined`.** It needs no copy, but cannot tell an unreached declaration from one that ran and assigned `undefined`: a call that assigns `undefined` and then fails falls back by mistake, and an untaken branch or `var x;` without an initializer in a successful call is not covered.

**Marking in the code whether each `var` ran.** It distinguishes the cases exactly but rewrites model code at declarations, earlier assignments, and loop heads, which violates requirement 5.

**Skipping copies of strict-mode reserved words in strict calls.** It would keep names such as `package`, declared in a sloppy call, from breaking later strict calls; the problem comes from the model mixing both modes, so it is left to a future reset tool.

**A process-wide handler for uncaught errors.** It would also swallow errors from the child's own code; the REPL's domain covers only the asynchronous work programs start.

**Not collecting `var` declarations inside blocks.** A block-level `var` then collides with the copy declarations, so the whole program reports `already declared`, and the name is not carried to later calls; collecting it takes about 15 lines of statement traversal without reference analysis, so the scanner collects it.

**Showing only `.ptc-repl-<number>.js` in stacks, without the directory.** Without the directory, Node's default loader resolves relative `import()` specifiers from the current directory at import time, unlike calls with an import handler; a `//# sourceURL` comment that shows only the name makes V8 ignore `lineOffset`, so every line number grows by 1; handing imports to a callback would work, because both child launches pass `--experimental-vm-modules` and the callback can start `import()` from the first call's directory, but it requires scoped REPL imports to always go through a callback, which the default path does not do yet. The filename therefore keeps the directory of the first call for now.

**Providing `require`, `module`, and built-in module globals, as node:repl does.** node:repl's `require` resolves inconsistently, and following directory changes needs a rule for when the base moves; only `import()` remains.

## Consequences

Gains:

- Later calls may declare an earlier name again with any keyword, while earlier functions, closures, and still-running code keep their values.
- Syntax, results, errors, and asynchronous failure handling match the existing REPL, and asynchronous program failures do not end the process.
- There is no scope analysis, and model code is rewritten only at the three insertion points of the final expression.

Costs:

- Copying at call start differs from the REPL: assignments that earlier code, such as timers and callbacks, makes to top-level variables afterwards are invisible to later calls; the model guidance states this.
- An assignment without declaration affects only later calls and is invisible to earlier functions; in the REPL both sides change.
- Strict mode differs from the REPL: assigning an undeclared name creates a global in the REPL and throws here.
- For callers that keep completions, a final Promise without `await` makes the host report a non-JSON completion, as in the existing REPL; `run_code` discards completions and is unaffected.
- Programs ending with `if`, `for`, or a block have no result, while node:repl has one when the code contains no `await`.
- On the final expression's line, columns after the insertion point shift right by 17.
- Syntax error messages use acorn's text, which differs from V8's, for example `Unexpected token` instead of `Unexpected token ';'`.
- Scanning always uses script rules, so top-level `using` and `await using` are rejected; node:repl does not support them either.
- Top-level `arguments` is an empty arguments object, while it does not exist in node:repl.
- The context forbids code generation from strings by default: code relying on `eval` or `new Function` fails, including libraries loaded into this context through an import handler. The limit is no isolation, because copied main-realm functions such as `setTimeout.constructor` still generate code.
- There is no `require`: code that relies on it must use `await import()` instead.
- Relative `import()` keeps resolving from the directory of the environment's first call, also after the Agent changes directory.
- Node documents `domain` as deprecated; node:repl still builds on it, so a removal would change the REPL as well.
- An error in the child's own code inside a tool call's asynchronous callbacks is reported as the program's `Uncaught …` failure, and the child keeps running, as with the existing REPL.
- Programs that start with `#!` are rejected.
- Any occurrence of `__$binding_`, including in strings and comments, is rejected; internal names written with escapes such as `\u005f` are not checked.
- acorn must keep pace with V8's syntax, or newer syntax is rejected before it runs.
- A `var` redeclaration starts from the earlier value: `var count = count + 1` adds to it, as in node:repl, also when the earlier declaration was `let` or `const`, where node:repl reports `already declared`.
- A `let`, `const`, or `class` redeclaration cannot read the earlier value of its name and throws, as in `let count = count + 1`. This is a program error and is not handled.
- Every earlier `const` is copied as `let` into later calls, which can assign to it without any notice.
- With the `strict` option off, strict and sloppy calls can mix: a sloppy call that assigns an undeclared name creates a global shared by every call and earlier function, and a name declared in a sloppy call with a strict-mode reserved word (`package`, `public`, `private`, `protected`, `interface`, `implements`, `static`, `let`, `yield`, `eval`, `arguments`) makes later strict calls fail to compile. This is not handled and is left to a future reset tool.
- When a callback throws a frozen or non-extensible object, Node's domain handling fails and the process ends, losing retained variables, as with node:repl.
- Every call generates a copy declaration and a read function for every earlier name: the prototype measured about 10 ms per call with 1000 names.
- When a call leaves a surviving function, every value copied into that call stays in memory.

## Testing

- The kernel tests pass on their own and cover script-rule parsing and detection of a leading `"use strict"`, every statement in the declaration table, top-level `return` including inside blocks, locating and boxing the final expression, programs that start with `#!`, occurrences of `__$binding_`, the syntax-error layout with both message substitutions, and the generated source; with the `strict` option off, a leading `"use strict"` takes effect both with and without copies; running consecutive programs in a plain vm context, they cover every item under Across calls, including keyword combinations, failed calls, timers, function redefinition, and redeclaration notices.
- The evaluator tests use the evaluator and a real vm context and cover every item under Syntax and results, Environment, Errors, and Asynchronous failures and lifecycle, plus cross-call behavior through the evaluator, including that the global object's prototype chain does not reach the main realm's `Function` while copied main-realm functions such as `setTimeout.constructor` still generate code, and that host bindings named `module` or `require` stay untouched.
- Every option is tested on and off.
- Top-level `this` is `undefined`, `arguments.length` is 0, and a synchronous throw's stack holds only the program's frames.
- Asynchronous failures: each listed case is tested after and during an evaluation; the text passed to `reportError` starts with `Uncaught `; the process keeps running and variables are retained. A missing `stack`, a throwing `stack` accessor, and throwing custom inspection report `name: message` or the fixed text without ending the process; a thrown plain object is reported without `domainThrown`.
- Imports: both the default loader and an import handler; relative specifiers resolve from the directory at creation, also after the working directory changes.
- The built-artifact e2e covers `replScoped: true`.
- New files have 100% coverage; existing evaluators and their tests are unchanged.
