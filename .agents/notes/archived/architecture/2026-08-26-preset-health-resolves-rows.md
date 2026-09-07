# Agent Note: Preset health resolves the rows it can prove will start

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-26-preset-health-resolves-rows.zh.md)

## Problem

A preset the roster listed as healthy could still be impossible to compose. Discovery's health check proved the composition parsed in the loader dialect and held named rows, and deliberately stopped there — it resolved no plugin name and applied no config.

This note partly supersedes [broken presets are roster rows](../bug-fix/2026-08-09-broken-preset-roster-rows.md), whose rejected "validating deep" alternative is what shipped here, and it moved the reason off the card face; it also relaxes the shipped-roster assertion [plugin-owned shipped preset root](../bug-fix/2026-08-20-plugin-owned-shipped-preset-root.md) records. Both are updated in place.

`broken` is load-bearing, though, not a card decoration. `presetOptions` drops a broken row from the session pickers so a chooser never defers the discovery to a failed session start, and `resolveMountable` refuses one before spending a mount. Everything downstream therefore reads "not broken" as "will compose".

The gap surfaced when the [repository naming contract](2026-08-11-repository-naming-contract-and-rename-ledger.md) renamed packages under the pre-release stance. In-repo references moved with it; a preset authored under `<dshHome>/.agent-presets` did not, and one naming `@deepseek-ai/dsh-workspace-context` kept its healthy card, kept its place in the picker, and failed only when a person switched to it. A row naming a package a later release renamed or uninstalled is how an authored preset actually rots, and it was exactly the class the check excluded.

The failure it did produce named less than it knew. The Loader's per-row wrapper builds a plain `Error` whose message ends with `cause.message` and keeps the cause only as `error.cause`. A group that fails on two rows therefore arrives as one wrapped row whose message is `failed to apply loader entry <group> (cordis:group): loader entries failed to apply`, with the two real reasons reachable through `cause.errors` alone. The mount diagnostic flattened `AggregateError.errors` and never followed `cause`, so it ended at that line and named neither row.

## Decision

**Discovery resolves each row it can prove will start, and imports nothing.** The resolve pass runs after the shape check in `packages/preset/agent-presets/src/discovery.ts`, so a malformed composition still answers with the shape reason. A package name is looked up on disk — Node's own upward `node_modules` walk, stopping at `<package>/package.json`. A preset-relative or absolute specifier is statted instead, because `import.meta.resolve` only joins URLs for those and a preset shipping a file that was deleted would otherwise pass. Nothing is evaluated either way.

The disk lookup, not `import.meta.resolve`, for two reasons. It is the cheap one: a registered ESM loader hook turns every resolver call into a synchronous round-trip to the hooks thread, measured under the `tsx` hook the source launch installs at 2ms for a hit and 5ms for a miss against 0.055ms and 0.032ms on bare Node — 238ms of resolver time per roster read, where the walk answers the same 135 rows in 0.7ms. It is also the only one that can be asked about the harness at all: `import.meta.resolve`'s `parentURL` argument takes effect only under `--experimental-import-meta-resolve`, which no launch passes, so it resolves from the calling module and would answer about this package rather than about the deployment. The resolver that does honour an explicit parent is the Loader's internal one, whose `resolveSync` signature differs between Node 22 and 24. A Node builtin short-circuits ahead of the walk.

What the walk gives up: a package resolvable only through a loader hook — an import map, or a tree with no `node_modules` — is reported broken. No supported install produces one, because `dsh plugin install` puts every plugin beside the roster.

**One classifier decides where a row resolves.** `src/specifier.ts` owns the split — `cordis:` builtin, preset-relative, absolute file, package name — and both the mount's import override and discovery's check read it. A row discovery resolved from one base while the mount imported it from another would be reported healthy and then fail to load.

**A row that may never start is skipped.** `disabled` is the one entry field the [Loader interpolates](2026-08-11-loader-entry-disabled-interpolation.md): a `!!js` expression evaluates against the loader context at mount time, which discovery cannot do from a file. A row carrying anything but an absent, null, or `false` value is left unchecked, and a disabled group takes its children with it. Every shipped preset gates its shell rows this way, so this is the common shape, not a corner.

**The harness base is a required argument.** `discoverPresets(roots, harnessBase)` and `scanRoot(root, harnessBase)` take it; `AgentPresets` reads `ctx.baseUrl` once in its constructor and throws when it is absent. The base is what makes the question answerable at all — the same package name fails from a preset's own directory and resolves from the installed harness — so an optional one would silently restore the state this check exists to end.

**The mount diagnostic follows a cause that carries more than its message.** `mountDetail` reads branches from `AggregateError.errors`, or from `error.cause.errors` when the cause is an `AggregateError`; a plain cause chain is already flattened into the message and is not followed, which would print every line twice. Nested branches indent under the row that owns them.

**The client puts the reason on the badge.** The card face keeps the preset's own description, because a package specifier tells a chooser nothing they can act on there. The host's reason is revealed by hovering the badge or focusing the card, and a visually hidden `role="alert"` node announces it. A broken card says so through `aria-disabled` rather than `disabled` and refuses the pick in its own handler: `disabled` would take it out of the tab order, and with the reason off the face that would leave anyone without a pointer unable to reach it at all.

