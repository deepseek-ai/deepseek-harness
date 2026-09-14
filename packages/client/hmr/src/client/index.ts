/**
 * client-hmr, browser half: hot-reload driver for client plugin entries.
 *
 * Listens on the host's system SSE channel (`GET /plugins/events`); on a
 * `rebuilt` frame it reloads the entry's bundle and swaps the cordis
 * fiber in place. Every graph entry is a plugin bundle
 * — `immediately` rows differ only in stage-one prefetch (a boot
 * optimization), so all rostered plugin packages share these reload semantics;
 * normal packages (react family, cordis, shell, pure libs) are not entries
 * and shell changes still mean a page reload. Cascade is zero-touch:
 * downstream fibers key their activation epoch on provider fiber uids
 * (vendor/cordis/src/fiber.ts `_refresh`), so replacing a provider fiber
 * re-cascades natively — reloading a data-layer plugin (connection/runtime)
 * cascades into its UI dependents with no HMR-side bookkeeping.
 *
 * Reload order (lazy CJS table): invalidate (drop the stale factory and
 * materialized record) → prefetch (load and register the fresh
 * factory) → registry-first teardown → drain old fiber unload → remove
 * owned `<style data-plugin>` tags → `entry.refresh()` materializes the new
 * factory. Invalidate MUST precede prefetch: a live factory makes prefetch
 * a no-op, and re-executing a bundle over an undeleted registration is a
 * loud duplicate. The swap is safe because execution is pure registration
 * under the lazy model — every module side effect (CSS injection included)
 * lives in the factory closure and runs at materialization, inside
 * refresh(). That also keeps the CSS ordering guarantee: owned styles are
 * removed after the old fiber's disposers drained (SlotCore one-owner
 * unregister) and before materialization re-injects tags under the same
 * stable tag ids.
 *
 * Failure window: if prefetch rejects after invalidate, the module is left
 * unregistered while the OLD fiber keeps running untouched (teardown never
 * started) — degraded but recoverable, the next rebuilt frame retries from
 * scratch. Consistent with the no-rollback policy below. Known dev-only
 * race: a rebuilt frame overlapping a still-in-flight boot arrival shares
 * that arrival's task and may materialize the pre-rebuild bytes; the next
 * rebuilt frame self-heals.
 *
 * Why not the naive `entry.fiber.dispose()` → `entry.refresh()` path:
 * 1. `Entry.fiber` is never cleared on dispose (vendor/loader/src/config/
 *    entry.ts assigns it only in `_init`), so `refresh()` hits its
 *    `if (this.fiber) return` guard and no-ops.
 * 2. A bare `fiber.dispose()` lands in Loader's self-dispose branch
 *    (vendor/loader/src/index.ts `internal/plugin` case 4: the registry
 *    still holds the runtime at emit time), which flags the entry
 *    `disabled: true` — permanently.
 * vendor/hmr's reload skeleton documents the fix: delete the runtime record
 * FIRST (`registry.delete` → case 4 returns early, the entry stays enabled),
 * then rebuild. `entry.fiber` is additionally cleared so
 * `entry.refresh()` re-imports and re-plugins through the Loader's own
 * `_init` (entry-resolved config, automatic `fiber.entry` rebinding) instead
 * of hand-rolling `registry.plugin`. Client entries have exactly one fiber
 * per runtime, so `registry.delete` never collaterally disposes siblings.
 *
 * Self-reload: this plugin is itself a graph entry, so a rebuilt frame may
 * name it. The in-flight reload keeps running in the old bundle's closure
 * (its EventSource closes with the old fiber's effects); the new bundle's
 * apply opens a fresh channel. Frames arriving during the gap are lost —
 * acceptable for the dev channel, the next rebuild renotifies.
 *
 * Failure policy: no rollback. An import failure leaves the entry
 * fiberless (the next rebuilt frame retries from scratch); an apply failure
 * leaves a FAILED fiber for the shell's status projection. Both log loudly.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Entry, Loader } from '@deepseek-ai/cordis-plugin-loader'
import type { PluginsEventFrame } from '../events.ts'
import { EVENTS_ENDPOINT, parsePluginsEventFrame } from '../events.ts'

export type { PluginsEventFrame } from '../events.ts'
export { EVENTS_ENDPOINT } from '../events.ts'

/** Cordis plugin name. */
export const name = 'client-hmr'

/** Required services: the vendored Loader (entry governance) and the client module system (boot provide, service name `modules`). */
export const inject = ['loader', 'modules']

