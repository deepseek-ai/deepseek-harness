import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { PluginPackages } from '@deepseek-ai/dsh-app-boot'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import * as typertLoader from '@deepseek-ai/dsh-typert-loader'
import { validateTypertManifest } from '@deepseek-ai/dsh-typert-loader'
import { z } from 'zod'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  Reflect.deleteProperty(globalThis, '__dshTypertLoaderGate')
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Write a fake installed package under the fixture root's node_modules. */
async function writePackage(
  base: string,
  pkgName: string,
  options: {
    manifestName?: string
    typertExport?: boolean
    typertTarget?: unknown
    typertSource?: string
    pluginSource?: string
    omitExports?: boolean
    pluginSubpath?: string
  } = {},
): Promise<void> {
  const dir = join(base, 'node_modules', ...pkgName.split('/'))
  await mkdir(dir, { recursive: true })
  const exportsField: Record<string, unknown> = { '.': './index.js', './package.json': './package.json' }
  if (options.typertExport !== false && options.typertSource !== undefined) {
    exportsField['./typert'] = options.typertTarget ?? './typert.host.js'
  }
  if (options.pluginSubpath !== undefined) exportsField[options.pluginSubpath] = './index.js'
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name: options.manifestName ?? pkgName,
    type: 'module',
    ...(options.omitExports ? { main: './index.js' } : { exports: exportsField }),
  }))
  await writeFile(join(dir, 'index.js'), options.pluginSource ?? 'export function apply() {}\n')
  if (options.typertSource !== undefined) {
    await writeFile(join(dir, 'typert.host.js'), options.typertSource)
  }
}

function typertSource(pkgName: string, entryName: string): string {
  return [
    'import { z } from \'zod\'',
    `export const ${entryName} = () => z.object({ id: z.string() })`,
    'export const TYPERT = {',
    `  package: '${pkgName}',`,
    '  face: \'host\',',
    `  schemas: [{ name: '${entryName}', create: ${entryName} }],`,
    '  model: { services: [], events: [], objects: [] },',
    '  invocations: [],',
    '}',
    '',
  ].join('\n')
}

function invocationTypertSource(pkgName: string): string {
  return [
    'import { z } from \'zod\'',
    'const Text = () => z.string()',
    'export const TYPERT = {',
    `  package: '${pkgName}',`,
    '  face: \'host\',',
    '  schemas: [],',
    '  model: { services: [], events: [], objects: [] },',
    '  invocations: [{',
    `    id: '${pkgName}#goals/create',`,
    '    service: \'goals\', namespace: \'goals\', method: \'create\',',
    '    invocation: { kind: \'direct\' },',
    '    parameters: [{',
    '      name: \'request\', wire: \'request\', source: \'json\',',
    `      codec: { mode: 'strict', typeSymbol: '${pkgName}/types#Request', create: Text },`,
    '    }],',
    "    cancellation: { parameter: 'signal' },",
    `    result: { mode: 'strict', typeSymbol: '${pkgName}/types#Result', create: Text },`,
    '    sourceLocation: { file: \'src/index.ts\', line: 8, column: 3 },',
    '  }],',
    '}',
    '',
  ].join('\n')
}

/** Boot a real Loader over a fixture root; plugin modules resolve from its node_modules. */
async function boot(): Promise<Context> {
  context = new Context()
  context.baseUrl = pathToFileURL(join(root as string, 'cordis.yml')).href
  await context.plugin(TypertRegistry)
  await context.plugin(Loader)
  const fixtureRequire = createRequire(context.baseUrl)
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      const module: unknown = await import(pathToFileURL(fixtureRequire.resolve(specifier)).href)
      return module
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.plugin(PluginPackages)
  // zod must be resolvable from the fixture packages; link the workspace copy.
  await mkdir(join(root as string, 'node_modules'), { recursive: true })
  return context
}

async function linkZod(base: string): Promise<void> {
  const { symlink } = await import('node:fs/promises')
  const target = join(base, 'node_modules', 'zod')
  const source = fileURLToPath(new URL('.', import.meta.resolve('zod/package.json')))
  await mkdir(join(base, 'node_modules'), { recursive: true })
  await symlink(source, target, process.platform === 'win32' ? 'junction' : 'dir')
}

