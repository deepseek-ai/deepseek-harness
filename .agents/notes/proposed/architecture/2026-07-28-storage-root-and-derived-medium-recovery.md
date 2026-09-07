# Agent Note: Storage root placement and derived-medium recovery

Status: proposed

English | [中文](2026-07-28-storage-root-and-derived-medium-recovery.zh.md)

## Problem

The persisted projection cache ([note](2026-07-27-session-projection-and-command-log.md), shipped as `dsh-session-projection-cache`) surfaced two gaps in the storage substrate it landed on. Both are properties of the domain-KV stack ([design](2026-07-24-domain-kv-storage-and-workspace.md)), not of the cache itself, and both bite the cache first because it is the first *derived* medium on that stack.

**Where the files actually live (root mismatch closed; resolve-once residual still open).** The shared base defaults the session store to the global harness home (`$DSH_HOME/sessions`, default `~/.dsh/sessions`), while the shipped Web overlay used to give the json backend the relative root `./.storages`: `workspace.json` and `session_projcache.json` landed under `<launch dir>/.storages/` — two launches from different directories shared their sessions yet saw different workspace registries and different projection caches, and the cache exists precisely to serve the cross-session cold listing, which missed for every session last cached under another launch directory. That mismatch is now closed: the overlay anchors `storage-json.root` to `$DSH_HOME/storages` with the same `!!js` expression the session root uses (`apps/cli/config/web.cordis.yml`). The residual hazard: `JsonStorageBackend` still never resolves its root — each unit open joins the path against whatever `process.cwd()` is at that moment (packages/storage/storage-json/src/index.ts); the shipped overlay root is already absolute and unaffected, but any relative root (bare Loader boots, tests) still splits on a later cwd change — the exact hazard the JSONL session backend resolves-once to prevent ("later process.cwd() changes cannot split one backend across roots", packages/session/session-persistence-jsonl/src/index.ts).

**Recovery behavior.** Inside a healthy medium the cache is fully self-healing by design: a `stateVersion`-mismatched row is discarded and refolded, a log shrunk below a row's watermark is detected by the anchored restore floor and answered with one full re-read, and every background write is fail-soft. But at the *medium* level there is no recovery at all: a truncated, hand-edited, or version-bumped `session_projcache.json` fails `openJsonUnit` with `malformed-medium`/`version-mismatch` (packages/storage/storage-json/src/format.ts), a schema-drifted record fails domain open with `invalid-record` (packages/storage/storage-domain/src/index.ts), the rejection propagates through `SessionProjectionCache[Service.init]`, and under the CLI's fail-loud boot the assembly refuses to start. A file whose entire content is rebuildable from session logs can brick boot. This contradicts the cache package's own stated stance ("a stale or unreadable cache costs a longer tail replay, never a wrong value") and the cache domain spec's JSDoc ("version bumps discard the whole medium"), which describes an aspiration, not the implementation. Partially superseded for the projection cache: [the per-session cache files note](../../archived/architecture/2026-08-19-projection-cache-per-session-files.md) removed the global `session_projcache` domain, so the cache half of this proposal (recovery on that domain) no longer applies; the `workspace.json` half remains current. The `invalid-record` class for the per-record projection cache is now also superseded: the shipped domain declares `invalidRecords: 'backup-and-skip'` ([cross-version read-compat note](../../implemented/architecture/2026-09-02-projcache-cross-version-read-compat.md)), which backs the failing record up and skips it at open, so the reset/destroy proposal below stays relevant only for whole-medium damage on authoritative or single-document media. The same fail-loud path is *correct* for `workspace.json` — workspace records are authoritative, not derivable — so the missing concept is a per-domain declaration of authority, not a global behavior change.

## Proposal

Two independent changes, one per gap.

### One global storage root (shipped, amended form); resolved once at construction (still open)

- **Shipped**: the Web overlay anchors `storage-json.root` to `$DSH_HOME/storages` directly in the row through the app-boot-provided `dshHomePath('storages')` (`~/.dsh/storages` by default, beside `~/.dsh/sessions`; no leading dot — the home is already a hidden tree). The helper delegates to the canonical `dsh-home-paths` resolver, and the session root uses the same function without duplicating its fallback and tilde rules. The per-row form was chosen (user decision) over a launcher patch + `storageRoot` profile key (see Alternatives); per-row overrides ride the personal `~/.dsh/config.yaml` patch layer. The web e2e scaffold already patches the row to an absolute temp root, so tests never touch the user's home.
- **Still open**: `JsonStorageBackend` resolves its configured root once at construction (`resolve(config.root)`), adopting the JSONL backend's recorded rationale verbatim: a later `process.cwd()` change must not split one backend across roots. The SQLite storage backend already resolves its path.
- Pre-release stance applies (and was executed): no migration shim. A deployment that cached under `<cwd>/.storages` re-derives everything (workspace re-bootstraps from the header index; the projection cache refolds lazily) or moves the two json files by hand once.

