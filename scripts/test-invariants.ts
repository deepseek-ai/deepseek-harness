/**
 * Vitest-wide invariant host. Ordinary Cordis roots receive the invariant
 * service with global enablement plus the current test package's companion,
 * when it publishes one.
 * One topology test mounts every companion; focused invariant tests own their
 * service topology explicitly.
 */

import { expect } from 'vitest'
import { FiberState, Inject, RegistryService, ValidationError } from '@deepseek-ai/cordis'
import type { Context, Plugin } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'

declare global {
  interface ImportMeta {
    /** Lazy Vite module-glob expansion used by the Vitest setup file. */
    glob<TModule>(pattern: string): Record<string, () => Promise<TModule>>
  }
}

/** Loader-safe exports shared by every package invariant companion. */
export interface TestInvariantCompanion {
  readonly name: string
  readonly inject: readonly string[]
  readonly default?: unknown
  apply(ctx: Context): Promise<() => void>
}

/** Private service dependency that holds ordinary root plugins until invariant startup completes. */
export const TEST_INVARIANT_READY_SERVICE = 'testInvariantReady'

/**
 * Every published package companion as a lazy loader keyed by glob path. Ordinary tests
 * load only their owner's module; the exhaustive topology test loads and
 * executes all of them, so aggregated coverage still observes every
 * registration while per-file setup avoids importing unrelated companions and their
 * transitive package sources.
 */
export const testInvariantCompanions: Readonly<Record<string, () => Promise<TestInvariantCompanion>>> =
  import.meta.glob<TestInvariantCompanion>('../packages/*/*/src/invariant.ts')

/** Manual-topology suites whose names cannot follow the focused invariant convention. */
const MANUAL_INVARIANT_TEST_EXCEPTIONS = [
  '/packages/runtime-diagnostics/invariants/tests/service.spec.ts',
] as const

interface InvariantHost {
  readonly byCallback: ReadonlyMap<unknown, PluginFiber>
  readonly barrierOwners: WeakSet<Context['fiber']>
  readonly ready: Promise<void>
}

type PluginFiber = ReturnType<RegistryService['plugin']>
type PluginCallback = Plugin.Function | Plugin.Constructor

const hosts = new WeakMap<Context, InvariantHost>()
// oxlint-disable-next-line typescript/unbound-method -- every call below supplies its RegistryService receiver explicitly.
const originalPlugin = RegistryService.prototype.plugin

RegistryService.prototype.plugin = function(plugin: Plugin, config?: unknown, getOuterStack?: () => string[]) {
  const testPath = expect.getState().testPath ?? ''
  if (usesManualInvariantTree(testPath)) return originalPlugin.call(this, plugin, config, getOuterStack)

  const root = this.ctx.root
  const host = hosts.get(root) ?? startInvariantHost(root)
  const callback = this.resolve(plugin)
  const existing = callback === undefined ? undefined : host.byCallback.get(callback)
  if (existing !== undefined) {
    return hasBarrierOwner(host, this.ctx) ? existing : joinInvariantStartup(existing, host.ready)
  }

  // Causal descendants of a gated target have already crossed the barrier.
  // Host service and companion descendants also bypass it so their own startup
  // cannot depend on the readiness they are responsible for providing.
  if (hasBarrierOwner(host, this.ctx)) {
    return originalPlugin.call(this, plugin, config, getOuterStack)
  }
  if (callback === undefined) {
    return originalPlugin.call(this, plugin, config, getOuterStack)
  }

  const fiber = originalPlugin.call(
    this,
    withInvariantReadiness(plugin, callback as PluginCallback),
    config,
    getOuterStack,
  )
  const initiallyPending = fiber.ctx.fiber.state === FiberState.PENDING
  host.barrierOwners.add(fiber.ctx.fiber)
  return joinInvariantStartup(fiber, host.ready, initiallyPending)
}

/**
 * Detect focused suites that construct service selection or companion lifecycle explicitly.
 * @param testPath - absolute or repo-relative Vitest file path.
 * @returns whether the global invariant host must leave the root untouched.
 */
export function usesManualInvariantTree(testPath: string): boolean {
  const normalized = testPath.replaceAll('\\', '/')
  if (/\/packages\/[^/]+\/[^/]+\/tests\/[^/]*invariant[^/]*\.spec\.ts$/.test(normalized)) return true
  return MANUAL_INVARIANT_TEST_EXCEPTIONS.some(path => normalized.endsWith(path))
}

const ALL_COMPANION_TESTS = ['/scripts/test-invariants.spec.ts'] as const

/**
 * Select the package companions that an ordinary test root must register.
 * Package tests receive their owner's checks; the dedicated topology test
 * receives every companion owner so coverage and runtime registration remain
 * independently enforced.
 * @param testPath - absolute or repo-relative normalized Vitest file path.
 * @returns sorted `import.meta.glob` keys for companions to mount.
 */