function mountTypertLoader(ctx: Context, config: typertLoader.Config = {}): ReturnType<Context['plugin']> {
  return ctx.plugin(typertLoader, config)
}

// Fixture setup writes fake installed packages and boots a real Loader; the
// default 5s deadline is too tight on slow CI filesystems.
const LOADER_TEST_TIMEOUT = { timeout: 60_000 }

describe('typert loader', () => {
  it('registers an explicit package without a Loader entry and withdraws it with the loader', LOADER_TEST_TIMEOUT, async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-typert-loader-'))
    await linkZod(root)
    await writePackage(root, '@fixture/nested', { typertSource: typertSource('@fixture/nested', 'Nested') })
    const ctx = await boot()

    const fiber = mountTypertLoader(ctx, { packages: ['@fixture/nested'] })
    await fiber
    expect(ctx.typert.get('@fixture/nested#Nested')).toBeDefined()

    await fiber.dispose()
    expect(ctx.typert.getPackage('@fixture/nested')).toBeUndefined()
  })

  it('registers a strict invocation into the local registry and withdraws it with the loader', LOADER_TEST_TIMEOUT, async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-typert-loader-'))
    await linkZod(root)
    await writePackage(root, '@fixture/invocation', {
      typertSource: invocationTypertSource('@fixture/invocation'),
    })
    const ctx = await boot()

    const fiber = mountTypertLoader(ctx, { packages: ['@fixture/invocation'] })
    await fiber

    const descriptor = ctx.typert.local.get('goals/create')
    expect(descriptor).toMatchObject({
      id: '@fixture/invocation#goals/create',
      invocation: { kind: 'direct' },
      parameters: [{ wire: 'request', source: 'json' }],
      cancellation: { parameter: 'signal' },
      sourceLocation: { file: 'src/index.ts', line: 8, column: 3 },
    })
    expect(descriptor?.parameters[0]?.codec.mode).toBe('strict')
    if (descriptor?.parameters[0]?.codec.mode === 'strict') {
      expect(descriptor.parameters[0].codec.create().parse('request')).toBe('request')
    }

    await fiber.dispose()
    expect(ctx.typert.local.get('goals/create')).toBeUndefined()
  })

  it('fails loud when an explicit package is absent or has no Typert export', LOADER_TEST_TIMEOUT, async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-typert-loader-'))
    await writePackage(root, '@fixture/plain')
    const ctx = await boot()

    let failure: unknown
    try {
      await mountTypertLoader(ctx, {
        packages: ['@fixture/missing', '@fixture/plain', '@fixture/subpath/plugin'],
      })
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as Error).message).toContain('configured package "@fixture/missing" cannot be resolved')
    expect((failure as Error).message).toContain('configured package "@fixture/plain" does not export "./typert"')
    expect((failure as Error).message).toContain('configured package "@fixture/subpath/plugin" cannot be resolved')
  })

  it('auto-registers a mounted package exporting ./typert and withdraws it on unmount', LOADER_TEST_TIMEOUT, async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-typert-loader-'))
    await linkZod(root)
    await writePackage(root, '@fixture/with-typert', { typertSource: typertSource('@fixture/with-typert', 'Thing') })
    await writePackage(root, '@fixture/plain')
    const ctx = await boot()

    const id = await ctx.loader.create({ name: '@fixture/with-typert' })
    const plainId = await ctx.loader.create({ name: '@fixture/plain' })
    await ctx.loader.await()
    await mountTypertLoader(ctx)
    await ctx.loader.await()

    const record = ctx.typert.get('@fixture/with-typert#Thing')
    expect(record).toMatchObject({ package: '@fixture/with-typert', face: 'host', name: 'Thing' })
    expect(record?.schema.safeParse({ id: 'x' }).success).toBe(true)
    // The plain package is silently skipped.
    expect(ctx.typert.list().map(r => r.key)).toEqual(['@fixture/with-typert#Thing'])

    const mounted = [...ctx.loader.entries()].find(entry => entry.options.name === '@fixture/with-typert')
    if (mounted?.fiber === undefined) throw new Error('fixture loader entry has no fiber')
    ctx.emit('internal/plugin', mounted.fiber)
    ctx.emit('internal/plugin', mounted.fiber)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(ctx.typert.list()).toHaveLength(1)

    ctx.loader.remove(id)
    await ctx.loader.await()
    // The unmount reconciliation rides a queued microtask flush.
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(ctx.typert.get('@fixture/with-typert#Thing')).toBeUndefined()
    ctx.loader.remove(plainId)
    await ctx.loader.await()
    await new Promise(resolve => setTimeout(resolve, 20))

    await ctx.loader.create({ name: '@fixture/with-typert' })
    await ctx.loader.await()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(ctx.typert.get('@fixture/with-typert#Thing')).toBeDefined()
  })

  it('skips package-subpath rows and validates npm aliases against the manifest owner', LOADER_TEST_TIMEOUT, async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-typert-loader-'))
    await linkZod(root)
    await writePackage(root, '@fixture/subpath', {
      pluginSubpath: './plugin',
      typertSource: typertSource('@fixture/subpath', 'Subpath'),
    })
    await writePackage(root, 'fixture-alias', {
      manifestName: '@fixture/actual',
      typertSource: typertSource('@fixture/actual', 'Aliased'),
    })
    const ctx = await boot()
    await ctx.loader.create({ name: '@fixture/subpath/plugin' })
    await ctx.loader.create({ name: 'fixture-alias' })
    await ctx.loader.await()

    await mountTypertLoader(ctx)

    expect(ctx.typert.getPackage('@fixture/subpath')).toBeUndefined()
    expect(ctx.typert.get('@fixture/actual#Aliased')).toBeDefined()
  })

  it('follows entries mounted after activation', LOADER_TEST_TIMEOUT, async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-typert-loader-'))
    await linkZod(root)
    await writePackage(root, '@fixture/late', { typertSource: typertSource('@fixture/late', 'Late') })
    const ctx = await boot()
    await mountTypertLoader(ctx)

    expect(ctx.typert.get('@fixture/late#Late')).toBeUndefined()
    await ctx.loader.create({ name: '@fixture/late' })
    await ctx.loader.await()
    // Contributor import settles after Loader's own await boundary.
    await vi.waitFor(() => {
      expect(ctx.typert.get('@fixture/late#Late')).toBeDefined()
    }, { timeout: 10_000 })
  })

  it('drops an in-flight manifest when the loader is disposed before import settles', LOADER_TEST_TIMEOUT, async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-typert-loader-'))
    await linkZod(root)
    let markStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    let releaseImport: (() => void) | undefined
    const wait = new Promise<void>((resolve) => { releaseImport = resolve })
    Reflect.set(globalThis, '__dshTypertLoaderGate', {
      started: (): void => { markStarted?.() },
      wait,
    })
    await writePackage(root, '@fixture/pending', {
      typertSource: [
        'import { z } from \'zod\'',
        'globalThis.__dshTypertLoaderGate.started()',
        'await globalThis.__dshTypertLoaderGate.wait',
        'export const Pending = () => z.object({ id: z.string() })',
        'export const TYPERT = {',
        '  package: \'@fixture/pending\',',
        '  face: \'host\',',
        '  schemas: [{ name: \'Pending\', create: Pending }],',
        '  model: { services: [], events: [], objects: [] },',
        '  invocations: [],',
        '}',
        '',
      ].join('\n'),
    })
    const ctx = await boot()
    const loaderFiber = mountTypertLoader(ctx)
    await loaderFiber
    await ctx.loader.create({ name: '@fixture/pending' })
    await ctx.loader.await()
    await started

    const mounted = [...ctx.loader.entries()].find(entry => entry.options.name === '@fixture/pending')
    if (mounted?.fiber === undefined) throw new Error('fixture loader entry has no fiber')
    ctx.emit('internal/plugin', mounted.fiber)
    await Promise.resolve()

    let queued: (() => void) | undefined
    const queue = vi.spyOn(globalThis, 'queueMicrotask').mockImplementation((callback) => { queued = callback })
    ctx.emit('internal/plugin', mounted.fiber)
    queue.mockRestore()

    await loaderFiber.dispose()
    queued?.()
    releaseImport?.()
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(ctx.typert.getPackage('@fixture/pending')).toBeUndefined()
  })

  it('fails activation loud when an already-mounted contributor is malformed', LOADER_TEST_TIMEOUT, async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-typert-loader-'))
    await linkZod(root)
    await writePackage(root, '@fixture/broken', {
      typertSource: 'export const TYPERT = { package: \'@fixture/broken\', face: \'host\', schemas: [{ name: \'\', create: {} }], model: { services: [], events: [], objects: [] }, invocations: [] }\n',
    })
    const ctx = await boot()
    await ctx.loader.create({ name: '@fixture/broken' })
    await ctx.loader.await()

    await expect(mountTypertLoader(ctx)).rejects.toThrow(/typert contributor\(s\) failed to register/)
  })

  it('fails loud when the declared typert module cannot be imported', LOADER_TEST_TIMEOUT, async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-typert-loader-'))
    await linkZod(root)
    await writePackage(root, '@fixture/no-module', {
      typertSource: 'import { missing } from \'./nope.js\'\nexport const TYPERT = missing\n',
    })
    const ctx = await boot()
    await ctx.loader.create({ name: '@fixture/no-module' })
    await ctx.loader.await()

    await expect(mountTypertLoader(ctx)).rejects.toThrow(/importing .* failed/)
  })

  it('accepts conditional artifact exports and skips packages with no exports field', LOADER_TEST_TIMEOUT, async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-typert-loader-'))
    await linkZod(root)
    await writePackage(root, '@fixture/conditional', {
      typertSource: typertSource('@fixture/conditional', 'Conditional'),
      typertTarget: { default: './typert.host.js' },
    })
    await writePackage(root, '@fixture/no-exports', { omitExports: true })
    const ctx = await boot()
    await ctx.loader.create({ name: '@fixture/conditional' })
    await ctx.loader.create({ name: '@fixture/no-exports' })
    await ctx.loader.await()

    await mountTypertLoader(ctx)

    expect(ctx.typert.get('@fixture/conditional#Conditional')).toBeDefined()
    expect(ctx.typert.getPackage('@fixture/no-exports')).toBeUndefined()
  })

  it('aggregates unsupported package export shapes during activation', LOADER_TEST_TIMEOUT, async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-typert-loader-'))
    await linkZod(root)
    await writePackage(root, '@fixture/export-shape', {
      typertSource: typertSource('@fixture/export-shape', 'Shape'),
      typertTarget: { default: 1 },
    })
    await writePackage(root, '@fixture/export-primitive', {
      typertSource: typertSource('@fixture/export-primitive', 'Primitive'),
      typertTarget: 1,
    })
    const ctx = await boot()
    await ctx.loader.create({ name: '@fixture/export-shape' })
    await ctx.loader.create({ name: '@fixture/export-primitive' })
    await ctx.loader.await()

    await expect(mountTypertLoader(ctx)).rejects.toThrow('must be a string or an object with a string default')
  })

  it('caches a negative verdict for loader entries without a package root', LOADER_TEST_TIMEOUT, async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-typert-loader-'))
    const ctx = await boot()
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (specifier !== 'virtual-plugin') throw new Error(`unexpected fixture import ${specifier}`)
        return { apply() {} }
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({ name: 'virtual-plugin' })
    await ctx.loader.await()

    await mountTypertLoader(ctx)

    expect(ctx.typert.getPackage('virtual-plugin')).toBeUndefined()
  })

  it('requires a config-tree resolution anchor', LOADER_TEST_TIMEOUT, async () => {
    context = new Context()
    await context.plugin(TypertRegistry)
    await context.plugin(Loader)

    await expect(mountTypertLoader(context)).rejects.toThrow('ctx.baseUrl is unset')
  })

  it('contains steady-state registration failures and normalizes non-Error throws', LOADER_TEST_TIMEOUT, async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-typert-loader-'))
    await linkZod(root)
    await writePackage(root, '@fixture/steady-failure', {
      typertSource: typertSource('@fixture/steady-failure', 'Steady'),
    })
    const ctx = await boot()
    await mountTypertLoader(ctx)
    const logged = vi.spyOn(ctx.logger, 'error').mockImplementation(() => undefined)
    vi.spyOn(ctx.typert, 'register').mockImplementation(() => { throw 'register failed' })

    await ctx.loader.create({ name: '@fixture/steady-failure' })
    await ctx.loader.await()
    // The failing contributor's error is reported on the post-await flush.
    await vi.waitFor(() => {
      expect(logged).toHaveBeenCalledWith(expect.objectContaining({ message: 'register failed' }))
    }, { timeout: 10_000 })
    expect(ctx.typert.getPackage('@fixture/steady-failure')).toBeUndefined()
  })
})

