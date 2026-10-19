# Defensive patterns

English | [中文](general.zh.md)

Hard-won bug-class rules: each pattern below is a class of defect that actually shipped or nearly shipped here, stated as the rule that prevents its recurrence. Read this before writing lifecycle, concurrency, subprocess, or teardown code. Test-tier counterparts (real entry path, world-verification, resource ownership) are in [testing.md](../testing.md); the type-level definitions these rules refer to live in [subsystems/](../subsystems/README.md).

## Report orthogonal outcomes independently

A result can be several things at once — a process can time out AND exit 0 because it trapped the signal. Surface each independent fact (`timedOut`, `signal`, `exitCode`) on its own; never nest one flag's report inside another's branch, or a caller reads a cut-short run as a clean success.

A reviewer checks the reporting shape rather than the killing mechanism: can each fact be true independently, and is each one readable without entering another condition's branch? The boundary is the report — how the process is signalled or how long it is given is a separate decision.

## Honor public contracts on BOTH sides

When an implementation receives several representations of one outcome, normalize them before returning through the public API. `LlmAdapter.stream()` implementations may throw or emit `finish {kind:'error'|'aborted'}`, but `LlmRuntime.stream()` exposes model-request failures only as terminal finish chunks; middleware and consumer defects remain thrown. This keeps consumers from guessing whether a caught exception came from the provider, a wrapper, chunk logging, or their own assembly. Document the normalized contract where the type is defined; exercise every source form through the real consumer.

The judged condition is whether a consumer can name the source of a failure from the public API alone. Internal helpers stay free to throw: the requirement binds the boundary the consumer crosses, not every function behind it.

## Async state is not synchronous state

`agent.followup()` has no per-message completion or result; a background job's completion races turn boundaries; `reader.close()` fires for both EOF and disposal. Never treat `agent/status` or `whenIdle()` as the result of one follow-up: several queued follow-ups, steering, and injected work may share one `running` interval, while cancellation or disposal can discard unstarted items. An automation caller that truly owns a run must define its interval explicitly—for example, from its message's durable inbox receipt through the next whole-agent `idle`—and describe any selected output as interval-wide rather than causally attributed to that message. The guard cuts both ways: if the awaited transition can never occur, the wait hangs, so handle the "nothing to wait for" branch explicitly.

The judged condition is whether an agent can observe a per-unit completion the API does not define. Where the interval genuinely belongs to the caller, it is the caller that states the interval and the output scope; a shared `running` flag is never that statement.

## Timing does not carry correctness

Correctness comes from explicit call points and explicit state, never from where a callback lands in the event loop. A `microtask`, `setTimeout`, or `queueMicrotask` that decides whether work is correct races the rest of the program: it holds under a light load and silently fails under a busy one or when batching changes. React code follows the same rule — an effect never supplies a "just after render" ordering that the design should have made explicit.

The judged condition is whether correctness depends on "that callback already ran" instead of on a named call point or state machine. Two boundaries: a test's timeout budget waits for a failure and is not timing-dependent correctness, and a deliberate delay that only paces user-visible work is not this rule. There is no developer-side exception; a genuine need for a timing technique goes to the domain owner.

```ts
// The order is written into the code: dispose the old store, then build its successor.
declare let store: { dispose(): void }
declare function createStore(scopeKey: string): { dispose(): void }
declare const scopeKey: string

store.dispose()
store = createStore(scopeKey)
```

```ts ignore-check
queueMicrotask(() => { if (!ready) refresh() })   // assumes the microtask runs before the next frame
setTimeout(() => setMounted(true), 0)             // waits for a render that was never sequenced
```

The wrong form fails intermittently: a dropped refresh or a state that never syncs, reproducing only under load.

## Optional inputs state both behaviors

An optional parameter states what the callee does when it is present and when it is absent, so a caller reads both behaviors from the contract instead of inferring one from a defensive operator. Accumulating `?.` is the signal: each one substitutes for a decision about whether the field should exist at all.

The judged condition is whether `?.` replaces a determination that a field exists rather than handling a genuinely optional hop on a known value. The requirement binds the interface contract: both branches state their return value and their side effects, and the contract is where the caller reads them. There is no exception channel — a call site that cannot state both behaviors is a review blocker, not a style preference.

```ts
// Both behaviors are in the contract: no options object means "unknown", not "skip".
interface ResolveInput { options?: readonly string[] }
type Resolution = { kind: 'unknown' } | { kind: 'value'; value: string }

function resolve(input: ResolveInput): Resolution {
  if (input.options === undefined) return { kind: 'unknown' }
  return { kind: 'value', value: input.options.join(',') }
}
```

```ts ignore-check
const value = a?.b?.c?.d ?? fallback   // four layers of fallback hide whether d should exist
```

The wrong form keeps the contract vague and swallows the error, so the next caller adds another fallback on top.

## One value states one fact

