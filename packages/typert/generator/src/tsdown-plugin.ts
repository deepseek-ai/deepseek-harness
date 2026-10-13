/**
 * Optional tsdown (rolldown) plugin face of the typert generator. It lowers
 * standard decorators in TypeScript dependencies before bundling, then emits
 * model-driven face artifacts at the package output root. Packages without a
 * Typert or Remote export are skipped. Workspace mode generates in a Worker
 * Thread started by the pass's first `buildStart`, so bundling continues on the
 * main thread while Typert analyzes; the pass's first `writeBundle` awaits the
 * result and writes every artifact once.
 * @module @deepseek-ai/dsh-typert-generator/tsdown
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import ts from 'typescript'
import { writePackageArtifacts, writeWorkspaceArtifacts } from './artifact-files.ts'
import { findWorkspaceRoot, hasTypertExport, WorkspaceTypertGenerator } from './workspace.ts'
import type { WorkspaceEmitResult } from './workspace.ts'
import type { TypertFace } from './model.ts'
import type { WorkspaceWorkerRequest, WorkspaceWorkerResponse } from './worker.ts'

/** The subset of the rolldown plugin contract used here (structural; avoids a rolldown type dependency). */
interface TypertPlugin {
  name: string
  buildStart: (options: { cwd: string }) => void
  transform: {
    filter: { id: RegExp }
    handler: (code: string, id: string) => { code: string; map: string | undefined } | undefined
  }
  writeBundle: (options: { dir?: string }) => Promise<void>
}

/** A module id whose path (before any `?query`) names a TypeScript source. */
const TYPESCRIPT_MODULE = /^[^?]*\.[cm]?tsx?(?:\?|$)/
const DECORATOR_SYNTAX = /^\s*@[A-Za-z_$][\w$]*/m

// Full builds and typecheck own TypeScript diagnostics. Benchmark-only emission
// defers them to the required full-build CI jobs; Typert generates reflection
// without repeating those diagnostics.
const TSC_OWNED_DIAGNOSTICS = { checkDiagnostics: false } as const

/** Generation scope selected by a tsdown build phase. */
export interface TypertPluginOptions {
  /** Package mode emits only the package being bundled; workspace mode emits every explicit contributor once. */
  readonly mode?: 'package' | 'workspace'
  /** Independent TypeScript program faces included in this phase. */
  readonly faces?: readonly TypertFace[]
}

/** A workspace-mode generation failure reported by, or observed on, the Typert Worker Thread. */
export class TypertWorkerError extends Error {
  override name = 'TypertWorkerError'
}

/** Settled workspace generation; failures are values so an unclaimed generation never rejects unhandled. */
type GenerationOutcome =
  | { readonly ok: true; readonly artifacts: readonly WorkspaceEmitResult[] }
  | { readonly ok: false; readonly error: TypertWorkerError }

/**
 * Create the decorator-lowering and typert-generation plugin for the root tsdown config.
 * @param pluginOptions - package/workspace emission mode and independent program faces.
 * @returns a rolldown-compatible plugin that lowers source decorators and emits local and Host-for-Client artifacts.
 */
export function typertPlugin(pluginOptions: TypertPluginOptions = {}): TypertPlugin {
  const artifactsByRoot = new Map<string, readonly WorkspaceEmitResult[]>()
  const generations = new Map<string, Promise<GenerationOutcome>>()
  const emittedWorkspaces = new Set<string>()
  const workspaceGeneration = (root: string): Promise<GenerationOutcome> => {
    let generation = generations.get(root)
    if (generation === undefined) {
      generation = generateInWorker({
        root,
        ...(pluginOptions.faces === undefined ? {} : { faces: pluginOptions.faces }),
        options: TSC_OWNED_DIAGNOSTICS,
      })
      generations.set(root, generation)
    }
    return generation
  }
  return {
    name: 'dsh-typert-generator',
    buildStart(inputOptions) {
      // tsdown builds every workspace package concurrently through this one
      // plugin instance; the first package build to start launches generation.
      if (pluginOptions.mode === 'workspace') void workspaceGeneration(findWorkspaceRoot(inputOptions.cwd))
    },
    transform: {
      // Rolldown evaluates the id filter natively, so non-TypeScript modules
      // never cross into this JavaScript hook.
      filter: { id: TYPESCRIPT_MODULE },
      handler(code, id) {
        if (!TYPESCRIPT_MODULE.test(id) || !DECORATOR_SYNTAX.test(code)) return
        const file = id.replace(/\?.*$/su, '')
        const result = ts.transpileModule(code, {
          fileName: file,
          compilerOptions: {
            target: ts.ScriptTarget.ES2024,
            module: ts.ModuleKind.ESNext,
            ...(file.endsWith('x') ? { jsx: ts.JsxEmit.ReactJSX } : {}),
            sourceMap: true,
          },
        })
        return {
          code: result.outputText.replace(/\n?\/\/# sourceMappingURL=.*$/u, '\n'),
          map: result.sourceMapText,
        }
      },
    },
    async writeBundle(bundleOptions) {
      // options.dir is the package's absolute outDir (<package>/lib); its
      // nearest package.json owns the bundle even when a custom config writes
      // a nested output such as <package>/lib/dev.
      if (bundleOptions.dir === undefined) return
      const root = findWorkspaceRoot(bundleOptions.dir)
      if (emittedWorkspaces.has(root)) return
      if (pluginOptions.mode === 'workspace') {
        // The first bundle to finish claims emission and reports any failure;
        // later bundles of the pass return without waiting.
        emittedWorkspaces.add(root)
        const outcome = await workspaceGeneration(root)
        if (!outcome.ok) throw outcome.error
        writeWorkspaceArtifacts(root, outcome.artifacts)
        return
      }
      const packageDir = packageRoot(bundleOptions.dir, root)
      if (packageDir === undefined) return
      const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
        name?: string
        exports?: unknown
      }
      if (manifest.name === undefined || !hasTypertExport(manifest.exports)) return
      let artifacts = artifactsByRoot.get(root)
      if (artifacts === undefined) {
        const generator = new WorkspaceTypertGenerator(root, TSC_OWNED_DIAGNOSTICS)
        artifacts = pluginOptions.faces === undefined
          ? generator.generate()
          : generator.generate(undefined, pluginOptions.faces)
        artifactsByRoot.set(root, artifacts)
      }
      writePackageArtifacts(packageDir, artifacts.filter(candidate => candidate.package === manifest.name))
    },
  }
}

