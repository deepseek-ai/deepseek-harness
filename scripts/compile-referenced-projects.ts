/**
 * Compile and bundle package projects without repeating aggregate test and script typechecks.
 * Contract steps replace the Host bundle with the bundle-free Typert pass for consumers that read
 * only declarations.
 */

import { spawn, spawnSync } from 'node:child_process'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import ts from 'typescript'
import { pnpmCommand } from './release/process.ts'

type CompilationMode = 'checked' | 'benchmark-emit'

/** Identifier of one package-library build step. */
export type LibraryStepId = 'host-src' | 'host-bundle' | 'host-typert' | 'desktop-bundle' | 'client-src' | 'client-bundle'

/** One package-library build step as a shell-free child-process invocation. */
export interface LibraryStep {
  readonly id: LibraryStepId
  /** Name used in progress and failure reports. */
  readonly label: string
  /** Short command shown in failure reports; reference lists are summarized. */
  readonly displayCommand: string
  readonly command: string
  readonly args: readonly string[]
  /** Steps that must succeed first; together they repeat the serial library order. */
  readonly needs: readonly LibraryStepId[]
}

/**
 * Run one package-manager command serially with the inherited build environment.
 * @param root - Repository root supplying the command's working directory.
 * @param args - Package-manager arguments, without shell quoting.
 * @throws If the command cannot start or exits unsuccessfully.
 */
export function runPnpmCommand(root: string, args: readonly string[]): void {
  const [command, ...prefix] = pnpmCommand()
  const result = spawnSync(command, [...prefix, ...args], { cwd: root, stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`compile-referenced-projects: pnpm ${args.join(' ')} exited with ${String(result.status ?? result.signal)}`)
  }
}

/**
 * Resolve the Node arguments that compile one aggregate's project references with the serial TypeScript builder.
 * @param root - Repository root containing the aggregate tsconfig.
 * @param face - Independent compiler face whose package projects are emitted.
 * @param mode - Check package types by default; benchmark emission defers diagnostics to required full builds.
 * @returns Arguments for `process.execPath`, including the heap limit the Host face needs.
 * @throws If the aggregate configuration is invalid, has no references, or can emit files.
 */
export function referencedProjectsCompilerArgs(
  root: string,
  face: 'host' | 'client',
  mode: CompilationMode = 'checked',
): string[] {
  const configPath = resolve(root, `tsconfig.${face}.json`)
  const config = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic(diagnostic) {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
    },
  })
  if (config === undefined) throw new Error(`compile-referenced-projects: cannot read ${configPath}`)
  const references = config.projectReferences
  if (references === undefined || references.length === 0) {
    throw new Error(`compile-referenced-projects: ${configPath} requires non-empty project references`)
  }
  if (config.errors.length > 0) {
    throw new Error(config.errors
      .map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
      .join('\n'))
  }
  if (config.options.noEmit !== true) {
    throw new Error(`compile-referenced-projects: ${configPath} requires noEmit: true to exclude its aggregate program`)
  }
  return [
    ...hostHeapArgs(face),
    fileURLToPath(import.meta.resolve('typescript/bin/tsc')),
    '-b',
    ...mode === 'benchmark-emit' ? ['--noCheck'] : [],
    // Relative arguments keep the complete workspace graph below Windows' command-line limit.
    ...references.map(reference => relative(root, reference.path)),
  ]
}

/**
 * Resolve the Node arguments that type-check one aggregate's own test and script program in project mode.
 * Project mode reads the declarations that its references already emitted and never compiles a reference,
 * so missing package outputs surface as compiler diagnostics.
 * @param face - Compiler face whose aggregate program is checked.
 * @returns Arguments for `process.execPath`, run from the repository root.
 */
export function aggregateCheckArgs(face: 'host' | 'client'): string[] {
  return [...hostHeapArgs(face), fileURLToPath(import.meta.resolve('typescript/bin/tsc')), '-p', `tsconfig.${face}.json`]
}