**A refused switch says why, where it was refused.** The chip's own label reverts to the preset the session still runs, so without a word the pick simply appears not to have happened. It announces through the shared `Toast`, over the composer column, the way the model picker beside it already reports a rejected selection. Only a pick a person just made is announced — the applier also runs when a session becomes current, and a banner over that would report a refusal nobody asked for. The banner holds for eight seconds rather than the primitive's three, because it carries a cause that names packages and rows; `Toast` gained a `holdMs` for that, which also retired the hazard of a hold constant the stylesheet had to be kept in step with by hand.

The wire already separated the two texts this needs: `message` wraps the cause in the roster's own "preset X failed to mount" frame, while `details.reason` holds the cause alone. A surface that names the preset itself takes the second, or it says the preset twice.

## Alternatives considered

**Check when a preset is selected rather than when the roster is listed.** Rejected. The pickers filter on `broken` before anyone selects, so a preset only checked at selection is still offered, and the reported failure still arrives after the click — the original complaint, relocated. The roster row is where every consumer already reads the verdict.

**Keep the base optional and skip the check without one.** Rejected. Its failure mode is precisely the bug being fixed, delivered with no signal: healthy cards for presets that cannot compose. `ctx.baseUrl` is set on the root before any scoped context derives from it, so the throw is an assertion about something that does not happen rather than a branch with runtime cost.

**Import each row instead of resolving it.** Rejected. Importing runs module top-level code on every roster read, which is a side effect a picker must not have, and it is the mount's job — a plugin that throws on apply or waits forever for a service still fails at the first session, by design.

**Resolve every row through `import.meta.resolve`.** Shipped first and reverted on measurement: correct, and 445ms per roster read, which the client's three concurrent reads turned into 2.45 seconds apiece — the settings section visibly stalled. The resolver is the authority on what imports, but asking it about rows that are plainly installed pays a hooks-thread round-trip for each one.

**Cache the whole of `compositionProblem` on the existing `CompositionStamp`.** Rejected as the answer to the cost: it would have made repeat reads free while leaving the first read of every edited composition at full price, and it keys resolution on the composition file, which does not change when an install does. The walk removed the cost instead, so nothing needs the stamp.

**Send the switch failure to the roster card instead of a banner.** Rejected: the card is exactly where the failures that reach a mount are invisible. A composition whose rows all resolve is reported healthy, so "see the settings page for the reason" points at a card that says the preset is fine.

**Report only the first unresolvable row, matching the shape check.** Rejected. A parse failure can cascade, so naming one is honest there; unresolvable names are independent facts all knowable at once, and reporting them one reload at a time is the avoidable part.

**Follow `error.cause` unconditionally in `mountDetail`.** Rejected. The Loader's wrapper already appends `cause.message` to the message it builds, so a plain chain would render every line twice. An `AggregateError` cause is the one shape whose detail the message drops.

**Keep rendering the reason on the card face.** Rejected. The reason names package specifiers and paths, and a picker card that shows them in place of the preset's description trades what a chooser needs for what a fixer needs — while the fixer's copy is one hover away either way.

**Reuse the icon row's `data-tip` pseudo-element for the tooltip.** Rejected once measured: generated content joins an element's accessible text, so the card's aria snapshot grew a second verbatim copy of a reason the alert already carried. A real `aria-hidden` element keeps exactly one accessible copy — and the existing tooltip is one `nowrap` line sized for an icon label, while this one names package specifiers one per line.

**Make the badge itself the focusable control.** Rejected: the badge sits inside the card's own `<button>`, so a focusable trigger there means restructuring the card head. Keeping the card focusable through `aria-disabled` reveals the same tooltip from the same key press and changes no layout. Leaving the reason reachable by pointer alone was rejected too — it was visible without any interaction before this change, so hiding it behind hover is a regression for anyone reading by keyboard rather than a path that never existed.

## Consequences

A preset naming a package that a rename or an uninstall took away is marked on the roster, refused before a mount is spent, and dropped from the pickers — the same treatment a ghost directory already got. The reason names each row at fault, and a failure that survives to mount names every row inside a group rather than the group alone.

Health answers from what is installed, not from what would import: a package present but exporting a file that is missing still reports healthy and still fails at mount. That is the safe direction — under-reporting returns the previous behavior, while a false broken makes a usable preset unselectable — and it keeps the answer out of the build state of any one package. A source checkout is still not an installed host, though, because a shipped row names a package the deployment installs beside the roster: `shipped-root.spec.ts` asserts the shipped presets carry no reason other than unresolved rows rather than no reason at all. The mount fixtures name a module that loads and then refuses, since a fixture naming a file that does not exist can no longer reach the mount.

A mount failure is now legible where it happens, which matters most for the failures health can never catch: a row that resolves and then refuses is reported healthy on the roster forever, so the banner is not a convenience over the card — it is the only account of that failure anywhere.

Measured in the web app on a roster of eleven presets, `agentPreset.list` answers in 14ms cold and 6-8ms after, and the three concurrent reads the client opens with settle in 9ms of wall clock. The same reads took 2.45 seconds each while every row went through the resolver.

`@deepseek-ai/cordis-plugin-group` is a devDependency of `dsh-agent-presets`: the mount fixtures now compose through `cordis:group` the way real presets do, and a preset outside the workspace cannot resolve that package by name, so the app registers it as a builtin and the fixture harness does the same.