export function testInvariantCompanionPaths(testPath: string): string[] {
  const normalized = testPath.replaceAll('\\', '/')
  const allPaths = Object.keys(testInvariantCompanions).sort()
  if (ALL_COMPANION_TESTS.some(path => normalized.endsWith(path))) return allPaths

  const owner = normalized.match(/\/packages\/([^/]+)\/([^/]+)\/tests\//)
  if (owner === null) return []
  const companionPath = `../packages/${owner[1]}/${owner[2]}/src/invariant.ts`
  return testInvariantCompanions[companionPath] === undefined ? [] : [companionPath]
}

function startInvariantHost(root: Context): InvariantHost {
  const byCallback = new Map<unknown, PluginFiber>()
  const barrierOwners = new WeakSet<Context['fiber']>()
  const mount = (plugin: Plugin, config?: unknown): PluginFiber => {
    const fiber = originalPlugin.call(root.registry, plugin, config)
    const callback = root.registry.resolve(plugin)
    if (callback === undefined) throw new Error('test invariants: companion is not a valid Cordis plugin')
    byCallback.set(callback, fiber)
    barrierOwners.add(fiber.ctx.fiber)
    return fiber
  }

  // The service mounts synchronously so the intercepted registration that
  // started this host immediately finds its own fiber in byCallback.
  // Companions load and mount inside the ready chain (after the service is
  // active, so their startup is directly joinable); every joined root plugin
  // awaits ready, so none starts ahead of its package checks. Tests plugging
  // a companion directly must await an earlier root plugin first — the
  // duplicate-mount failure otherwise is loud (owner name already reserved).
  const serviceFiber = mount(InvariantRegistry, { enabled: true })
  const testPath = expect.getState().testPath ?? ''
  const companionPaths = testInvariantCompanionPaths(testPath)
  const ready = requireActive(serviceFiber, 'invariant service').then(async () => {
    const companions = await Promise.all(companionPaths.map(async (path) => {
      const load = testInvariantCompanions[path]
      if (load === undefined) {
        throw new Error(`test invariants: selected companion vanished at ${path}`)
      }
      const companion = await load()
      if (!companion.inject.includes('invariants')) {
        throw new Error(`test invariants: ${path} must inject the invariant service`)
      }
      return { companion, path }
    }))
    const companionFibers = companions.map(({ companion, path }) => ({
      fiber: mount(companion),
      path,
    }))
    await Promise.all(companionFibers.map(({ fiber, path }) => requireActive(fiber, path)))
    root.provide(TEST_INVARIANT_READY_SERVICE, true)
  })
  const host = { byCallback, barrierOwners, ready }
  hosts.set(root, host)
  return host
}

function hasBarrierOwner(host: InvariantHost, ctx: Context): boolean {
  let fiber = ctx.fiber
  while (true) {
    if (
      host.barrierOwners.has(fiber)
      && (fiber.state === FiberState.LOADING || fiber.state === FiberState.ACTIVE)
    ) {
      return true
    }
    const parent = fiber.parent.fiber
    if (parent === fiber) return false
    fiber = parent
  }
}

async function requireActive(fiber: PluginFiber, label: string): Promise<void> {
  await fiber.await()
  if (fiber.state !== FiberState.ACTIVE) {
    throw new Error(`test invariants: ${label} settled without becoming active`)
  }
}

function withInvariantReadiness(plugin: Plugin, callback: PluginCallback): Plugin.Object {
  return {
    apply: callback as Plugin.Function,
    inject: {
      ...Inject.resolve(plugin.inject),
      [TEST_INVARIANT_READY_SERVICE]: null,
    },
    ...(plugin.name === undefined ? {} : { name: plugin.name }),
    ...(plugin.Config === undefined ? {} : { Config: plugin.Config }),
    ...(plugin.provide === undefined ? {} : { provide: plugin.provide }),
    ...(plugin.intercept === undefined ? {} : { intercept: plugin.intercept }),
  }
}

function joinInvariantStartup(
  fiber: PluginFiber,
  invariantReady: Promise<void>,
  disposePendingValidationFailure = false,
): PluginFiber {
  // RegistryService returns a thenable wrapper whose context still points to
  // the raw Fiber. Calling inherited await() on the wrapper would return and
  // assimilate that thenable, accidentally following later plugin startup.
  const rawFiber = fiber.ctx.fiber
  const readiness = invariantReady.then(async () => {
    try {
      return await rawFiber.await()
    } catch (error) {
      // Config resolves only after the readiness injection activates. Dispose
      // validation failures owned by an initially pending target; ordinary
      // callback failures remain inspectable.
      if (disposePendingValidationFailure && error instanceof ValidationError) {
        await rawFiber.dispose()
      }
      throw error
    }
  })
  const joined = Object.create(fiber) as PluginFiber
  joined.then = readiness.then.bind(readiness)
  return joined
}