/**
 * Run workspace generation in a Worker Thread. The outcome never rejects, and
 * every terminal path terminates the worker before the outcome settles.
 */
function generateInWorker(request: WorkspaceWorkerRequest): Promise<GenerationOutcome> {
  const worker = spawnWorker(request)
  return new Promise((settle) => {
    let settled = false
    const finish = (outcome: GenerationOutcome): void => {
      if (settled) return
      settled = true
      worker.terminate().then(
        () => { settle(outcome) },
        (error: unknown) => { settle({ ok: false, error: workerError(request, 'could not terminate its worker', error) }) },
      )
    }
    const fail = (problem: string, cause?: unknown): void => {
      finish({ ok: false, error: workerError(request, problem, cause) })
    }
    worker.once('message', (value: unknown) => {
      const response = parseWorkerResponse(value)
      if (response === undefined) {
        fail('received a malformed worker response')
      } else if (response.kind === 'failure') {
        const cause = new Error(response.message)
        cause.name = response.name
        if (response.stack !== undefined) cause.stack = response.stack
        fail(`failed: ${response.name}: ${response.message}`, cause)
      } else {
        finish({ ok: true, artifacts: response.artifacts })
      }
    })
    worker.once('messageerror', (error) => { fail('received a worker response that could not be deserialized', error) })
    worker.once('error', (error) => { fail(`crashed: ${error.message}`, error) })
    worker.once('exit', (code) => { fail(`stopped: its worker exited with code ${String(code)} before reporting artifacts`) })
  })
}

function workerError(request: WorkspaceWorkerRequest, problem: string, cause: unknown): TypertWorkerError {
  return new TypertWorkerError(
    `typert-generator: workspace generation for ${request.root} ${problem}`,
    cause === undefined ? undefined : { cause },
  )
}

function spawnWorker(request: WorkspaceWorkerRequest): Worker {
  /* v8 ignore next 3 -- the tsdown host build runs the built worker entry. */
  if (!import.meta.url.endsWith('.ts')) {
    return new Worker(new URL('./worker.js', import.meta.url), { workerData: request })
  }
  // Source runs load the TypeScript worker entry through tsx.
  const bootstrap = [
    `import { register } from ${JSON.stringify(import.meta.resolve('tsx/esm/api'))}`,
    'register()',
    `await import(${JSON.stringify(new URL('./worker.ts', import.meta.url).href)})`,
  ].join('\n')
  return new Worker(new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`), { workerData: request, execArgv: [] })
}

function parseWorkerResponse(value: unknown): WorkspaceWorkerResponse | undefined {
  if (!isRecord(value)) return undefined
  if (value.kind === 'failure') {
    if (typeof value.name !== 'string' || typeof value.message !== 'string'
      || (value.stack !== undefined && typeof value.stack !== 'string')) return undefined
    return {
      kind: 'failure',
      name: value.name,
      message: value.message,
      ...(value.stack === undefined ? {} : { stack: value.stack }),
    }
  }
  if (value.kind !== 'artifacts' || !Array.isArray(value.artifacts)) return undefined
  const artifacts: WorkspaceEmitResult[] = []
  for (const artifact of value.artifacts) {
    const parsed = parseArtifact(artifact)
    if (parsed === undefined) return undefined
    artifacts.push(parsed)
  }
  return { kind: 'artifacts', artifacts }
}

function parseArtifact(value: unknown): WorkspaceEmitResult | undefined {
  if (!isRecord(value)
    || typeof value.package !== 'string'
    || typeof value.packageRoot !== 'string'
    || (value.face !== 'host' && value.face !== 'client')
    || !Array.isArray(value.exports)
    || !value.exports.every((entry): entry is string => typeof entry === 'string')
    || typeof value.js !== 'string'
    || typeof value.dts !== 'string') return undefined
  const remote = parseRemoteArtifact(value.remote)
  if (value.remote !== undefined && remote === undefined) return undefined
  return {
    package: value.package,
    packageRoot: value.packageRoot,
    face: value.face,
    exports: value.exports,
    js: value.js,
    dts: value.dts,
    ...(remote === undefined ? {} : { remote }),
  }
}

function parseRemoteArtifact(value: unknown): WorkspaceEmitResult['remote'] {
  if (!isRecord(value)
    || typeof value.js !== 'string'
    || typeof value.dts !== 'string'
    || typeof value.dtsMap !== 'string') return undefined
  return { js: value.js, dts: value.dts, dtsMap: value.dtsMap }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function packageRoot(start: string, workspace: string): string | undefined {
  let current = resolve(start)
  while (current !== workspace) {
    if (existsSync(join(current, 'package.json'))) return current
    current = dirname(current)
  }
  return undefined
}