### Declared derived media: reset instead of reject

- `DomainSpec` gains `recovery?: 'reject' | 'reset'` (default `'reject'`). The spec object is already the single source of a domain's identity and layout; whether its medium is authoritative or derived is the same kind of fact and lives in the same place. `session_projcache` declares `'reset'`; `workspace` stays on the default.
- `KvFacet` gains one primitive: `destroy(descriptor): Promise<void>` — remove the unit's medium entirely (json: delete the file; sqlite: drop the unit's tables). Like `open`, it is a backend storage primitive, not policy.
- `DomainFacility.open`, when a spec declares `'reset'` and the open fails with exactly a damage-class error — `StorageError('version-mismatch' | 'malformed-medium')` or `DomainError('invalid-record')` — logs one warning naming the domain and the discarded medium, calls `destroy`, and opens again empty. Every other failure (`backend-not-found`, `facet-unsupported`, `already-open`, I/O errors) stays loud regardless of the declaration: misconfiguration and environmental faults are not medium damage. The retry is single-shot — a second failure propagates, so a persistently failing medium cannot loop.
- With this in place the cache domain spec's version field gains its intended meaning: bumping `version` (or letting zod reject drifted rows) genuinely discards the whole medium and the cache rebuilds through its normal write points and cold reads — the recovery ladder's outermost rung, matching the row-level rungs already shipped.

## Alternatives considered

**Keep per-launch-directory `.storages` (the pre-change status quo)** — rejected: sessions are global, so every derived-from-sessions medium splits against its own source of truth; the cache's motivating scenario (one listing over all sessions) structurally misses rows, and the workspace registry indexes sessions it cannot see from another launch directory.

**Launcher patch + a `storageRoot` profile key** — not taken: one `!!js` yml expression reaches the global root with the same layering the session root already has; a launcher patch adds a second rewrite point, and the profile key is an empty seat until a real consumer exists (per-row overrides already have the personal config.yaml patch layer).

**Patch only the projection cache's route to a global root, leave `workspace.json` per-cwd** — rejected: the workspace registry has the identical global-vs-cwd mismatch, and the user chose to place the cache beside `workspace.json` — one hub root keeps the media co-located and the mental model single.

**Cache-plugin-local recovery (catch damage errors in `SessionProjectionCache[Service.init]`, delete the file, reopen)** — rejected: the plugin cannot name the medium path without reaching around the backend abstraction, and every future derived domain would re-implement the same catch; the facility is the one place that already classifies open failures.

**Fall back to an ephemeral in-memory domain on damage** — rejected: it silently degrades to memory-only for the life of the process and the damaged file never heals; the next boot fails the same way.

**Rename the damaged medium aside (`<unit>.json.corrupt-<ts>`) instead of deleting** — not chosen: a derived medium's damaged bytes have no recovery value (the logs are the source of truth) and the litter accumulates unbounded; delete is the honest operation. Rename-aside remains the right choice if a future *authoritative* domain ever wants reset semantics — which is exactly why `recovery` is per-spec.

**A blanket auto-reset for every domain (no spec field)** — rejected outright: `workspace.json` is authoritative user data; silently resetting it on a version bump would destroy workspaces. Authority is a property of the domain and must be declared by its owner.

## Acceptance criteria

- `dsh` launched from any directory reads and writes the same `$DSH_HOME/storages/*.json` (default `~/.dsh/storages`) — already satisfied by the overlay expression; per-row overrides ride the personal config.yaml patch layer; the backend resolves a relative root once at construction (still to do).
- With a truncated, version-bumped, or schema-drifted `session_projcache.json`, the assembly boots clean: one warning names the discarded medium, the file is gone, the cache rebuilds through normal operation, and the cold listing column reappears as sessions are re-checkpointed.
- The same damage to `workspace.json` still fails boot loudly.
- Facility tests cover: each damage class resets a `'reset'` domain exactly once; non-damage failures stay loud on a `'reset'` domain; a `'reject'` domain propagates every failure; `destroy` removes the medium on both shipped backends.

## Risks

- **Auto-delete on a misclassified error destroys a healthy file.** Mitigated by the closed damage-class list: reset fires only on the three deterministic parse-time codes; ENOENT is already "empty unit", and every I/O error (EACCES, EIO) propagates loudly. The single-shot retry bounds the blast radius to one delete per open.
- **Root relocation changes where existing checkouts look.** Accepted under the pre-release stance (backends reject old formats, no external consumers); the note above records the one-time manual move for anyone who cares about a per-cwd `workspace.json`'s content.
- **`destroy` is a new destructive primitive on the storage seam.** Its only caller is the facility's declared-reset path; the backend contract documents it as facility-owned, and nothing model-facing or user-facing can reach it.