describe('validateTypertManifest', () => {
  const zodish = { _zod: {} }

  it('accepts a well-formed manifest and rejects each malformed field loudly', () => {
    expect(validateTypertManifest('pkg', {
      package: 'pkg',
      face: 'host',
      schemas: [{ name: 'A', create: () => zodish }],
      model: { services: [], events: [], objects: [] },
      invocations: [],
    }).schemas).toHaveLength(1)

    expect(() => validateTypertManifest('pkg', undefined)).toThrow('no TYPERT manifest object')
    expect(() => validateTypertManifest('pkg', { package: 'other' })).toThrow('must be owned by the package')
    expect(() => validateTypertManifest('pkg', { package: 'pkg', face: 'client' })).toThrow('TYPERT.face is not "host"')
    expect(() => validateTypertManifest('pkg', { package: 'pkg', face: 'host', schemas: 'x' })).toThrow('schemas must be an array')
    expect(() => validateTypertManifest('pkg', { package: 'pkg', face: 'host', schemas: [null] })).toThrow('non-object schema')
    expect(() => validateTypertManifest('pkg', { package: 'pkg', face: 'host', schemas: [{ name: '', create: () => zodish }] }))
      .toThrow('missing or empty name')
    expect(() => validateTypertManifest('pkg', { package: 'pkg', face: 'host', schemas: [{ name: 'A', create: {} }] }))
      .toThrow('has no create() factory')
    expect(() => validateTypertManifest('pkg', {
      package: 'pkg',
      face: 'host',
      schemas: [],
      model: { services: [{ key: 'tools', exportName: 'ToolRuntime', tags: [], members: 'x', types: [] }], events: [], objects: [] },
    })).toThrow('service "tools".members must be an array')
  })

  it('validates service, event, object, member, type, and documentation records', () => {
    const complete = completeManifest(zodish)
    expect(validateTypertManifest('pkg', complete)).toBe(complete)

    expect(() => validateTypertManifest('pkg', { ...complete, model: [] }))
      .toThrow('TYPERT.model must be an object')
    expect(() => validateTypertManifest('pkg', { ...complete, model: { ...complete.model, services: [null] } }))
      .toThrow('service must be an object')
    expect(() => validateTypertManifest('pkg', {
      ...complete,
      model: { ...complete.model, services: [{ ...complete.model.services[0], tags: 'bad' }] },
    })).toThrow('service.tags must be an array')
    expect(() => validateTypertManifest('pkg', {
      ...complete,
      model: { ...complete.model, services: [{ ...complete.model.services[0], description: 1 }] },
    })).toThrow('service.description must be a string')
    expect(() => validateTypertManifest('pkg', {
      ...complete,
      model: { ...complete.model, services: [{ ...complete.model.services[0], key: '' }] },
    })).toThrow('service has a missing or empty key')
    expect(() => validateTypertManifest('pkg', {
      ...complete,
      model: { ...complete.model, services: [{ ...complete.model.services[0], members: [null] }] },
    })).toThrow('member must be an object')
    expect(() => validateTypertManifest('pkg', {
      ...complete,
      model: {
        ...complete.model,
        services: [{ ...complete.model.services[0], members: [{ name: 'member', signature: 'member(): void', kind: 1 }] }],
      },
    })).toThrow('has invalid kind')
    expect(() => validateTypertManifest('pkg', {
      ...complete,
      model: {
        ...complete.model,
        services: [{ ...complete.model.services[0], members: [{ name: 'member', signature: 'member(): void', kind: 'future' }] }],
      },
    })).toThrow('has invalid kind')
    expect(() => validateTypertManifest('pkg', {
      ...complete,
      model: { ...complete.model, services: [{ ...complete.model.services[0], types: [null] }] },
    })).toThrow('type must be an object')
    expect(() => validateTypertManifest('pkg', {
      ...complete,
      model: {
        ...complete.model,
        services: [{ ...complete.model.services[0], types: [{ name: 'Type', declaration: '' }] }],
      },
    })).toThrow('type has a missing or empty declaration')
    expect(() => validateTypertManifest('pkg', {
      ...complete,
      model: { ...complete.model, events: [{ ...complete.model.events[0], mode: 1 }] },
    })).toThrow('mode must be a string')
    expect(() => validateTypertManifest('pkg', { ...complete, model: { ...complete.model, objects: [null] } }))
      .toThrow('object must be an object')
    expect(() => validateTypertManifest('pkg', {
      ...complete,
      model: { ...complete.model, objects: [{ ...complete.model.objects[0], exportName: '' }] },
    })).toThrow('object has a missing or empty exportName')
  })

  it('requires and validates strict invocation descriptors', () => {
    const base = completeManifest(zodish)
    const { invocations: _invocations, ...missingInvocations } = base
    expect(() => validateTypertManifest('pkg', missingInvocations))
      .toThrow('TYPERT.invocations must be an array')

    const descriptor = strictInvocation()
    const manifest = { ...base, invocations: [descriptor] }
    expect(validateTypertManifest('pkg', manifest)).toBe(manifest)
    const cancellable = { ...descriptor, cancellation: { parameter: 'signal' } }
    expect(validateTypertManifest('pkg', { ...base, invocations: [cancellable] }).invocations)
      .toEqual([cancellable])
    const scoped = {
      ...descriptor,
      scope: { context: 'agent', wire: 'agentId' },
      parameters: [{
        name: 'agent',
        wire: 'agentId',
        source: 'lookup',
        lookup: 'agent',
        codec: strictCodec('pkg#AgentId'),
      }, ...descriptor.parameters],
    }
    expect(validateTypertManifest('pkg', { ...base, invocations: [scoped] }).invocations)
      .toEqual([scoped])

    expect(() => validateTypertManifest('pkg', { ...base, invocations: {} }))
      .toThrow('TYPERT.invocations must be an array')
    expect(() => validateTypertManifest('pkg', {
      ...base,
      invocations: [{ ...descriptor, invocation: { kind: 'future' } }],
    })).toThrow('receiver kind must be "direct" or "context"')
    expect(() => validateTypertManifest('pkg', {
      ...base,
      invocations: [{ ...descriptor, result: { mode: 'src-json' } }],
    })).toThrow('result codec must use a strict codec')
    expect(() => validateTypertManifest('pkg', {
      ...base,
      invocations: [{ ...descriptor, cancellation: null }],
    })).toThrow('cancellation must be an object')
    expect(() => validateTypertManifest('pkg', {
      ...base,
      invocations: [{ ...descriptor, cancellation: { parameter: 'abort' } }],
    })).toThrow('cancellation parameter must be "signal"')
    expect(() => validateTypertManifest('pkg', {
      ...base,
      invocations: [{ ...descriptor, result: { mode: 'strict', typeSymbol: 'pkg#Result', create: zodish } }],
    })).toThrow('result codec has no create() factory')
    expect(() => validateTypertManifest('pkg', {
      ...base,
      invocations: [{
        ...descriptor,
        parameters: [{ ...descriptor.parameters[0], source: 'future' }],
      }],
    })).toThrow('parameter source must be "json" or "lookup"')
    expect(() => validateTypertManifest('pkg', {
      ...base,
      invocations: [{
        ...descriptor,
        parameters: [{ ...descriptor.parameters[0], source: 'lookup' }],
      }],
    })).toThrow('lookup parameter has a missing or empty lookup')
    expect(() => validateTypertManifest('pkg', {
      ...base,
      invocations: [{
        ...descriptor,
        parameters: [{ ...descriptor.parameters[0], lookup: 'agent' }],
      }],
    })).toThrow('JSON parameter declares a lookup')
    expect(() => validateTypertManifest('pkg', {
      ...base,
      invocations: [{
        ...descriptor,
        parameters: [descriptor.parameters[0], { ...descriptor.parameters[0], name: 'again' }],
      }],
    })).toThrow('repeats wire field "request"')
    expect(() => validateTypertManifest('pkg', {
      ...base,
      invocations: [{
        ...descriptor,
        invocation: {
          kind: 'context',
          context: 'agent',
          wire: 'request',
          codec: strictCodec('pkg#AgentId'),
        },
      }],
    })).toThrow('repeats Context wire field "request"')
    expect(() => validateTypertManifest('pkg', {
      ...base,
      invocations: [{ ...scoped, scope: null }],
    })).toThrow('scope must be an object')
    expect(() => validateTypertManifest('pkg', {
      ...base,
      invocations: [{ ...scoped, scope: { wire: 'agentId' } }],
    })).toThrow('scope has a missing or empty context')
    expect(() => validateTypertManifest('pkg', {
      ...base,
      invocations: [{ ...scoped, scope: { context: 'agent' } }],
    })).toThrow('scope has a missing or empty wire')
    expect(() => validateTypertManifest('pkg', {
      ...base,
      invocations: [{
        ...scoped,
        invocation: {
          kind: 'context',
          context: 'agent',
          wire: 'scopeId',
          codec: strictCodec('pkg#AgentId'),
        },
      }],
    })).toThrow('Context receiver cannot declare a direct scope projection')
    expect(() => validateTypertManifest('pkg', {
      ...base,
      invocations: [{ ...scoped, scope: { context: 'agent', wire: 'missingId' } }],
    })).toThrow('must select its only lookup parameter')
    expect(() => validateTypertManifest('pkg', {
      ...base,
      invocations: [{
        ...scoped,
        parameters: [...scoped.parameters, {
          name: 'other',
          wire: 'otherId',
          source: 'lookup',
          lookup: 'agent',
          codec: strictCodec('pkg#AgentId'),
        }],
      }],
    })).toThrow('must select its only lookup parameter')
    expect(() => validateTypertManifest('pkg', {
      ...base,
      invocations: [{ ...scoped, scope: { context: 'other', wire: 'agentId' } }],
    })).toThrow('must select its only lookup parameter')
    expect(() => validateTypertManifest('pkg', {
      ...base,
      invocations: [{ ...descriptor, sourceLocation: { file: 'src/index.ts', line: 0, column: 1 } }],
    })).toThrow('sourceLocation.line must be a positive integer')
  })
})