/**
 * Registry-first teardown of an entry's running fiber so `entry.refresh()`
 * rebuilds it (see the module comment): delete the runtime record before the
 * fiber's disposer emits `internal/plugin` (or the Loader flags the entry
 * disabled), drain the unload so effect disposers finish before a new apply
 * re-registers, then clear `entry.fiber` so `refresh()` re-imports instead of
 * no-oping. A fiberless entry is left untouched.
 * @param entry - the Loader entry to tear down.
 */
export async function tearDownEntryFiber(entry: Entry): Promise<void> {
  const oldFiber = entry.fiber
  if (oldFiber === undefined) return
  const runtime = oldFiber.runtime
  if (runtime !== null) entry.ctx.registry.delete(runtime.callback)
  while (oldFiber.inertia !== undefined) await oldFiber.inertia
  delete entry.fiber
}

/** Find the loader entry whose module specifier is `id` (entry tree ids are random; the package name lives in `options.name`). */
function findEntry(loader: Loader, id: string): Entry | undefined {
  for (const entry of loader.entries()) {
    if (entry.options.name === id) return entry
  }
  return undefined
}

/** Remove every `<style data-plugin>` tag owned by `id` (attribute compared verbatim — no CSS-selector escaping pitfalls). */
function removeOwnedStyles(id: string): void {
  for (const el of document.querySelectorAll('style[data-plugin]')) {
    if (el.getAttribute('data-plugin') === id) el.remove()
  }
}

/**
 * Mount the HMR driver: subscribe to the system SSE channel and hot-swap
 * rebuilt entries.
 * @param ctx - plugin context with `loader` and `modules` available.
 */
export function apply(ctx: Context): void {
  // Both are declared injections (typed Context merges: `modules` from the
  // client module loader package, `loader` from the vendored Loader).
  const modLoader = ctx.modules
  const loader: Loader = ctx.loader

  async function reload(id: string, rev: string): Promise<void> {
    const entry = findEntry(loader, id)
    if (entry === undefined) {
      ctx.logger.warn(`client-hmr: rebuilt frame for unknown entry "${id}" (not in the loader tree)`)
      return
    }
    // Invalidate first (drop stale factory + record — a live factory makes
    // prefetch a no-op and re-registration a loud duplicate), then run the
    // async half while the old fiber still serves: script loading registers
    // the fresh factory with zero side effects (lazy CJS — module bodies run
    // at materialization, not execution).
    modLoader.invalidate(id, rev)
    await modLoader.prefetch(id)

    await tearDownEntryFiber(entry)
    // Old owned styles go before materialization re-injects them (the CSS
    // idempotency guard keys on stable tag ids).
    removeOwnedStyles(id)
    // Re-init through the entry: fiber cleared above, so refresh() re-imports
    // — materializing the prefetched factory (CSS injects here) — and
    // re-plugins under the entry context. Import failures are logged by
    // Entry._init and leave the entry fiberless (retryable).
    await entry.refresh()
    // Surface apply failures loudly (no rollback, FAILED state stays).
    await entry.fiber?.await()
  }

  // Serialize reloads: frames can arrive faster than a swap completes, and
  // interleaved dispose/execute chains would corrupt the single-slot handoff.
  let queue: Promise<void> = Promise.resolve()
  const handle = (frame: PluginsEventFrame): void => {
    switch (frame.type) {
      case 'rebuilt':
        queue = queue.then(() => reload(frame.id, frame.rev)).catch((error: unknown) => {
          ctx.logger.error(`client-hmr: reload of "${frame.id}" failed`)
          ctx.logger.error(error)
        })
        break
      case 'graph':
        // Connect-time snapshot, unused. Each rebuilt frame carries the
        // revision that selects the immutable single-resource combo script; the boot
        // graph remains the initial-load record until a page reload.
        break
      default:
        // Merge-extensible frame union: unknown frame types from newer hosts
        // are ignored by design.
        break
    }
  }

  ctx.effect(() => {
    const source = new EventSource(EVENTS_ENDPOINT)
    source.addEventListener('message', (event: MessageEvent<string>) => {
      let value: unknown
      try {
        value = JSON.parse(event.data) as unknown
      } catch {
        // Wire boundary: a malformed dev-channel frame is dropped loudly.
        ctx.logger.warn(`client-hmr: unparseable event frame: ${event.data}`)
        return
      }
      const parsed = parsePluginsEventFrame(value)
      if (parsed.kind === 'invalid') {
        ctx.logger.warn(`client-hmr: invalid event frame: ${event.data}`)
      } else if (parsed.kind === 'frame') {
        handle(parsed.frame)
      }
    })
    return () => { source.close() }
  }, 'client-hmr: event source')
}
