import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceEmitResult } from '../src/workspace.ts'

const generated = vi.hoisted(() => vi.fn<() => WorkspaceEmitResult[]>(() => [
  {
    package: '@deepseek-ai/dsh-tools',
    packageRoot: 'packages/core/tools',
    face: 'host' as const,
    exports: [],
    js: 'export const host = true\n',
    dts: 'export declare const host: true\n',
    remote: {
      js: 'export const remote = true\n',
      dts: 'export declare const remote: true\n//# sourceMappingURL=typert.remote-client.d.ts.map\n',
      dtsMap: '{"version":3}\n',
    },
  },
  {
    package: '@deepseek-ai/dsh-tools',
    packageRoot: 'packages/core/tools',
    face: 'client' as const,
    exports: [],
    js: 'export const client = true\n',
    dts: 'export declare const client: true\n',
  },
  {
    package: '@fixture/remote-only',
    packageRoot: 'packages/remote-only',
    face: 'host' as const,
    exports: [],
    js: 'export const local = true\n',
    dts: 'export declare const local: true\n',
    remote: {
      js: 'export const remoteOnly = true\n',
      dts: 'export declare const remoteOnly: true\n//# sourceMappingURL=typert.remote-client.d.ts.map\n',
      dtsMap: '{"version":3}\n',
    },
  },
]))
const generatorRoots = vi.hoisted(() => [] as string[])

/** A Worker Thread double whose terminal events each test emits explicitly. */
class FakeWorker extends EventEmitter {
  readonly terminate = vi.fn(() => Promise.resolve(1))

  constructor(readonly entry: URL, readonly options: { readonly workerData: unknown; readonly execArgv?: readonly string[] }) {
    super()
    workers.push(this)
  }
}
const workers = vi.hoisted(() => [] as FakeWorker[])

vi.mock('node:worker_threads', () => ({ Worker: FakeWorker }))

vi.mock('../src/workspace.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/workspace.ts')>(),
  WorkspaceTypertGenerator: class {
    constructor(root: string) { generatorRoots.push(root) }
    generate = generated
  },
}))

const { TypertWorkerError, typertPlugin, decoratorPlugin } = await import('../src/tsdown-plugin.ts')
const roots: string[] = []

