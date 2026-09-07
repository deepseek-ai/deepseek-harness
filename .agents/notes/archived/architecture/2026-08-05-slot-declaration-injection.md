# Agent Note: Slot declaration injection and reload lifetimes

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-05-slot-declaration-injection.zh.md)

## Problem

Client plugins may contribute to a slot before or after the plugin that declares it. Cordis service injection cannot express this dependency: a service is only an indirect ordering signal, client manifest dependency rows do not sequence activation, and a slot can disappear and return while every related service remains mounted. Registering immediately therefore races an undeclared slot, while waiting on an unrelated service couples independently reloadable features.

Slot-level hot replacement also requires two independent owners. Removing the declaring plugin must remove every contribution under its child slots; removing a contributing plugin must remove only that plugin's entries. A replacement declaration with the same key is a new lifetime even when disappearance and reappearance batch into one notification.

## Decision

`SlotRegistry.inject(name, callback)` makes the declared slot itself the dependency. The full `SlotMap` key is statically checked; there is no namespace builder, synthetic Cordis service, or slot-specific `Context`. The callback runs immediately when the declaration exists, otherwise waits, and returns either one synchronous disposer or a synchronous iterable of disposers. Iterable effects install transactionally: a later setup failure disposes every earlier yielded effect in reverse order.

The ledger records a declaration epoch distinct from the slot's ordinary entry version. An epoch changes whenever a child declaration is created or collapsed. Injection remembers the active epoch, disposes its callback effect when that epoch ends, and reruns the callback for a replacement declaration even when the final observed state is continuously declared. Ordinary contribution changes do not restart injection.

Both sides retain their natural ownership. The injection controller and every contribution run on the contributing plugin's caller `Context`, so disposing that plugin removes its wait and active entries. The slot ledger's existing child-collapse cascade removes entries when the declarer disappears; injection then runs their disposers to release service-layer resources and remains ready for a later declaration. The declaring plugin's `Context` is neither retained as a capability source nor exposed to contributors.

Dynamic reload code uses an ordinary Cordis plugin fiber as its replacement unit: activate the new module through `ctx.plugin()`, dispose and await the old fiber before mounting its replacement, and let its `slots.inject` and `slots.register` effects leave with that fiber. Renderer subscriptions observe the ledger removal and unmount the component; no slot-owned fiber tree is required.

## Failure and lifecycle contract

An injection whose declaration already exists reports callback setup failures synchronously. A callback failure after a delayed declaration first unsubscribes and rolls back its collected effects, then reports the failure outside the slot notification flush so one registrant cannot starve other listeners. Direct `slots.register()` into an undeclared slot continues to throw: injection is explicit and does not weaken load-time validation.

Disposing an injection is idempotent. It unsubscribes before releasing the active callback effect, preventing teardown-triggered ledger notifications from resurrecting the contribution. Declaration-bound teardown is synchronous with the ledger boundary, so it releases service-layer resources before any subsequent same-tick registration. A waiting injection disposed with its plugin cannot activate later.

## Alternatives considered

**Use `ConversationController` or another service as an ordering barrier.** Service presence does not identify the declaration or follow its reload lifetime, and it creates a false package dependency for presentation-only contributors.

**Bridge each declaration into a `slot:<name>` Cordis service.** This pollutes the service namespace, turns a misspelled dynamic key into a silent service wait, and disguises ledger state as a business capability. Native slot injection provides the same wait without changing Cordis topology.

**Create a Cordis context or fiber for every slot.** A contributor needs the intersection of its own plugin lifetime and the declaration lifetime, not the declarer's capabilities. A slot-owned context introduces capability inheritance and dual-parent teardown problems without improving ledger ownership.

**Make `register()` wait implicitly.** Immediate failure on an undeclared target is a valuable configuration check. Explicit injection distinguishes an intentional independently ordered contribution from a broken composition.

**Judge replacement from `spec(name) !== undefined` alone.** Collapse and redeclaration can batch into one continuously present final state while the old contributions have already been removed. The declaration epoch preserves that boundary.

## Consequences

Slot dependencies become auditable at the registration site and follow declaration replacement without package-specific ordering conventions. Dynamic plugin disposal removes rendered entries through existing Cordis effects, while declaration replacement has a stable hook for later slot-level HMR.

The runtime carries one additional monotonic epoch per touched slot and injection callbacks must return their cleanup. Multi-registration callbacks use iterable effects so setup and teardown remain atomic. The flat dotted-key ledger and the single `register()` composition authority remain unchanged.
