import { describe, expect, it, vi } from 'vitest'
import { Context, FiberState, Service, ValidationError } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import z from '@deepseek-ai/schemastery'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { packageInvariantOwners } from './package-invariants.ts'
import {
  TEST_INVARIANT_READY_SERVICE,
  testInvariantCompanionPaths,
  testInvariantCompanions,
  type TestInvariantCompanion,
  usesManualInvariantTree,
} from './test-invariants.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    testInvariantProbe: TestInvariantProbe
  }
}

class TestInvariantProbe extends Service {
  constructor(ctx: Context) {
    super(ctx, 'testInvariantProbe')
  }
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function requiredConfig() {
  return z.object({
    requiredValue: z.string().required(),
  })
}

function invalidConfigApply(): never {
  throw new Error('invalid plugin apply executed')
}

async function rejectionOf(fiber: ReturnType<Context['plugin']>): Promise<unknown> {
  return fiber.then(
    () => undefined,
    (error: unknown) => error,
  )
}

function expectRequiredConfigValidation(error: unknown): void {
  expect(error).toBeInstanceOf(ValidationError)
  expect(error).toHaveProperty('message', expect.stringMatching(/requiredValue/))
}

async function withFakeCompanions(
  create: (path: string, index: number) => () => Promise<TestInvariantCompanion>,
  run: () => Promise<void>,
): Promise<void> {
  const mutable = testInvariantCompanions as Record<string, () => Promise<TestInvariantCompanion>>
  const originals = Object.entries(mutable)
  for (const [index, [path]] of originals.entries()) {
    mutable[path] = create(path, index)
  }
  try {
    await run()
  } finally {
    for (const [path, load] of originals) {
      mutable[path] = load
    }
  }
}

async function withDelayedFirstCompanion(
  run: (control: { readonly started: Promise<void>; readonly release: () => void }) => Promise<void>,
): Promise<void> {
  const started = deferred()
  const release = deferred()
  await withFakeCompanions(
    (_path, index) => async () => ({
      name: `test-invariant-${index}`,
      inject: ['invariants'],
      async apply() {
        if (index === 0) {
          started.resolve()
          await release.promise
        }
        return () => {}
      },
    }),
    () => run({ started: started.promise, release: release.resolve }),
  )
}

describe('global test invariant host', () => {
  it('uses one topology to reserve every companion owner with enabled checks', async () => {
    const ctx = new Context()
    await ctx.plugin(TestInvariantProbe)

    const owners = packageInvariantOwners(process.cwd())
    expect(Object.keys(testInvariantCompanions)).toHaveLength(owners.length)
    const unreserved: string[] = []
    for (const owner of owners) {
      try {
        const dispose = ctx.invariants.register(owner.packageName, () => {})
        unreserved.push(owner.packageName)
        dispose()
      } catch (error) {
        expect(error).toHaveProperty(
          'message',
          `invariants: package "${owner.packageName}" is already registered`,
        )
      }
    }
    expect(unreserved).toEqual([])
  })

  it('mounts an owning companion and leaves omitted or non-package roots service-only', () => {
    expect(testInvariantCompanionPaths('/repo/packages/core/tools/tests/tools.spec.ts'))
      .toEqual(['../packages/core/tools/src/invariant.ts'])
    expect(testInvariantCompanionPaths('/repo/packages/util/brand/tests/brand.spec.ts')).toEqual([])
    expect(testInvariantCompanionPaths('/repo/apps/cli/tests/profiles/headless/example.spec.ts')).toEqual([])
    expect(testInvariantCompanionPaths('/repo/scripts/test-invariants.spec.ts'))
      .toEqual(Object.keys(testInvariantCompanions).sort())
  })

  it('loads and executes every source companion through the real Loader setup', async () => {
    const owners = new Map(packageInvariantOwners(process.cwd()).map(owner => [owner.sourcePath, owner.packageName]))
    const registrations = new Map<string, string>()
    const loader = Object.create(Loader.prototype) as Loader
    const register = vi.fn((_packageName: string, installer: InvariantInstaller) => {
      expect(typeof installer).toBe('function')
      return () => {}
    })
    const fakeContext = { invariants: { register } } as unknown as Context
    for (const [rawPath, load] of Object.entries(testInvariantCompanions)) {
      const companion = await load()
      const path = rawPath.replace(/^\.\.\//, '')
      expect(companion.default, path).toBeUndefined()
      const unwrapped = loader.unwrapExports(companion) as typeof companion
      expect(unwrapped, path).toBe(companion)
      expect(typeof unwrapped.name, path).toBe('string')
      expect(unwrapped.inject, path).toContain('invariants')
      expect(typeof unwrapped.apply, path).toBe('function')
      await unwrapped.apply(fakeContext)
      const call = register.mock.calls.at(-1)
      if (call === undefined) throw new Error(`${path}: companion did not register`)
      registrations.set(path, call[0])
    }
    expect(registrations).toEqual(owners)
  })

  it('recognizes focused invariant suites without a package inventory', () => {
    expect(usesManualInvariantTree('/repo/packages/core/session/tests/invariant.spec.ts')).toBe(true)
    expect(usesManualInvariantTree('/repo/packages/core/session/tests/request-invariant-hmr.spec.ts')).toBe(true)
    expect(usesManualInvariantTree('C:\\repo\\packages\\runtime-diagnostics\\invariants\\tests\\service.spec.ts')).toBe(true)
    expect(usesManualInvariantTree('/repo/packages/core/session/tests/session.spec.ts')).toBe(false)
  })

  it('preserves config validation failures without starting the rejected plugin', async () => {
    const ctx = new Context()
    const apply = vi.fn(invalidConfigApply)
    const plugin = {
      apply,
      Config: requiredConfig(),
    }

    const fiber = ctx.plugin(plugin, {})
    const firstError = await rejectionOf(fiber)
    expectRequiredConfigValidation(firstError)
    await ctx.plugin(TestInvariantProbe)
    const secondError = await rejectionOf(fiber)
    expect(secondError).toBe(firstError)
    expect(fiber.state).toBe(FiberState.DISPOSED)
    expect(apply).not.toHaveBeenCalled()
  })

  it('disposes invalid config after delayed invariant readiness', async () => {
    await withDelayedFirstCompanion(
      async ({ started, release }) => {
        const ctx = new Context()
        const apply = vi.fn(invalidConfigApply)
        const plugin = {
          apply,
          Config: requiredConfig(),
        }

        const fiber = ctx.plugin(plugin, {})
        const returnedError = rejectionOf(fiber)
        await started
        expect(fiber.state).toBe(FiberState.PENDING)
        expect(apply).not.toHaveBeenCalled()

        release()
        expectRequiredConfigValidation(await returnedError)
        expect(fiber.state).toBe(FiberState.DISPOSED)
        expect(apply).not.toHaveBeenCalled()
      },
    )
  })

  it('retains a valid plugin failure after delayed invariant readiness', async () => {
    await withDelayedFirstCompanion(
      async ({ started, release }) => {
        const ctx = new Context()
        const failure = new Error('valid plugin apply failed')
        const apply = vi.fn(function validConfigApply() {
          throw failure
        })
        const plugin = {
          apply,
          Config: z.object({}),
        }

        const fiber = ctx.plugin(plugin, {})
        const returnedError = rejectionOf(fiber)
        await started
        expect(fiber.state).toBe(FiberState.PENDING)
        expect(apply).not.toHaveBeenCalled()

        release()
        expect(await returnedError).toBe(failure)
        expect(fiber.state).toBe(FiberState.FAILED)
        expect(apply).toHaveBeenCalledOnce()
        expect(ctx.registry.has(plugin)).toBe(true)
        expect(ctx.registry.get(plugin)?.fibers).toHaveLength(1)
      },
    )
  })

  it('holds a root plugin until every lazy companion is active, then permits nested startup', async () => {
    const delayedStarted = deferred()
    const releaseDelayed = deferred()
    const order: string[] = []
    let delayedCompanion: TestInvariantCompanion | undefined
    const companionNestedApply = vi.fn(function companionNestedApply() {})

    await withFakeCompanions(
      (path, index) => async () => {
        const companion: TestInvariantCompanion = {
          name: `test-invariant-${index}`,
          inject: ['invariants'],
          async apply(companionCtx) {
            order.push(`companion-start:${path}`)
            if (index === 0) {
              delayedStarted.resolve()
              await releaseDelayed.promise
            }
            if (index === 1) await companionCtx.plugin(companionNestedApply)
            order.push(`companion-active:${path}`)
            return () => {}
          },
        }
        if (index === 0) delayedCompanion = companion
        return companion
      },
      async () => {
        const ctx = new Context()
        ctx.provide('testInvariantTargetDependency', true)
        let nestedFiber: ReturnType<Context['plugin']> | undefined
        const nestedApply = vi.fn(function nestedApply() {
          order.push('nested')
        })
        const targetApply = Object.assign(vi.fn(function targetApply(targetCtx: Context) {
          order.push('target')
          nestedFiber = targetCtx.plugin(nestedApply)
        }), {
          inject: ['testInvariantTargetDependency'],
        })

        const targetFiber = ctx.plugin(targetApply)
        expect(ctx.registry.get(targetApply)?.callback).toBe(targetApply)
        expect(targetFiber.inject).toEqual({
          testInvariantTargetDependency: null,
          [TEST_INVARIANT_READY_SERVICE]: null,
        })

        await delayedStarted.promise
        await Promise.resolve()
        await Promise.resolve()
        expect(targetApply).not.toHaveBeenCalled()

        releaseDelayed.resolve()
        await targetFiber
        if (nestedFiber === undefined) throw new Error('target did not register its nested plugin')
        await nestedFiber

        expect(targetFiber.state).toBe(FiberState.ACTIVE)
        expect(targetApply).toHaveBeenCalledOnce()
        expect(nestedApply).toHaveBeenCalledOnce()
        expect(companionNestedApply).toHaveBeenCalledOnce()
        const targetIndex = order.indexOf('target')
        expect(targetIndex).toBeGreaterThan(-1)
        expect(order.slice(0, targetIndex)).toHaveLength(Object.keys(testInvariantCompanions).length * 2)
        expect(order.at(-1)).toBe('nested')

        if (delayedCompanion === undefined) throw new Error('delayed companion did not load')
        await ctx.plugin(InvariantRegistry, { enabled: true })
        await ctx.plugin(delayedCompanion)
        expect(ctx.registry.get(InvariantRegistry)?.fibers).toHaveLength(1)
        expect(ctx.registry.get(delayedCompanion)?.fibers).toHaveLength(1)
      },
    )
  })

  it('holds plugins registered on a root-derived context until companion readiness', async () => {
    await withDelayedFirstCompanion(
      async ({ started, release }) => {
        const ctx = new Context()
        const rootApply = vi.fn(function rootApply() {})
        const derivedApply = vi.fn(function derivedApply() {})
        const derived = ctx.extend()
          .isolate('testInvariantDerived')
          .intercept('testInvariantDerived', {})

        const rootFiber = ctx.plugin(rootApply)
        const derivedFiber = derived.plugin(derivedApply)

        await started
        await Promise.resolve()
        await Promise.resolve()
        expect(rootApply).not.toHaveBeenCalled()
        expect(derivedApply).not.toHaveBeenCalled()
        expect(derivedFiber.inject).toEqual({
          [TEST_INVARIANT_READY_SERVICE]: null,
        })

        release()
        await Promise.all([rootFiber, derivedFiber])
        expect(rootFiber.state).toBe(FiberState.ACTIVE)
        expect(derivedFiber.state).toBe(FiberState.ACTIVE)
        expect(rootApply).toHaveBeenCalledOnce()
        expect(derivedApply).toHaveBeenCalledOnce()
      },
    )
  })

  it('holds a child registered externally on a pending target context', async () => {
    await withDelayedFirstCompanion(
      async ({ started, release }) => {
        const ctx = new Context()
        const targetApply = vi.fn(function targetApply() {})
        const childApply = vi.fn(function childApply() {})

        const targetFiber = ctx.plugin(targetApply)
        const childFiber = targetFiber.ctx.plugin(childApply)

        await started
        await Promise.resolve()
        await Promise.resolve()
        expect(targetFiber.state).toBe(FiberState.PENDING)
        expect(childFiber.state).toBe(FiberState.PENDING)
        expect(targetApply).not.toHaveBeenCalled()
        expect(childApply).not.toHaveBeenCalled()
        expect(childFiber.inject).toEqual({
          [TEST_INVARIANT_READY_SERVICE]: null,
        })

        release()
        await Promise.all([targetFiber, childFiber])
        expect(targetFiber.state).toBe(FiberState.ACTIVE)
        expect(childFiber.state).toBe(FiberState.ACTIVE)
        expect(targetApply).toHaveBeenCalledOnce()
        expect(childApply).toHaveBeenCalledOnce()
      },
    )
  })

  it.each(['load', 'startup'] as const)(
    'rejects a target when a lazy companion fails during %s without starting the target',
    async (phase) => {
      const failure = new Error(`test invariant companion ${phase} failed`)
      await withFakeCompanions(
        (_path, index) => phase === 'load' && index === 0
          ? async () => { throw failure }
          : async () => ({
            name: `test-invariant-${index}`,
            inject: ['invariants'],
            async apply() {
              if (phase === 'startup' && index === 0) throw failure
              return () => {}
            },
          }),
        async () => {
          const ctx = new Context()
          const targetApply = vi.fn(function targetApply() {})
          const targetFiber = ctx.plugin(targetApply)

          await expect(targetFiber).rejects.toBe(failure)
          expect(targetApply).not.toHaveBeenCalled()
          expect(targetFiber.state).toBe(FiberState.PENDING)
          await expect(targetFiber.dispose()).resolves.toBeUndefined()
          expect(targetFiber.state).toBe(FiberState.DISPOSED)
        },
      )
    },
  )

  it('disposes a pending target without waiting for companion readiness', async () => {
    await withDelayedFirstCompanion(
      async ({ started, release }) => {
        const ctx = new Context()
        const targetApply = vi.fn(function targetApply() {})
        const targetFiber = ctx.plugin(targetApply)

        await started
        await expect(targetFiber.dispose()).resolves.toBeUndefined()
        expect(targetFiber.state).toBe(FiberState.DISPOSED)
        expect(targetApply).not.toHaveBeenCalled()

        release()
        await targetFiber
        expect(targetApply).not.toHaveBeenCalled()
      },
    )
  })
})
