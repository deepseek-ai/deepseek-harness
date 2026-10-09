import { spawnSync } from 'node:child_process'
import { globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { buildLibraryArtifacts, compileReferencedProjects } from './compile-referenced-projects.ts'
import { runCiBench } from './run-ci-bench.ts'
import { removeFixtureSafely } from './test-fixture-cleanup.ts'

const compiler = fileURLToPath(import.meta.resolve('typescript/bin/tsc'))

function fixture(): { root: string; leaf: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-referenced-projects-'))
  onTestFinished(() => { removeFixtureSafely(root) })
  const leaf = join(root, 'leaf package')
  mkdirSync(join(leaf, 'src'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }))
  writeFileSync(join(leaf, 'src/index.ts'), 'export const value: number = 42\n')
  const compilerOptions = {
    target: 'ES2024',
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    lib: ['ES2024'],
    types: [],
    composite: true,
    strict: true,
  }
  writeFileSync(join(leaf, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      ...compilerOptions,
      rootDir: 'src',
      outDir: 'lib/types',
      declaration: true,
      declarationMap: true,
      sourceMap: true,
    },
    include: ['src'],
  }))
  writeFileSync(join(root, 'aggregate.ts'), 'import { value } from "./leaf package/src/index.js"\nexport const aggregate: number = value\n')
  for (const face of ['host', 'client']) {
    writeFileSync(join(root, `tsconfig.${face}.json`), JSON.stringify({
      compilerOptions: { ...compilerOptions, noEmit: true },
      include: ['aggregate.ts'],
      references: [{ path: './leaf package' }],
    }))
  }
  return { root, leaf }
}

function artifacts(leaf: string): Record<string, string> {
  const output = join(leaf, 'lib')
  return Object.fromEntries(globSync('**/*', { cwd: output })
    .filter(path => statSync(join(output, path)).isFile())
    .sort()
    .map(path => [path.replaceAll('\\', '/'), readFileSync(join(output, path)).toString('base64')]))
}

function recordedCommands(root: string, failHostBundle = false): () => { args: string[]; title: string }[] {
  const log = join(root, 'commands.jsonl')
  const entrypoint = join(root, 'pnpm', 'bin', 'pnpm.cjs')
  mkdirSync(join(root, 'pnpm', 'bin'), { recursive: true })
  writeFileSync(entrypoint, [
    'const { appendFileSync } = require("node:fs")',
    'const args = process.argv.slice(2)',
    `appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, title: process.env.DSH_CLIENT_TITLE }) + "\\n")`,
    ...failHostBundle ? ['if (args.includes("host")) process.exit(7)'] : [],
  ].join('\n') + '\n')
  vi.stubEnv('npm_execpath', entrypoint)
  vi.stubEnv('DSH_CLIENT_TITLE', 'Inherited Build Title')
  onTestFinished(() => { vi.unstubAllEnvs() })
  return () => readFileSync(log, 'utf8').trim().split('\n')
    .map(line => JSON.parse(line) as { args: string[]; title: string })
}

