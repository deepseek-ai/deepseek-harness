import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'
import { execa } from 'execa'
import { afterEach, describe, expect, it } from 'vitest'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const runner = fileURLToPath(new URL('./publint-all.ts', import.meta.url))
const roots: string[] = []
const children: Array<{ kill: () => void; closed: Promise<unknown> }> = []

afterEach(async () => {
  // A test timeout can reach teardown before the test's pending await settles.
  const ownedRoots = roots.splice(0)
  await Promise.all(children.splice(0).map(async ({ kill, closed }) => {
    kill()
    await closed
  }))
  for (const root of ownedRoots) rmSync(root, { recursive: true, force: true })
})

function fixture(options: {
  exportPath?: string
  indexSource?: string
  files?: Record<string, string>
} = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-publint-all-'))
  roots.push(root)
  const packageDir = join(root, 'packages/core/probe')
  mkdirSync(join(packageDir, 'lib'), { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), `${JSON.stringify({
    name: '@deepseek-ai/dsh-probe',
    version: '0.0.1',
    type: 'module',
    license: 'MIT',
    engines: { node: '>=22.19' },
    sideEffects: false,
    files: ['lib'],
    exports: { '.': { default: options.exportPath ?? './lib/index.js' } },
  }, null, 2)}\n`)
  writeFileSync(join(packageDir, 'README.md'), '# Probe\n')
  writeFileSync(join(packageDir, 'lib/index.js'), options.indexSource ?? 'export const probe = true\n')
  for (const [path, source] of Object.entries(options.files ?? {})) {
    mkdirSync(join(packageDir, path, '..'), { recursive: true })
    writeFileSync(join(packageDir, path), source)
  }
  writeFileSync(join(packageDir, 'unpublished.js'), 'export const hidden = true\n')
  return root
}

/** Own direct Node children until close; Vitest's signal supplies the lane deadline. */
function start(args: string[], signal: AbortSignal, cwd = repositoryRoot) {
  const child = execa(process.execPath, args, {
    cwd,
    cancelSignal: signal,
    killSignal: 'SIGKILL',
    reject: false,
    stdin: 'ignore',
    stripFinalNewline: false,
  })
  // `error` is an outcome, not the completion edge for the process and its pipes.
  const closed = new Promise<void>(resolve => child.nodeChildProcess.once('close', () => { resolve() }))
  const result = Promise.all([child, closed]).then(([result]) => result)
  children.push({ kill: () => { child.kill('SIGKILL') }, closed: result })
  return { child, result }
}

function expectCompleted(result: Awaited<ReturnType<typeof start>['result']>) {
  const diagnostics = [
    `publint subprocess: error=${String(result.cause)}; signal=${String(result.signal)}; exitCode=${String(result.exitCode)}`,
    `canceled=${result.isCanceled}; timedOut=${result.timedOut}`,
    result.shortMessage ?? '',
    `stdout:\n${result.stdout}`,
    `stderr:\n${result.stderr}`,
  ].join('\n')
  expect(result.cause, diagnostics).toBeUndefined()
  expect(result.isCanceled, diagnostics).toBe(false)
  expect(result.timedOut, diagnostics).toBe(false)
  expect(result.signal, diagnostics).toBeUndefined()
}

async function run(root: string, signal: AbortSignal) {
  const { result } = start([
    '--import', 'tsx', runner,
    '--packages-root', root,
  ], signal)
  const completed = await result
  expectCompleted(completed)
  return completed
}

describe('publint package runner', () => {
  it('reports deadline cancellation after every owned child closes', async ({ signal }) => {
    const deadline = new AbortController()
    const active = [0, 1].map(() => start([
      '-e', "process.stderr.write('probe stderr\\n'); process.stdout.write('ready\\n'); setInterval(() => {}, 1000)",
    ], AbortSignal.any([signal, deadline.signal])))
    const closed = active.map(() => false)
    active.forEach(({ child }, index) => child.nodeChildProcess.once('close', () => { closed[index] = true }))
    await Promise.all(active.map(({ child }) => once(child.stdout, 'data', { signal })))
    expect(closed).toEqual([false, false])
    // Start the deadline only after both children announce readiness; startup speed is not the oracle.
    const timer = setTimeout(() => { deadline.abort(new DOMException('fixture deadline expired', 'TimeoutError')) }, 0)
    try {
      const results = await Promise.all(active.map(({ result }) => result))
      expect(closed).toEqual([true, true])
      for (const [index, result] of results.entries()) {
        expect(result.isCanceled).toBe(true)
        expect(() => { expectCompleted(result) }).toThrow(/publint subprocess: error=TimeoutError: fixture deadline expired; signal=/)
        expect(() => { expectCompleted(result) }).toThrow(/canceled=true/)
        expect(() => { expectCompleted(result) }).toThrow(/ready/)
        expect(() => { expectCompleted(result) }).toThrow(/probe stderr/)
        expect(() => process.kill(active[index]!.child.pid!, 0)).toThrow(/ESRCH/)
      }
    } finally {
      clearTimeout(timer)
    }
  })

  it('reports spawn errors before checking the expected exit code', async ({ signal }) => {
    const { result } = start(['-e', ''], signal, join(fixture(), 'missing-cwd'))
    const completed = await result
    expect(completed.cause).toMatchObject({ code: 'ENOENT' })
    expect(() => { expectCompleted(completed) }).toThrow(/publint subprocess: error=.*ENOENT.*; signal=undefined/)
  })

  it('lints recursively declared files from an in-memory publication view', async ({ signal }) => {
    const result = await run(fixture(), signal)
    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.stdout).toContain('linting 1 package(s)')
    expect(result.stdout).toContain('All good!')
  })

  it('rejects an export that exists in the workspace but is not published', async ({ signal }) => {
    const result = await run(fixture({ exportPath: './unpublished.js' }), signal)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('unpublished.js')
  })

  it('rejects a public export whose built file is missing', async ({ signal }) => {
    const result = await run(fixture({ exportPath: './lib/missing.js' }), signal)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('missing.js')
  })

  it('accepts published relative JavaScript and CSS targets', async ({ signal }) => {
    const result = await run(fixture({
      indexSource: "export { helper } from './helper.js'\nimport './theme.css'\n",
      files: {
        'lib/helper.js': 'export const helper = true\n',
        'lib/theme.css': ':root {}\n',
      },
    }), signal)
    expect(result.exitCode, result.stderr).toBe(0)
  })

  it('rejects unpublished relative JavaScript and CSS targets', async ({ signal }) => {
    const result = await run(fixture({
      indexSource: "export { helper } from './missing.js'\nimport './missing.css'\n",
    }), signal)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('imports "./missing.js"')
    expect(result.stderr).toContain('imports "./missing.css"')
  })
})
