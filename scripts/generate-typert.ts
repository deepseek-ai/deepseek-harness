/**
 * Generate the repository's Typert artifacts without bundling.
 *
 * Writes every explicit contributor's `lib/typert.host.*` and `lib/typert.remote-client.*`
 * with the same generator and writer as the workspace-mode Typert bundler plugin. It reads
 * workspace packages only from source and rejects imports requiring compiled output, so metadata
 * generation precedes package compilation. The compiler owns TypeScript diagnostics;
 * Typert analysis and emission failures still fail this pass.
 *
 * Usage: `tsx scripts/generate-typert.ts`, from the repository root or any directory below it.
 * Exit status 0 means every artifact was written, 1 means generation failed, and 2 means the
 * command line was invalid.
 */

import { performance } from 'node:perf_hooks'
import { writeWorkspaceArtifacts } from '../packages/typert/generator/src/artifact-files.ts'
import { TypertAnalysisError } from '../packages/typert/generator/src/analyzer.ts'
import { TypertEmitError } from '../packages/typert/generator/src/emitter.ts'
import { findWorkspaceRoot, WorkspaceTypertGenerator } from '../packages/typert/generator/src/workspace.ts'
import type { WorkspaceEmitResult } from '../packages/typert/generator/src/workspace.ts'
import { WORKSPACE_TYPERT_FACES } from './typert-faces.ts'

/**
 * Stage at which one pass failed. `locate` and `generate` change no file; `write` leaves the
 * packages written before the failure with new files and the rest with their previous files.
 */
export type TypertGenerationStage = 'locate' | 'generate' | 'write'

/** A failed bundle-free Typert pass; `cause` carries the generator or file-system failure. */
export class TypertGenerationError extends Error {
  override name = 'TypertGenerationError'

  /**
   * @param stage - stage that failed.
   * @param location - directory the stage worked on: the search start for `locate`, otherwise the workspace root.
   * @param cause - failure raised by the generator or the file system.
   */
  constructor(readonly stage: TypertGenerationStage, readonly location: string, cause: unknown) {
    super(`generate-typert: ${STAGE_SUMMARIES[stage]} (${location})`, { cause })
  }
}

const STAGE_SUMMARIES: Readonly<Record<TypertGenerationStage, string>> = {
  locate: 'no directory at or above the working directory holds tsconfig.host.json and packages/; no artifact file changed',
  generate: 'Typert analysis or emission failed; no artifact file changed',
  write: 'writing Typert artifacts failed; packages written before the failure have new lib/typert.* files and the rest keep their previous files',
}

const STAGE_ACTIONS: Readonly<Record<TypertGenerationStage, string>> = {
  locate: 'Run the command from the repository root or a directory below it.',
  generate: 'Fix the source, package.json, or tsconfig paths named above, then rerun this command or pnpm run typecheck.',
  write: 'Fix the file-system error above, then rerun this command; until a run succeeds, lib/typert.* files may come from two generations.',
}

// Host package compilation owns TypeScript diagnostics, as it does for the
// tsdown plugin; rejecting build outputs lets this pass run before package compilation.
const GENERATION_OPTIONS = { checkDiagnostics: false, rejectBuildOutputs: true } as const

/**
 * Generate and write every explicit contributor's Typert artifacts in the workspace containing `start`.
 * @param start - directory inside the workspace; its nearest ancestor holding `tsconfig.host.json` and `packages/` is the root.
 * @returns the artifacts written, in write order.
 * @throws {TypertGenerationError} naming the failed stage, with the underlying failure as `cause`.
 */
export function generateWorkspaceTypert(start: string): readonly WorkspaceEmitResult[] {
  let root: string
  try {
    root = findWorkspaceRoot(start)
  } catch (error) {
    throw new TypertGenerationError('locate', start, error)
  }
  let artifacts: WorkspaceEmitResult[]
  try {
    artifacts = new WorkspaceTypertGenerator(root, GENERATION_OPTIONS).generateContributors(WORKSPACE_TYPERT_FACES)
  } catch (error) {
    throw new TypertGenerationError('generate', root, error)
  }
  try {
    writeWorkspaceArtifacts(root, artifacts)
  } catch (error) {
    throw new TypertGenerationError('write', root, error)
  }
  return artifacts
}

/**
 * Render a failed pass for a terminal: summary, underlying failure, and next action. A Typert
 * analysis or emission failure prints its message; any other cause prints its stack.
 * @param error - failure thrown by {@link generateWorkspaceTypert}.
 * @returns the multi-line report, without a trailing newline.
 */
export function formatGenerationFailure(error: TypertGenerationError): string {
  return [error.message, indent(describeCause(error.cause)), STAGE_ACTIONS[error.stage]].join('\n')
}

function describeCause(cause: unknown): string {
  if (cause instanceof TypertAnalysisError || cause instanceof TypertEmitError) return `${cause.name}: ${cause.message}`
  if (cause instanceof Error) return cause.stack ?? `${cause.name}: ${cause.message}`
  return String(cause)
}

function indent(text: string): string {
  return text.split('\n').map(line => `  ${line}`).join('\n')
}

/**
 * Run the command line.
 * @param args - arguments after the script path; the command accepts none.
 * @param cwd - working directory the workspace root is searched from.
 * @returns the process exit status.
 */
export function main(args: readonly string[], cwd: string): number {
  if (args.length > 0) {
    console.error(`generate-typert: expected no arguments, got ${JSON.stringify(args)}; usage: tsx scripts/generate-typert.ts`)
    return 2
  }
  const started = performance.now()
  let artifacts: readonly WorkspaceEmitResult[]
  try {
    artifacts = generateWorkspaceTypert(cwd)
  } catch (error) {
    if (!(error instanceof TypertGenerationError)) throw error
    console.error(formatGenerationFailure(error))
    return 1
  }
  const packages = new Set(artifacts.map(artifact => artifact.package)).size
  const seconds = ((performance.now() - started) / 1000).toFixed(1)
  console.log(`generate-typert: wrote ${String(artifacts.length)} Typert artifact(s) for ${String(packages)} package(s) in ${seconds}s`)
  return 0
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2), process.cwd())
