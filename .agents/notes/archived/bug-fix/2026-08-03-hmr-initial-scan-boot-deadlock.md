# Agent Note: HMR's initial scan deadlocked a failing boot into a silent exit 13

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-03-hmr-initial-scan-boot-deadlock.zh.md)

## Problem

A `dsh` launch whose config-tree failed validation exited 13 (unsettled top-level await) with no diagnostic at all, and left the TUI's terminal state stranded on the shell — the exact symptom the [fail-loud release](2026-07-31-fail-loud-releases-the-terminal.md) fixed, reintroduced through a different mechanism after the [transactional config reload](2026-07-20-config-hot-reload-resilience.md).

Two defects compounded:

1. **Concurrent Include applies corrupt the transactional group update.** The HMR main watcher's chokidar initial scan re-announces every existing file as `add`. Its `add` for the config file triggered `Include.refresh()` while the Include's initial apply was still in flight (`this.content`, the changed-content dedup key, commits only after apply). Two concurrent `EntryGroup.update` calls on one group interleave create and rollback on the same entries, and the Include fiber never settles — `loader.create` hangs, `boot()` neither resolves nor rejects, and Node exits 13 once the loop drains.
2. **Serialized applies alone deadlock the failure rollback.** With Include mutations queued, a failing initial apply rolls back by disposing every mounted entry — including `hmr`, whose teardown drains its refresh tasks. The scan-triggered refresh task sits in the Include queue behind the very apply whose rollback is disposing HMR: rollback waits on HMR, HMR waits on the refresh, the refresh waits on the apply.

## Decision

Both halves are fixed in the vendored packages (logged in `vendor/README.md`):

- `include/src/index.ts` funnels every child-tree mutation — initial apply, refresh, and `internal/update` patch re-application — through one per-Include promise queue. The group's transactional `update` is not reentrant, so serialization is a correctness requirement, not a throughput choice. `refresh()` also reads inside the queue so its changed-content check compares against the predecessor's committed state.
- `hmr/src/index.ts` passes `ignoreInitial: true` to the main watcher. The initial scan only re-announces files boot has just consumed; suppressing it removes both the boot-time refresh and the spurious `add` events for already-loaded modules. `registerConfig()` keeps its own `ignoreInitial: false` watcher because a personal config present at registration must apply exactly once.

With both in place a failing boot follows the intended path: the single apply fails, the rollback disposes the tree (running the TUI's own shutdown, restoring the terminal), `loader.create` rejects, and `boot()` rethrows the labelled diagnostic with exit 1.

## Alternatives considered

**Only `ignoreInitial: true`.** Removes the trigger but leaves the corruption: any genuinely concurrent refresh (a config edit racing a slow apply) still interleaves two group updates and strands the fiber.

**Only serialization.** Converts the corruption into the rollback deadlock described above; the process still exits 13 silently.

**Cancel queued refreshes on HMR teardown.** Requires cancellation plumbing through `refreshConfig`'s task loop and the Include queue for a case `ignoreInitial` already removes from every boot; not worth the machinery until a real trigger remains.

## Consequences

A config file edit landing inside the watcher's startup scan window is now picked up by the next `change` event rather than the scan itself; steady-state reload behavior is unchanged.

One latent gap remains: a config edit made during a *failing* initial apply can still queue a refresh that the rollback's HMR teardown waits on — the same deadlock shape with a human-scale trigger window of one failing boot. If that ever bites, the fix is refresh-job cancellation at HMR teardown.

## Testing

The `dsh` invalid-provider PTY case in `apps/cli/tests/tui-keyless-smoke.e2e.ts` pins the end-to-end contract: exit 1, the labelled `dsh: plugin tree failed to load:` diagnostic naming `$.providers`, and the bracketed-paste reset proving the tree was disposed. Before this fix the same case observed exit 13 with no diagnostic. Reload behavior stays covered by `packages/boot/app-boot/tests/config-reload.spec.ts` and `packages/boot/app-boot/tests/hmr-config.spec.ts`.
