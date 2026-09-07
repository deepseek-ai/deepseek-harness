# Agent Note: Per-preset standing mounts over a scope parent chain

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-08-per-preset-standing-mounts.zh.md)

## Problem

Per-session preset mounts made the model-facing registry surface per-agent while three independent host readers still assumed it was static: cold `session.history` found no presenters (every card silently degraded to the generic renderer — indistinguishable from "tool has no presenter"), the projections block dropped preset-registered keys (clients treat an omitted key as capability absence and CLEAR the row), and the Typert gateway resolved `goals` on the host root (`service-unavailable`). Patching each reader individually traded one silent degradation for another: resuming to reach presenters flipped the projections fold from detached to live and wiped the token counts instead.

## Decision

A preset is one composition per PROCESS, not one per session. The roster mounts it once under a synthetic standing scope; each agent joins by binding its scope key to the mount's (`bindScopeParent(agentKey, standingKey)`). Two `dsh-scope` mechanisms carry everything: registration views walk the parent chain (`agent → preset → global`, nearest shadowing farthest), and scoped dispatch admits listeners tagged with an ancestor of the carrier key — upward only, so a sibling preset's listeners stay deaf.

## Consequences

Standing mounts fix the class, not the instances: the registrations a reader needs exist for the process lifetime, keyed by preset id, no agent required. What made it cheap

- The stateful preset plugins (`plan-mode`, `token-meter`, `compaction-basic`) already key state by `Session`/`Agent` — they predate presets. Sharing one instance is a return to their design, not a rewrite. `jobs-local` shared that property and has since left the preset plane entirely: producers outside its realm (`tool-bash`, `tool-terminal`, a non-continuable `tool-subagent`) resolve the registry with `ctx.get`, which an entry-local realm hides from them, so it is composed on the host plane and only the model-facing `tool-jobs` row stays per preset.
- Preset ymls are unchanged: one mount per preset = one Entry per preset, whose entry-local realms (`isolate: <name>: true`) keep two presets' same-named services apart exactly as they kept two sessions' apart.
- A shared realm label was NOT an option: `provide()` throws on a second registration under the same realm symbol, so labels pool the REALM, never the instance — a per-session world sharing a label crashes the second mount.

## Load-bearing details

- **Standing mounts hang off the service's untraced `selfCtx`.** A method invoked through the traceable proxy sees `this.ctx` rebound to the caller with a shadow; reflect resolution for every fiber in a subtree minted from it starts at the shadow's fiber, so entries fail on services their own `inject` declares (`cannot get property "tools" without inject` while the entry's store holds it). The `jobs-local` selfCtx precedent, now with a second consumer.
- **A settled mount serves until its composition file's stamp changes.** The composition a running session joined must survive its file changing or disappearing; each generation records the file's stamp (mtime + size) and a session that finds it stale starts the next generation, so file edits — the only composition editor once authoring became copy-only — reach later sessions without any authoring call dropping the pointer. Joined sessions keep their generation, and superseded generations are reclaimed only by whole-tree teardown — deliberate, bounded by edit frequency, recorded in the package's Known Limitations.
- **`peek()` stays chain-blind.** Restrictions and guards address one scope's own contributions; only registration VIEWS inherit. Restrictions along the chain intersect (any scope may mask a globally registered name for everything nested inside it).
- **Re-linking runs only through the `ScopeParentBinding` the mount's one bind returned** — the roster holds it privately, so the blank-session recompose path is the sole re-link and no other caller can move a composed agent; it stays valid only while nothing produced under the old parent is retained, which the holder must uphold because the relation cannot see session logs.

## Alternatives considered

Resume-on-read (wipes detached projections), a host-plane presenter table plus a block completeness flag (fixes two readers, leaves the class), per-session template mounts (duplicates every instance to serve pure functions). Kept for the record: the gateway-facing `goals` domain stays host-plane regardless — a Remote method whose receiver comes from a generated descriptor resolves on the host, which is the `shell-env` host-plane criterion read from the consuming side.
