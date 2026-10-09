/** Compile and bundle package projects without repeating aggregate test and script typechecks. */

import { spawnSync } from 'node:child_process'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import ts from 'typescript'
import { pnpmCommand } from './release/process.ts'

type CompilationMode = 'checked' | 'benchmark-emit'

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
  const compiler = fileURLToPath(import.meta.resolve('typescript/bin/tsc'))
  const result = spawnSync(process.execPath, [
    ...face === 'host' ? ['--max-old-space-size=4096'] : [],
    compiler,
    '-b',
    ...mode === 'benchmark-emit' ? ['--noCheck'] : [],
    // Relative arguments keep the complete workspace graph below Windows' command-line limit.
    ...references.map(reference => relative(root, reference.path)),
  ], { cwd: root, stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`compile-referenced-projects: ${face} compiler exited with ${String(result.status ?? result.signal)}`)
  }
}

/**
 * Emit package libraries in Host, Desktop, then Client dependency order.
 * @param root - Repository root containing the compiler and bundle configurations.
 * @param hostOnly - Omit the Client compiler and bundler after the Host artifacts are ready.
 * @param mode - Check package types by default; benchmark emission defers diagnostics to required full builds.
 * @throws If any compiler or bundler fails.
 */
export function buildLibraryArtifacts(root: string, hostOnly: boolean, mode: CompilationMode = 'checked'): void {
  compileReferencedProjects(root, 'host', mode)
  runPnpmCommand(root, ['exec', 'tsdown', '--config-loader', 'native', '--env.DSH_BUILD_FACE', 'host'])
  runPnpmCommand(root, ['--filter', '@deepseek-ai/dsh-desktop', 'run', 'bundle'])
  if (hostOnly) return
  compileReferencedProjects(root, 'client', mode)
  runPnpmCommand(root, ['exec', 'tsdown', '--config-loader', 'native', '--env.DSH_BUILD_FACE', 'client'])
}

if (import.meta.main) {
  const { positionals } = parseArgs({ allowPositionals: true })
  const [mode] = positionals
  if (positionals.length !== 1) {
    throw new Error('compile-referenced-projects: expected exactly one mode: host, client, host-libraries, or libraries')
  }
  const root = resolve(import.meta.dirname, '..')
  switch (mode) {
    case 'host':
    case 'client':
      compileReferencedProjects(root, mode)
      break
    case 'host-libraries':
      buildLibraryArtifacts(root, true)
      break
    case 'libraries':
      buildLibraryArtifacts(root, false)
      break
    default:
      throw new Error('compile-referenced-projects: expected exactly one mode: host, client, host-libraries, or libraries')
  }
}