function strictCodec(typeSymbol: string) {
  return { mode: 'strict', typeSymbol, create: () => z.string() }
}

function strictInvocation() {
  return {
    id: 'pkg#goals/create',
    service: 'goals',
    namespace: 'goals',
    method: 'create',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request',
      wire: 'request',
      source: 'json',
      codec: strictCodec('pkg#Request'),
    }],
    result: strictCodec('pkg#Result'),
    sourceLocation: { file: 'src/index.ts', line: 1, column: 1 },
  }
}

function completeManifest(zodish: object) {
  const member = { name: 'member', signature: 'member(): void', kind: 'method' }
  const type = { name: 'Value', declaration: 'export interface Value {}' }
  return {
    package: 'pkg',
    face: 'host',
    schemas: [{ name: 'Schema', create: () => zodish }],
    invocations: [],
    model: {
      services: [{
        key: 'service',
        exportName: 'Service',
        description: 'Service description.',
        summary: 'Service description.',
        jsDoc: '/** Service description. */',
        tags: [],
        members: [member],
        types: [type],
      }],
      events: [
        { name: 'event/with-mode', mode: 'emit', signature: "'event/with-mode'(): void", tags: [] },
        { name: 'event/without-mode', signature: "'event/without-mode'(): void", tags: [] },
      ],
      objects: [{
        name: 'Object',
        exportName: 'Object',
        tags: [],
        members: [member],
        types: [type],
      }],
    },
  }
}
