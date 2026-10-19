import { existsSync, globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { typertPlugin } from '../packages/typert/generator/src/tsdown-plugin.ts'
import { WorkspaceTypertGenerator } from '../packages/typert/generator/src/workspace.ts'
import { main } from './generate-typert.ts'
import { removeFixtureSafely } from './test-fixture-cleanup.ts'
import { WORKSPACE_TYPERT_FACES } from './typert-faces.ts'
import { DEPENDENT_TYPERT_SOURCE, setPublishedFiles, writeCompiledDependency, writeTypertWorkspace } from './typert-workspace.fixture.ts'

const REMOTE_CLIENT_FILES = ['typert.remote-client.js', 'typert.remote-client.d.ts', 'typert.remote-client.d.ts.map']

function workspace(source?: string): { root: string; pkg: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-generate-typert-'))
  onTestFinished(() => { removeFixtureSafely(root) })
  return { root, pkg: writeTypertWorkspace(root, source) }
}

/**
 * Spell `root` through a directory link, as a symbolic-link or Windows 8.3 short-name path does: module
 * resolution reports real paths, so the guard must classify files independently of the root's spelling.
 */
function linkedRoot(root: string): string {
  const parent = mkdtempSync(join(tmpdir(), 'dsh-generate-typert-link-'))
  onTestFinished(() => { rmSync(parent, { recursive: true, force: true }) })
  const link = join(parent, 'workspace')
  symlinkSync(root, link, 'junction')
  return link
}

function captureConsole(): { log: () => string; error: () => string } {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const text = (spy: typeof log) => (): string => spy.mock.calls.map(call => call.join(' ')).join('\n')
  return { log: text(log), error: text(error) }
}

function mapDependencyToSource(root: string): void {
  const basePath = join(root, 'tsconfig.base.json')
  const base = JSON.parse(readFileSync(basePath, 'utf8')) as { compilerOptions: Record<string, unknown> }
  writeFileSync(basePath, JSON.stringify({
    ...base,
    compilerOptions: { ...base.compilerOptions, paths: { '@fixture/dep/types': ['./packages/fixture/dep/src/types.ts'] } },
  }))
}

function typertOutputs(pkg: string): Record<string, string> {
  const output = join(pkg, 'lib')
  return Object.fromEntries(globSync('typert.*', { cwd: output }).sort()
    .map(file => [file, readFileSync(join(output, file)).toString('base64')]))
}

afterEach(() => { vi.restoreAllMocks() })

describe('bundle-free Typert pass', { timeout: 60_000 }, () => {
  it('writes the files the workspace-mode tsdown plugin writes, from a directory inside the workspace', async () => {
    const { pkg } = workspace()
    const plugin = typertPlugin({ mode: 'workspace', faces: WORKSPACE_TYPERT_FACES })
    plugin.buildStart({ cwd: pkg })
    await plugin.writeBundle({ dir: join(pkg, 'lib') })
    const bundled = typertOutputs(pkg)
    expect(Object.keys(bundled)).toEqual(['typert.host.d.ts', 'typert.host.js'])
    rmSync(join(pkg, 'lib'), { recursive: true })
    const output = captureConsole()

    expect(main([], join(pkg, 'src'))).toBe(0)

    expect(typertOutputs(pkg)).toEqual(bundled)
    expect(output.log()).toMatch(/^generate-typert: wrote 1 Typert artifact\(s\) for 1 package\(s\) in \d+\.\ds$/)
    expect(output.error()).toBe('')
  })

  it('writes the artifacts in-process generation returns and removes stale Remote client files', () => {
    const { root, pkg } = workspace()
    const [expected] = new WorkspaceTypertGenerator(root, { checkDiagnostics: false }).generateContributors(['host'])
    mkdirSync(join(pkg, 'lib'))
    for (const file of REMOTE_CLIENT_FILES) writeFileSync(join(pkg, 'lib', file), 'stale\n')
    captureConsole()

    expect(main([], root)).toBe(0)

    expect(readFileSync(join(pkg, 'lib/typert.host.js'), 'utf8')).toBe(expected?.js)
    expect(readFileSync(join(pkg, 'lib/typert.host.d.ts'), 'utf8')).toBe(expected?.dts)
    expect(REMOTE_CLIENT_FILES.filter(file => existsSync(join(pkg, 'lib', file)))).toEqual([])
  })

  it('reports a Typert analysis failure without changing artifact files', () => {
    const { root, pkg } = workspace()
    setPublishedFiles(pkg, ['lib/typert.host.d.ts'])
    mkdirSync(join(pkg, 'lib'))
    writeFileSync(join(pkg, 'lib/typert.host.js'), 'previous\n')
    const output = captureConsole()

    expect(main([], root)).toBe(1)

    expect(output.error().split('\n')).toEqual([
      `generate-typert: Typert analysis or emission failed; no artifact file changed (${root})`,
      '  TypertAnalysisError: typert(host): @fixture/probe package files must include lib/typert.host.js',
      'Fix the source, package.json, or tsconfig paths named above, then rerun this command or pnpm run typecheck.',
    ])
    expect(typertOutputs(pkg)).toEqual({ 'typert.host.js': Buffer.from('previous\n').toString('base64') })
    expect(output.log()).toBe('')
  })

  it.each(['real', 'linked'] as const)('rejects a Host program that loads a compiled workspace declaration and names the missing alias (%s root)', (spelling) => {
    const { root: realRoot, pkg } = workspace(DEPENDENT_TYPERT_SOURCE)
    writeCompiledDependency(realRoot)
    const root = spelling === 'real' ? realRoot : linkedRoot(realRoot)
    const output = captureConsole()

    expect(main([], root)).toBe(1)

    expect(output.error().split('\n').slice(1, 5)).toEqual([
      '  TypertAnalysisError: typert(host): the host program loads workspace build outputs instead of source; resolve each import below to source so that generation does not depend on package compilation:',
      '    packages/fixture/dep/lib/types/types.d.ts',
      "      imported as '@fixture/dep/types' by packages/fixture/probe/src/index.ts",
      '      add "@fixture/dep/types": ["./packages/fixture/dep/src/types.ts"] to the compilerOptions.paths of tsconfig.host.json or the config it extends',
    ])
    expect(existsSync(join(pkg, 'lib'))).toBe(false)

    mapDependencyToSource(root)
    expect(main([], root)).toBe(0)
    expect(Object.keys(typertOutputs(pkg))).toEqual(['typert.host.d.ts', 'typert.host.js'])
  })

  it.each(['real', 'linked'] as const)('rejects an unresolved workspace import before the package compiles and names the missing alias (%s root)', (spelling) => {
    const { root: realRoot, pkg } = workspace(DEPENDENT_TYPERT_SOURCE)
    writeCompiledDependency(realRoot, false)
    const root = spelling === 'real' ? realRoot : linkedRoot(realRoot)
    const output = captureConsole()

    expect(main([], root)).toBe(1)

    expect(output.error().split('\n').slice(1, 4)).toEqual([
      '  TypertAnalysisError: typert(host): the host program cannot resolve workspace imports, which would analyze as unknown types; map each import below to source:',
      "    '@fixture/dep/types' imported by packages/fixture/probe/src/index.ts",
      '      add "@fixture/dep/types": ["./packages/fixture/dep/src/types.ts"] to the compilerOptions.paths of tsconfig.host.json or the config it extends',
    ])
    expect(existsSync(join(pkg, 'lib'))).toBe(false)
  })

  it.each([false, true])('rejects a producer that reaches its own generated metadata through a source dependency (existing output: %s)', (compiled) => {
    const { root, pkg } = workspace(DEPENDENT_TYPERT_SOURCE)
    const dependency = writeCompiledDependency(root, false)
    writeFileSync(join(dependency, 'src/types.ts'), "export type Shape = import('@fixture/probe/typert').Payload\n")
    symlinkSync(pkg, join(root, 'node_modules/@fixture/probe'), 'junction')
    mapDependencyToSource(root)
    if (compiled) {
      mkdirSync(join(pkg, 'lib'))
      writeFileSync(join(pkg, 'lib/typert.host.d.ts'), 'export interface Payload { value: string }\n')
    }
    const output = captureConsole()

    expect(main([], root)).toBe(1)

    expect(output.error()).toContain(compiled ? 'loads workspace build outputs instead of source' : 'cannot resolve workspace imports')
    expect(output.error()).toContain('@fixture/probe/typert')
    expect(existsSync(join(pkg, 'lib/typert.host.js'))).toBe(false)
  })

  it('reports a failed write as a possibly mixed generation', () => {
    const { root, pkg } = workspace()
    writeFileSync(join(pkg, 'lib'), 'not a directory\n')
    const output = captureConsole()

    expect(main([], root)).toBe(1)

    const report = output.error()
    expect(report).toContain('generate-typert: writing Typert artifacts failed; packages written before the failure have new lib/typert.* files and the rest keep their previous files')
    expect(report).toMatch(/\n {2}Error: E(?:EXIST|NOTDIR)/)
    expect(report).toContain('until a run succeeds, lib/typert.* files may come from two generations.')
  })

  it('fails outside a workspace without writing', () => {
    const outside = mkdtempSync(join(tmpdir(), 'dsh-generate-typert-outside-'))
    onTestFinished(() => { removeFixtureSafely(outside) })
    const output = captureConsole()

    expect(main([], outside)).toBe(1)

    expect(output.error()).toContain(`no directory at or above the working directory holds tsconfig.host.json and packages/; no artifact file changed (${outside})`)
    expect(output.error()).toContain('Run the command from the repository root or a directory below it.')
  })

  it('rejects arguments before generating', () => {
    const { root, pkg } = workspace()
    const output = captureConsole()

    expect(main(['--root', root], root)).toBe(2)

    expect(output.error()).toBe(`generate-typert: expected no arguments, got ${JSON.stringify(['--root', root])}; usage: tsx scripts/generate-typert.ts`)
    expect(existsSync(join(pkg, 'lib'))).toBe(false)
  })
})