describe('internal artifact build order', () => {
  it('resolves pnpm for a direct CLI without npm_execpath and preserves its environment', () => {
    const { root } = fixture()
    const marker = join(root, 'direct-cli-title.txt')
    const environment: NodeJS.ProcessEnv = { ...process.env, DSH_CLIENT_TITLE: 'Direct CLI Title' }
    delete environment.npm_execpath
    const helper = pathToFileURL(resolve(import.meta.dirname, 'compile-referenced-projects.ts')).href
    const code = `import { runPnpmCommand } from ${JSON.stringify(helper)}; runPnpmCommand(${JSON.stringify(root)}, ${JSON.stringify([
      'exec', process.execPath, '-e',
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, process.env.DSH_CLIENT_TITLE)`,
    ])})`
    const result = spawnSync(process.execPath, [
      '--import', import.meta.resolve('tsx/esm'),
      '--input-type=module', '-e', code,
    ], { cwd: root, env: environment, encoding: 'utf8' })

    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(readFileSync(marker, 'utf8')).toBe('Direct CLI Title')
  })

  it.each([true, false])('preserves bundler order and the public environment with hostOnly=%s', (hostOnly) => {
    const { root } = fixture()
    const commands = recordedCommands(root)

    buildLibraryArtifacts(root, hostOnly)

    const expected = [
      ['exec', 'tsdown', '--config-loader', 'native', '--env.DSH_BUILD_FACE', 'host'],
      ['--filter', '@deepseek-ai/dsh-desktop', 'run', 'bundle'],
      ...hostOnly ? [] : [['exec', 'tsdown', '--config-loader', 'native', '--env.DSH_BUILD_FACE', 'client']],
    ]
    expect(commands()).toEqual(expected.map(args => ({ args, title: 'Inherited Build Title' })))
  })

  it('stops after a failed Host bundler before Desktop and Client builds', () => {
    const { root } = fixture()
    const commands = recordedCommands(root, true)

    expect(() => { buildLibraryArtifacts(root, false) }).toThrow('exited with 7')
    expect(commands()).toHaveLength(1)
  })

  it('defers benchmark diagnostics while normal artifact builds reject the same source', () => {
    const { root, leaf } = fixture()
    const commands = recordedCommands(root)
    writeFileSync(join(leaf, 'src/index.ts'), 'export const value: number = "invalid"\n')

    runCiBench(root)

    expect(commands()).toEqual([
      ['run', 'build:native-system'],
      ['exec', 'tsdown', '--config-loader', 'native', '--env.DSH_BUILD_FACE', 'host'],
      ['--filter', '@deepseek-ai/dsh-desktop', 'run', 'bundle'],
      ['exec', 'tsdown', '--config-loader', 'native', '--env.DSH_BUILD_FACE', 'client'],
      ['exec', 'tsdown', '--config-loader', 'native', '--config', 'benchmarks/tsdown.config.ts'],
      ['run', 'build:web'],
      ['run', 'test:bench:built'],
    ].map(args => ({ args, title: 'Inherited Build Title' })))

    expect(() => { buildLibraryArtifacts(root, false) }).toThrow('host compiler exited with')
    expect(commands()).toHaveLength(7)
  })
})

describe('package project compilation', () => {
  it('records Windows-style glob keys without changing artifact bytes', () => {
    const { leaf } = fixture()
    const output = join(leaf, 'lib')
    mkdirSync(join(output, 'types'), { recursive: true })
    const bytes = Buffer.from([0, 255, 13, 10])
    writeFileSync(join(output, 'types\\index.js'), bytes)

    expect(artifacts(leaf)).toEqual({ 'types/index.js': bytes.toString('base64') })
  })

  it.each(['host', 'client'] as const)('preserves every %s package artifact byte', (face) => {
    const { root, leaf } = fixture()
    const complete = spawnSync(process.execPath, [compiler, '-b', `tsconfig.${face}.json`], {
      cwd: root,
      encoding: 'utf8',
    })
    expect(complete.status, complete.stdout + complete.stderr).toBe(0)
    const expected = artifacts(leaf)
    expect(Object.keys(expected)).toEqual(expect.arrayContaining([
      'types/index.js', 'types/index.js.map', 'types/index.d.ts', 'types/index.d.ts.map',
    ]))
    rmSync(join(leaf, 'lib'), { recursive: true })

    compileReferencedProjects(root, face)

    expect(artifacts(leaf)).toEqual(expected)
  })

  it.each(['host', 'client'] as const)('preserves %s runtime output during benchmark emission', (face) => {
    const { root, leaf } = fixture()
    writeFileSync(join(leaf, 'src/support.ts'), [
      'export interface Payload { label: string }',
      'export const enum Offset { Baseline = 40 }',
      '',
    ].join('\n'))
    writeFileSync(join(leaf, 'src/index.ts'), [
      'import { Offset, type Payload } from "./support.js"',
      'export const value: number = Offset.Baseline + 2',
      'export function describe(payload: Payload): string { return `${payload.label}: ${value}` }',
      '',
    ].join('\n'))
    compileReferencedProjects(root, face)
    const runtimeArtifacts = () => Object.fromEntries(Object.entries(artifacts(leaf))
      .filter(([path]) => /\.js(?:\.map)?$/.test(path)))
    const expected = runtimeArtifacts()
    expect(Object.keys(expected)).toEqual([
      'types/index.js', 'types/index.js.map', 'types/support.js', 'types/support.js.map',
    ])
    rmSync(join(leaf, 'lib'), { recursive: true })

    compileReferencedProjects(root, face, 'benchmark-emit')

    expect(runtimeArtifacts()).toEqual(expected)
    const entrypoint = pathToFileURL(join(leaf, 'lib/types/index.js')).href
    const result = spawnSync(process.execPath, [
      '--input-type=module', '-e',
      `import { describe } from ${JSON.stringify(entrypoint)}; console.log(describe({ label: 'answer' }))`,
    ], { cwd: root, encoding: 'utf8' })
    expect(result.error).toBeUndefined()
    expect(result.signal).toBeNull()
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.trim()).toBe('answer: 42')
  })

  it.each(['host', 'client'] as const)('rechecks %s semantic errors after benchmark emission without forcing a rebuild', (face) => {
    const { root, leaf } = fixture()
    writeFileSync(join(leaf, 'src/index.ts'), 'export const value: number = "invalid"\n')

    compileReferencedProjects(root, face, 'benchmark-emit')

    expect(Object.keys(artifacts(leaf)).some(path => path.endsWith('.tsbuildinfo'))).toBe(true)
    const complete = spawnSync(process.execPath, [compiler, '-b', `tsconfig.${face}.json`], {
      cwd: root,
      encoding: 'utf8',
    })
    expect(complete.error).toBeUndefined()
    expect(complete.signal).toBeNull()
    expect(complete.status).not.toBe(0)
    expect(complete.stdout).toContain('src/index.ts(1,14): error TS2322')
  })

  it('rejects package syntax errors during benchmark emission', () => {
    const { root, leaf } = fixture()
    writeFileSync(join(leaf, 'src/index.ts'), 'export const value = ;\n')

    expect(() => { compileReferencedProjects(root, 'host', 'benchmark-emit') })
      .toThrow('host compiler exited with')
  })

  it('keeps aggregate-only errors in the complete compiler check', () => {
    const { root } = fixture()
    writeFileSync(join(root, 'aggregate.ts'), 'export const aggregate: number = "invalid"\n')

    expect(() => { compileReferencedProjects(root, 'host') }).not.toThrow()
    const complete = spawnSync(process.execPath, [compiler, '-b', 'tsconfig.host.json'], {
      cwd: root,
      encoding: 'utf8',
    })
    expect(complete.status).not.toBe(0)
    expect(complete.stdout).toContain('aggregate.ts(1,14): error TS2322')
  })

  it('rejects package source errors', () => {
    const { root, leaf } = fixture()
    writeFileSync(join(leaf, 'src/index.ts'), 'export const value: number = "invalid"\n')

    expect(() => { compileReferencedProjects(root, 'host') }).toThrow('host compiler exited with')
  })

  it.each([undefined, []])('rejects an aggregate with missing or empty references: %j', (references) => {
    const { root } = fixture()
    writeFileSync(join(root, 'tsconfig.host.json'), JSON.stringify({ files: [], references }))

    expect(() => { compileReferencedProjects(root, 'host') }).toThrow('requires non-empty project references')
  })

  it('rejects a missing referenced project', () => {
    const { root } = fixture()
    writeFileSync(join(root, 'tsconfig.host.json'), JSON.stringify({
      compilerOptions: { noEmit: true },
      files: [],
      references: [{ path: './absent' }],
    }))

    expect(() => { compileReferencedProjects(root, 'host') }).toThrow('host compiler exited with')
  })

  it.each([undefined, false])('rejects an aggregate capable of emitting files: noEmit=%s', (noEmit) => {
    const { root } = fixture()
    writeFileSync(join(root, 'tsconfig.host.json'), JSON.stringify({
      compilerOptions: { noEmit },
      include: ['aggregate.ts'],
      references: [{ path: './leaf package' }],
    }))

    expect(() => { compileReferencedProjects(root, 'host') }).toThrow(
      `${join(root, 'tsconfig.host.json')} requires noEmit: true`,
    )
  })

  it('rejects a missing aggregate config', () => {
    const { root } = fixture()
    rmSync(join(root, 'tsconfig.host.json'))

    expect(() => { compileReferencedProjects(root, 'host') }).toThrow('Cannot read file')
  })

  it('rejects invalid compiler options', () => {
    const { root } = fixture()
    writeFileSync(join(root, 'tsconfig.host.json'), JSON.stringify({
      compilerOptions: { target: 'invalid' },
      files: [],
      references: [{ path: './leaf package' }],
    }))

    expect(() => { compileReferencedProjects(root, 'host') }).toThrow("Argument for '--target' option must be")
  })

  it('rejects an unsupported build mode before building', () => {
    const repository = resolve(import.meta.dirname, '..')
    const result = spawnSync(process.execPath, [
      '--import', 'tsx/esm',
      resolve(repository, 'scripts/compile-referenced-projects.ts'),
      'unsupported',
    ], { cwd: repository, encoding: 'utf8' })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('expected exactly one mode: host, client, host-libraries, or libraries')
  })
})