/**
 * Resolve the Node arguments that type-check one aggregate's own test and script program in build mode.
 * Build mode skips the program when its tsbuildinfo is current; callers run it only after the
 * aggregate's references are compiled, so it finds every reference up to date and compiles none.
 * @param face - Compiler face whose aggregate program is checked.
 * @returns Arguments for `process.execPath`, run from the repository root.
 */
export function aggregateBuildArgs(face: 'host' | 'client'): string[] {
  return [...hostHeapArgs(face), fileURLToPath(import.meta.resolve('typescript/bin/tsc')), '-b', `tsconfig.${face}.json`]
}

function hostHeapArgs(face: 'host' | 'client'): string[] {
  return face === 'host' ? ['--max-old-space-size=4096'] : []
}

/**
 * Compile one aggregate's project references with the serial TypeScript builder.
 * @param root - Repository root containing the aggregate tsconfig.
 * @param face - Independent compiler face whose package projects are emitted.
 * @param mode - Check package types by default; benchmark emission defers diagnostics to required full builds.
 * @throws If the aggregate emits files, its configuration is invalid, or package compilation fails.
 */
export function compileReferencedProjects(
  root: string,
  face: 'host' | 'client',
  mode: CompilationMode = 'checked',
): void {
  runStep(root, compilerStep(root, face, mode, []))
}

function compilerStep(
  root: string,
  face: 'host' | 'client',
  mode: CompilationMode,
  needs: readonly LibraryStepId[],
): LibraryStep {
  return {
    id: face === 'host' ? 'host-src' : 'client-src',
    label: `${face} compiler`,
    displayCommand: `tsc -b${mode === 'benchmark-emit' ? ' --noCheck' : ''} <tsconfig.${face}.json references>`,
    command: process.execPath,
    args: referencedProjectsCompilerArgs(root, face, mode),
    needs,
  }
}

// Typert reads workspace packages only from source (generate-typert.ts
// rejects build outputs), so it needs no compiled package. It runs under tsx's
// ESM hook rather than through `pnpm exec`, whose startup would lengthen the
// critical path before Client compilation.
function typertStep(): LibraryStep {
  return {
    id: 'host-typert',
    label: 'Host Typert',
    displayCommand: 'tsx scripts/generate-typert.ts',
    command: process.execPath,
    args: ['--import', import.meta.resolve('tsx/esm'), fileURLToPath(new URL('generate-typert.ts', import.meta.url))],
    needs: [],
  }
}

function pnpmStep(id: LibraryStepId, label: string, args: readonly string[], needs: readonly LibraryStepId[]): LibraryStep {
  const [command, ...prefix] = pnpmCommand()
  return { id, label, displayCommand: `pnpm ${args.join(' ')}`, command, args: [...prefix, ...args], needs }
}

/**
 * List the package-library build steps in Host, Desktop, then Client dependency order.
 * Host bundling runs Typert, whose Remote declarations Client compilation imports.
 * @param root - Repository root containing the compiler and bundle configurations.
 * @param faces - `host` lists Host compilation and bundling, which produce the Typert outputs; `all` adds Desktop and Client.
 * @param mode - Check package types by default; benchmark emission defers diagnostics to required full builds.
 * @returns The ordered steps; each step needs its predecessor.
 * @throws If an aggregate configuration is invalid.
 */
export function libraryBuildSteps(root: string, faces: 'host' | 'all', mode: CompilationMode = 'checked'): LibraryStep[] {
  const host: LibraryStep[] = [
    compilerStep(root, 'host', mode, []),
    pnpmStep('host-bundle', 'Host bundle', ['exec', 'tsdown', '--config-loader', 'native', '--env.DSH_BUILD_FACE', 'host'], ['host-src']),
  ]
  if (faces === 'host') return host
  return [
    ...host,
    pnpmStep('desktop-bundle', 'Desktop bundle', ['--filter', '@deepseek-ai/dsh-desktop', 'run', 'bundle'], ['host-bundle']),
    compilerStep(root, 'client', mode, ['desktop-bundle']),
    pnpmStep('client-bundle', 'Client bundle', ['exec', 'tsdown', '--config-loader', 'native', '--env.DSH_BUILD_FACE', 'client'], ['client-src']),
  ]
}