afterEach(() => {
  generated.mockClear()
  generatorRoots.splice(0)
  workers.splice(0)
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('typertPlugin', () => {
  it.each([['typertPlugin', typertPlugin], ['decoratorPlugin', decoratorPlugin]] as const)('lowers standard decorators in TypeScript source dependencies through %s', (_name, factory) => {
    const { transform } = factory()
    expect(transform.handler('export const value = 1\n', '/workspace/src/plain.ts')).toBeUndefined()
    expect(transform.handler('@sealed\nexport class Example {}\n', '/workspace/src/example.ts?raw')?.code)
      .not.toContain('@sealed')
    expect(transform.handler('@sealed\nexport class Example {}\n', '/workspace/lib/example.js?from=a.ts'))
      .toBeUndefined()
    expect(transform.handler('@sealed\nexport class View { render() { return <div /> } }\n', '/workspace/src/view.tsx')?.code)
      .toContain('react/jsx-runtime')
  })

  it('filters transform calls to TypeScript module ids', () => {
    const { filter } = typertPlugin().transform
    expect(['/w/a.ts', '/w/a.mts?x=1', '/w/a.cts', '/w/a.tsx', '/w/a.ts?raw.js'].map(id => filter.id.test(id)))
      .toEqual([true, true, true, true, true])
    expect(['/w/a.js', '/w/a.d.json', '/w/a.js?from=a.ts', '/w/a.tsv'].map(id => filter.id.test(id)))
      .toEqual([false, false, false, false])
  })

  it('skips outputs that do not identify a Typert contributor', async () => {
    const plugin = typertPlugin()
    expect(plugin.name).toBe('dsh-typert-generator')
    plugin.buildStart({ cwd: tmpdir() })
    await plugin.writeBundle({})

    const root = await workspace()
    const orphan = join(root, 'orphan', 'lib')
    await mkdir(orphan, { recursive: true })
    await plugin.writeBundle({ dir: orphan })

    const unnamed = await packageOutput(root, 'unnamed', {})
    await plugin.writeBundle({ dir: unnamed })
    const other = await packageOutput(root, 'other', { name: '@fixture/other' })
    await plugin.writeBundle({ dir: other })

    expect(generated).not.toHaveBeenCalled()
    expect(workers).toEqual([])
    await expect(plugin.writeBundle({ dir: join(root, '..', 'outside', 'lib') }))
      .rejects.toThrow('cannot find workspace root')
  })

  it('writes every generated face beside a nested package bundle', async () => {
    const root = await workspace()
    const output = await packageOutput(root, 'tools', {
      name: '@deepseek-ai/dsh-tools',
      exports: { './typert': './lib/typert.host.js' },
    }, 'lib/dev')
    const clientOutput = await packageOutput(root, 'client-tools', {
      name: '@deepseek-ai/dsh-tools',
      exports: { './client/typert': './lib/typert.client.js' },
    })

    const plugin = typertPlugin()
    await plugin.writeBundle({ dir: output })
    await plugin.writeBundle({ dir: clientOutput })

    expect(generated).toHaveBeenCalledOnce()
    expect(generated).toHaveBeenCalledWith()
    const packageLib = join(root, 'packages', 'tools', 'lib')
    expect(readFileSync(join(packageLib, 'typert.host.js'), 'utf8')).toBe('export const host = true\n')
    expect(readFileSync(join(packageLib, 'typert.host.d.ts'), 'utf8')).toBe('export declare const host: true\n')
    expect(readFileSync(join(packageLib, 'typert.client.js'), 'utf8')).toBe('export const client = true\n')
    expect(existsSync(join(packageLib, 'typert.client.d.ts'))).toBe(true)
    expect(readFileSync(join(packageLib, 'typert.remote-client.js'), 'utf8')).toBe('export const remote = true\n')
    expect(readFileSync(join(packageLib, 'typert.remote-client.d.ts'), 'utf8'))
      .toBe('export declare const remote: true\n//# sourceMappingURL=typert.remote-client.d.ts.map\n')
    expect(readFileSync(join(packageLib, 'typert.remote-client.d.ts.map'), 'utf8'))
      .toBe('{"version":3}\n')
    expect(readFileSync(join(root, 'packages/client-tools/lib/typert.client.js'), 'utf8'))
      .toBe('export const client = true\n')
  })

  it('generates a package opted in only through its Remote export', async () => {
    const root = await workspace()
    const output = await packageOutput(root, 'remote-only', {
      name: '@fixture/remote-only',
      exports: { './remote': './lib/typert.remote-client.js' },
    })

    await typertPlugin({ faces: ['host'] }).writeBundle({ dir: output })

    const packageLib = join(root, 'packages', 'remote-only', 'lib')
    expect(generated).toHaveBeenCalledOnce()
    expect(generated).toHaveBeenCalledWith(undefined, ['host'])
    expect(readFileSync(join(packageLib, 'typert.remote-client.js'), 'utf8'))
      .toBe('export const remoteOnly = true\n')
    expect(readFileSync(join(packageLib, 'typert.remote-client.d.ts'), 'utf8'))
      .toBe('export declare const remoteOnly: true\n//# sourceMappingURL=typert.remote-client.d.ts.map\n')
    expect(readFileSync(join(packageLib, 'typert.remote-client.d.ts.map'), 'utf8'))
      .toBe('{"version":3}\n')
  })

  it('removes stale Remote artifacts from a Host package without Remote output', async () => {
    const root = await workspace()
    const output = await packageOutput(root, 'tools', {
      name: '@deepseek-ai/dsh-tools',
      exports: { './typert': './lib/typert.host.js' },
    })
    const packageLib = join(root, 'packages', 'tools', 'lib')
    for (const file of [
      'typert.remote-client.js',
      'typert.remote-client.d.ts',
      'typert.remote-client.d.ts.map',
    ]) writeFileSync(join(packageLib, file), 'stale\n')
    generated.mockReturnValueOnce([{
      package: '@deepseek-ai/dsh-tools',
      packageRoot: 'packages/core/tools',
      face: 'host',
      exports: [],
      js: 'export const host = true\n',
      dts: 'export declare const host: true\n',
    }])

    await typertPlugin().writeBundle({ dir: output })

    for (const file of [
      'typert.remote-client.js',
      'typert.remote-client.d.ts',
      'typert.remote-client.d.ts.map',
    ]) expect(existsSync(join(packageLib, file))).toBe(false)
  })

  it('resolves the workspace root above a dual-face package leaf', async () => {
    const root = await workspace()
    const output = await packageOutput(root, 'api/gateway', {
      name: '@deepseek-ai/dsh-tools',
      exports: { './typert': './lib/typert.host.js' },
    })
    writeFileSync(join(root, 'packages/api/gateway/tsconfig.host.json'), '{}\n')

    await typertPlugin().writeBundle({ dir: output })
    const workspacePlugin = typertPlugin({ mode: 'workspace' })
    workspacePlugin.buildStart({ cwd: join(root, 'packages/api/gateway') })

    expect(generatorRoots).toEqual([root])
    expect(readFileSync(join(root, 'packages/api/gateway/lib/typert.host.js'), 'utf8'))
      .toBe('export const host = true\n')
    expect(workers.map(worker => worker.options.workerData)).toEqual([{ root, options: { checkDiagnostics: false } }])
  })
})

describe('typertPlugin workspace mode', () => {
  it('generates in one Worker Thread from the first buildStart and writes its artifacts once', async () => {
    const root = await workspace()
    const trigger = await packageOutput(root, 'typert/generator', { name: '@deepseek-ai/dsh-typert-generator' })
    const later = await packageOutput(root, 'core/tools', { name: '@deepseek-ai/dsh-tools' })
    const plugin = typertPlugin({ mode: 'workspace', faces: ['host'] })

    plugin.buildStart({ cwd: join(root, 'packages/typert/generator') })
    plugin.buildStart({ cwd: join(root, 'packages/core/tools') })
    const worker = onlyWorker()
    expect(worker.options).toMatchObject({
      workerData: { root, faces: ['host'], options: { checkDiagnostics: false } },
      execArgv: [],
    })
    expect(worker.entry.protocol).toBe('data:')

    let emitted = false
    const emission = plugin.writeBundle({ dir: trigger }).then(() => { emitted = true })
    await plugin.writeBundle({ dir: later })
    expect(emitted).toBe(false)
    expect(worker.terminate).not.toHaveBeenCalled()

    worker.emit('message', {
      kind: 'artifacts',
      artifacts: generated().filter(artifact => artifact.face === 'host'),
    })
    await emission
    worker.emit('exit', 1)
    await plugin.writeBundle({ dir: trigger })

    expect(worker.terminate).toHaveBeenCalledOnce()
    expect(workers).toHaveLength(1)
    expect(generatorRoots).toEqual([])
    expect(readFileSync(join(root, 'packages/core/tools/lib/typert.host.js'), 'utf8'))
      .toBe('export const host = true\n')
    expect(readFileSync(join(root, 'packages/core/tools/lib/typert.remote-client.d.ts.map'), 'utf8'))
      .toBe('{"version":3}\n')
    expect(readFileSync(join(root, 'packages/remote-only/lib/typert.remote-client.js'), 'utf8'))
      .toBe('export const remoteOnly = true\n')
  })

  it('starts generation from writeBundle when no buildStart ran', async () => {
    const root = await workspace()
    const output = await packageOutput(root, 'core/tools', { name: '@deepseek-ai/dsh-tools' })
    const plugin = typertPlugin({ mode: 'workspace' })

    const emission = plugin.writeBundle({ dir: output })
    const worker = onlyWorker()
    expect(worker.options.workerData).toEqual({ root, options: { checkDiagnostics: false } })
    worker.emit('message', { kind: 'artifacts', artifacts: [] })

    await expect(emission).resolves.toBeUndefined()
    expect(worker.terminate).toHaveBeenCalledOnce()
  })

  it('fails the bundle with the analysis failure the worker reports', async () => {
    const { emission, worker } = await claimedEmission()
    worker.emit('message', {
      kind: 'failure',
      name: 'TypertAnalysisError',
      message: 'typert(host): @fixture/x must export ./typert',
      stack: 'TypertAnalysisError: typert(host): @fixture/x must export ./typert\n    at worker',
    })

    const error = await rejection(emission)
    expect(error).toBeInstanceOf(TypertWorkerError)
    expect(error.message).toMatch(
      /^typert-generator: workspace generation for .+ failed: TypertAnalysisError: typert\(host\): @fixture\/x must export \.\/typert$/,
    )
    expect(error.cause).toBeInstanceOf(Error)
    expect((error.cause as Error).name).toBe('TypertAnalysisError')
    expect((error.cause as Error).stack).toContain('    at worker')
    expect(worker.terminate).toHaveBeenCalledOnce()
  })

  it('keeps a worker failure without a stack', async () => {
    const { emission, worker } = await claimedEmission()
    worker.emit('message', { kind: 'failure', name: 'Error', message: 'thrown value' })

    expect((await rejection(emission)).message).toContain('failed: Error: thrown value')
  })

  it.each([
    ['a non-object', 'artifacts'],
    ['an unknown kind', { kind: 'done' }],
    ['a non-array artifact list', { kind: 'artifacts', artifacts: {} }],
    ['an artifact without its declaration', { kind: 'artifacts', artifacts: [{ ...hostArtifact(), dts: 1 }] }],
    ['an artifact with an unknown face', { kind: 'artifacts', artifacts: [{ ...hostArtifact(), face: 'remote' }] }],
    ['an artifact with non-string exports', { kind: 'artifacts', artifacts: [{ ...hostArtifact(), exports: [1] }] }],
    ['an incomplete Remote artifact', { kind: 'artifacts', artifacts: [{ ...hostArtifact(), remote: { js: '', dts: '' } }] }],
    ['a failure without a message', { kind: 'failure', name: 'Error' }],
    ['a failure with a non-string stack', { kind: 'failure', name: 'Error', message: 'x', stack: 1 }],
  ])('rejects %s as a malformed worker response', async (_case, response) => {
    const { emission, worker } = await claimedEmission()
    worker.emit('message', response)

    expect((await rejection(emission)).message).toContain('received a malformed worker response')
    expect(worker.terminate).toHaveBeenCalledOnce()
  })

  it('fails the bundle when the worker crashes', async () => {
    const { emission, worker } = await claimedEmission()
    const crash = new Error('heap out of memory')
    worker.emit('error', crash)
    worker.emit('exit', 1)

    const error = await rejection(emission)
    expect(error.message).toContain('crashed: heap out of memory')
    expect(error.cause).toBe(crash)
    expect(worker.terminate).toHaveBeenCalledOnce()
  })

  it('fails the bundle when the worker exits without a response', async () => {
    const { emission, worker } = await claimedEmission()
    worker.emit('exit', 3)

    expect((await rejection(emission)).message).toContain('exited with code 3 before reporting artifacts')
  })

  it('fails the bundle when the worker response cannot be deserialized', async () => {
    const { emission, worker } = await claimedEmission()
    worker.emit('messageerror', new Error('DataCloneError'))

    expect((await rejection(emission)).message).toContain('could not be deserialized')
  })

  it('fails the bundle when the worker cannot be terminated', async () => {
    const { emission, worker } = await claimedEmission()
    const failure = new Error('terminate failed')
    worker.terminate.mockReturnValueOnce(Promise.reject(failure))
    worker.emit('message', { kind: 'artifacts', artifacts: [hostArtifact()] })

    const error = await rejection(emission)
    expect(error.message).toContain('could not terminate its worker')
    expect(error.cause).toBe(failure)
  })
})

function hostArtifact(): WorkspaceEmitResult {
  return {
    package: '@deepseek-ai/dsh-tools',
    packageRoot: 'packages/core/tools',
    face: 'host',
    exports: ['TYPERT'],
    js: 'export const host = true\n',
    dts: 'export declare const host: true\n',
  }
}

function onlyWorker(): FakeWorker {
  expect(workers).toHaveLength(1)
  return workers[0] as FakeWorker
}

async function claimedEmission(): Promise<{ readonly emission: Promise<void>; readonly worker: FakeWorker }> {
  const root = await workspace()
  const output = await packageOutput(root, 'core/tools', { name: '@deepseek-ai/dsh-tools' })
  const plugin = typertPlugin({ mode: 'workspace' })
  plugin.buildStart({ cwd: join(root, 'packages/core/tools') })
  return { emission: plugin.writeBundle({ dir: output }), worker: onlyWorker() }
}

async function rejection(promise: Promise<void>): Promise<Error> {
  const error = await promise.then(() => undefined, (reason: unknown) => reason)
  if (!(error instanceof Error)) throw new Error('expected the bundle to fail')
  return error
}

async function workspace(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-typert-tsdown-'))
  roots.push(root)
  writeFileSync(join(root, 'tsconfig.host.json'), '{}\n')
  await mkdir(join(root, 'packages'))
  return root
}

async function packageOutput(
  root: string,
  directory: string,
  manifest: Record<string, unknown>,
  output = 'lib',
): Promise<string> {
  const packageRoot = join(root, 'packages', directory)
  const result = join(packageRoot, output)
  await mkdir(result, { recursive: true })
  writeFileSync(join(packageRoot, 'package.json'), `${JSON.stringify(manifest)}\n`)
  return result
}