An unknown value, an empty collection or string, and a genuinely absent field are three different facts and take three representations. One `undefined` or `null` never stands for several of them, and a consumer that must act differently on each discriminates explicitly instead of collapsing them at the boundary.

The judged condition is whether a single "no value" carries more than one semantic: not yet queried, queried and empty, and cannot be determined. A discriminated union or an explicit enum value is the ordinary implementation, documented where the type is defined in [core.md](../subsystems/core.md#repo-wide-type-patterns).

```ts
type ValueState<T> = { kind: 'unknown' } | { kind: 'empty' } | { kind: 'value'; value: T }
```

```ts ignore-check
return null   // means "not queried", "queried, nothing there", and "cannot tell", all at once
```

The wrong form leaves the caller unable to distinguish the cases, so UI states, cache policy, and retry decisions all go wrong.

## A new active/current singleton is refused

No new global `active` or `current` singleton is introduced, and existing ones are migrated out. A globally unique selection is a design statement this codebase does not make: several views of one piece of data each hold their own reference or key.

The judged condition is whether the change introduces a globally unique selected-state field. The replacement shape is one piece of data with several views over it, each view carrying its own reference. There is no default exception; where the concept genuinely exists once per service, a service or instance field expressed through `inject` carries it, never a module-level field.

```ts ignore-check
// Each view holds the key it renders; nothing global decides what is "current".
function ConversationView({ sessionKey }: { sessionKey: SessionKey }) { /* … */ }
```

```ts ignore-check
let activeTabId: TabId | undefined   // module-level; every component reads the same one
```

The wrong form makes independent instances interfere with each other, and no reviewer can audit which view owns the focus.

## Shared state has one owner

Shared state hangs on a service or an instance, so its owner is a named object with a lifecycle. A module-level cache, a singleton, a global `WeakMap`, or a `Symbol.for` / `globalThis` / `window.__X__` bypass hides that owner and outlives every teardown.

The judged condition: name the service or instance that owns the value; if no owner can be named, the owner is decided before the implementation. The boundary is that a field on a service or instance may be read by any number of injected consumers, and passing that value across domains goes through the existing interface rather than a global namespace. There is no default exception; a genuine need for a global lookup key goes to the domain owner together with its reclamation policy.

```ts
// The shared value hangs on the session service instance; consumers inject it.
interface Sessions { readonly current: string }
declare const ctx: { get(name: 'sessions'): Sessions }

const sessions = ctx.get('sessions')   // one owner, lifetime tied to the service
```

```ts ignore-check
globalThis.__dshCache = new Map()   // shared across instances, reclaimed never
```

The wrong form lets instances overwrite each other, makes reclamation timing unknowable, and leaks state between tests.

## A business capability owns itself

A business capability lives in its own package and attaches through a registration surface — a registry, `slots.inject`, a waterfall, or an event subscription. A runtime, controller, manager, or gateway carries generic orchestration: it may hold the registry structure and the disposal lifecycle, while the entries are written by the packages that own them, and it never hardcodes a central table of business rows.

Establish whether a new distinction, field, or adapter is needed before choosing its owner; moving an unnecessary concept does not remove its maintenance cost. For required behavior, prefer an existing extension point near its producer or consumer when the local implementation adds little complexity. A producer can declare a feature variant through [declaration merging](../subsystems/core.md#the-map--derived-union-pattern) in its own package, without editing the package that declares the shared type. Obligations common to all consumers belong in the shared owner.

The judged condition is whether the capability declares and registers itself, with the center layer only forwarding and managing lifetime rather than making business decisions. The boundary is that the center layer holds the registry structure and the disposal lifecycle while the entries come from the owning packages. One exception: pure infrastructure — logging, transport, storage — does not attach through a business registration surface. A new branch in a center layer must explain why it cannot live in the owning package.

```ts
// The business package registers its own slot and handlers in its apply.
interface Slots {
  inject(name: string, register: () => void): void
  register(name: string): void
}
interface Context { readonly slots: Slots }

export function apply(ctx: Context): void {
  ctx.slots.inject('conversation.footer', () => ctx.slots.register('conversation.footer'))
}
```

```ts ignore-check
if (pluginName === 'ui-attachment') { /* business branch inside the manager */ }
```

The wrong form makes every new capability edit the center layer, which becomes the change bottleneck and the conflict hotspot.

## Changes carry performance evidence

A change that can move the cost of a hot path measures the code it touched before and after and reports the numbers with their conditions. The three metrics are runtime, peak memory, and steady-state memory, measured in one environment on one input; the granularity is the changed path, not a whole-machine score. Reporting that "nothing got slower overall" is not evidence, and a path that improved elsewhere does not excuse a regression here — an optimised first paint still has to answer for `append`.

The judged condition: under one environment and one input, any of the three metrics is significantly worse on the changed path.

The baseline is the same path without the change under measurement — normally the native implementation that carries no measurement hook, not the previous implementation. Comparing old against new with the same hook attached on both sides dilutes the difference until it disappears: both sides pay the same overhead, so the measurement reports "no change" while both are slow.

Measurement is owned by [benchmarks/](../../benchmarks/AGENTS.md), one directory per measured user path, and its scenarios are the entry point:

```sh
# Run the owning scenario before and after the change; the numbers go into the PR.
pnpm run test:bench
```

Package-local diagnostics stay beside their owner with the `.perf.ts` suffix and do not join `test:bench`. The CI gate is `pnpm run check:ci:bench` (job `node 24 / benchmarks`), which publishes a scaled report — that gate is an alert, not a pass: a regression there is located by re-running the owning scenario and profiling segments locally to find which part slowed and which change introduced it. Retained-memory claims use `pnpm run test:bench:memory 4g|8g`, which reruns its listed files under an unchanged budget in a swapless cgroup.

Boundaries: edits that touch no runtime path — comments, documentation, test-only code — need no measurement, and production performance code is not benchmark instrumentation to be deleted opportunistically (`performance.now()` and `scheduler.yield()` are part of production decode and encode chunk scheduling). An architectural change that genuinely costs performance states the measured cost and the reason, and the domain owner approves it; "the layering needed it" is not a self-service reason. Record the command, the numbers, the environment, and the input size so the baseline can be rebuilt.

```text
CI benchmark reported green, so the change is accepted as performance-neutral.
```

That form ships a real regression in a path the benchmark does not model.

## Migrations preserve behavior

A migration or a package split keeps externally observable behavior equal: error codes, diagnostics, data-flow order, and UI timing are compared item by item. Moving code is preferred over deleting and rewriting it; a rewrite suits code whose semantics are changing anyway, and then the change lists its differences. A package or export-path change is a carrier change rather than a behavior change, and a behavior change is its own change.

The judged condition is the item-by-item comparison of observable behavior before and after. Where full equality is impossible, the change states the differing items and how each is verified, and the domain owner approves. A defect found during a migration is fixed as its own change rather than folded into the move.

```sh
# The move keeps paths and error codes; the reference updates are the whole diff.
git mv packages/old/src/endpoint.ts packages/new/src/endpoint.ts
```

```ts ignore-check
// The migration silently upgrades the error handling it was only supposed to move.
throw new EndpointError('not found')   // was: return { ok: false, code: 'not_found' }
```

The wrong form buries behavior changes inside a move, so review cannot separate the relocation from the semantics and regressions cannot be localized.

## Dispose must reach quiescence, not just request it

Await child exit after killing or aborting. Optional notifications may stop early; resources and listeners needed for completion or final persistence must survive until consumers settle. See the [Cordis ownership checks](../../.agents/skills/cordis-styling-nitpicking/SKILL.md#p0-cleanup-dependency-released-before-consumer-completion).

The judged condition is whether teardown awaits actual quiescence or only requests it. The boundary is work with no owner to await — a detached, unobserved task — which the teardown is not obliged to track; anything the component started and can still observe must be awaited before it reports completion.

## Contain callback exceptions in the dispatcher

Catch and report each listener's exception without rejecting the dispatch promise or starving later listeners. The listener's owner must handle state it mutates under the [error-handling rules](../../.agents/skills/dsh-error-handling/SKILL.md#catch-recover-or-stop); catching alone does not restore state.

The judged condition is whether a throwing listener can reject the dispatch promise or prevent later listeners from running. The boundary is the caller's own await: an error the dispatcher deliberately propagates to the operation that requested it is not a containment failure.

```ts
async function dispatch(listeners: ((event: string) => Promise<void>)[], event: string): Promise<void> {
  for (const listener of listeners) {
    try { await listener(event) } catch (error) { console.warn('listener failed', error) }
  }
}
```

## Never hand untrusted output the ambient environment or predictable paths

Spawned commands get a scrubbed env (drop `*KEY*`/`*SECRET*`/`*TOKEN*`/`*PASSWORD*`) so harness credentials cannot leak into output, `env`, or spill files. Temp/spill files use a private (0700) dir, random names, and exclusive owner-only opens (`'wx'`, `0o600`) — predictable world-readable paths invite symlink races and disclosure.

The judged condition is whether spawned processes inherit the ambient environment or write somewhere another process can predict and replace. The boundary is trusted, in-process code with no external input, which the rule does not govern.

## Unlink link-shaped paths

A path that may be a symlink or Windows junction is removed with `lstatSync().isSymbolicLink()` then `unlinkSync`: unlink deletes only the link and refuses a real directory, so it never follows the link into its target. Windows `rmSync(link)` throws `ERR_FS_EISDIR` on a junction; recursive deletion may descend through one into its target. Reserve recursive `rmSync` for known real directories.

The judged condition is whether the removal primitive can follow a link into its target. The boundary is a path the code created itself in a directory it owns, where a plain recursive removal is already known to be safe.