/**
 * List the bundle-free package steps that produce every declaration the type checkers, oxlint, and
 * documentation checks read: Host compilation and the Typert pass, which writes the generated
 * Typert declarations from source without bundling, run independently; Client compilation, which
 * imports both, needs the two. Unlike {@link libraryBuildSteps}, no step writes runnable bundles.
 * @param root - Repository root containing the compiler configurations.
 * @param faces - `host` lists Host compilation and the Typert pass; `all` adds Client compilation.
 * @returns The steps in report order.
 * @throws If an aggregate configuration is invalid.
 */
export function contractSteps(root: string, faces: 'host' | 'all'): LibraryStep[] {
  const host = [compilerStep(root, 'host', 'checked', []), typertStep()]
  if (faces === 'host') return host
  return [...host, compilerStep(root, 'client', 'checked', ['host-src', 'host-typert'])]
}

function runStep(root: string, step: LibraryStep): void {
  const result = spawnSync(step.command, step.args, { cwd: root, stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw stepFailure(step, result.status ?? result.signal)
}

function runStepConcurrently(root: string, step: LibraryStep): Promise<void> {
  return new Promise((settle, fail) => {
    const child = spawn(step.command, step.args, { cwd: root, stdio: 'inherit' })
    child.once('error', fail)
    child.once('close', (code, signal) => {
      if (code === 0) settle()
      else fail(stepFailure(step, code ?? signal))
    })
  })
}

function stepFailure(step: LibraryStep, exit: number | NodeJS.Signals | null): Error {
  return new Error(`compile-referenced-projects: ${step.label} exited with ${String(exit)}`)
}

/**
 * Emit package libraries serially in Host, Desktop, then Client dependency order.
 * @param root - Repository root containing the compiler and bundle configurations.
 * @param hostOnly - Stop after Host compilation and bundling, which produce the Typert outputs.
 * @param mode - Check package types by default; benchmark emission defers diagnostics to required full builds.
 * @throws If any compiler or bundler fails.
 */
export function buildLibraryArtifacts(root: string, hostOnly: boolean, mode: CompilationMode = 'checked'): void {
  for (const step of libraryBuildSteps(root, hostOnly ? 'host' : 'all', mode)) runStep(root, step)
}

/**
 * Compile Host package projects and, concurrently, write the generated Typert declarations
 * without bundling. Both steps run to completion even when the other fails.
 * @param root - Repository root containing the compiler configuration; the Typert pass runs there.
 * @returns A promise that settles after both steps exit.
 * @throws The failed step's error, or an `AggregateError` naming both steps when both fail.
 */
export async function buildHostContracts(root: string): Promise<void> {
  const results = await Promise.allSettled(contractSteps(root, 'host').map(step => runStepConcurrently(root, step)))
  const failures: unknown[] = []
  for (const result of results) if (result.status === 'rejected') failures.push(result.reason)
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'compile-referenced-projects: host compiler and Host Typert both failed')
}

if (import.meta.main) {
  const usage = 'compile-referenced-projects: expected exactly one mode: host, client, host-contracts, or host-libraries'
  const { positionals } = parseArgs({ allowPositionals: true })
  const [mode] = positionals
  if (positionals.length !== 1) throw new Error(usage)
  const root = resolve(import.meta.dirname, '..')
  switch (mode) {
    case 'host':
    case 'client':
      compileReferencedProjects(root, mode)
      break
    case 'host-contracts':
      await buildHostContracts(root)
      break
    case 'host-libraries':
      buildLibraryArtifacts(root, true)
      break
    default:
      throw new Error(usage)
  }
}
