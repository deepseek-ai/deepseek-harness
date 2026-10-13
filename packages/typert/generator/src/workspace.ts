/**
 * Workspace-level discovery and model-driven Typert generation.
 * @module @deepseek-ai/dsh-typert-generator/workspace
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { TypertAnalysisError, WorkspaceAnalyzer, WorkspaceCaches } from './analyzer.ts'
import type { DiscoveredTypertPackage } from './analyzer.ts'
import { FaceModelEmitter } from './emitter.ts'
import type { ModelEmitResult } from './emitter.ts'
import type { TypertFace } from './model.ts'

/** One emitted artifact paired with its source package root. */
export interface WorkspaceEmitResult extends ModelEmitResult {
  readonly packageRoot: string
}

/** Behavior switches for one {@link WorkspaceTypertGenerator}. */
export interface WorkspaceTypertGeneratorOptions {
  /**
   * Run the per-package syntactic/semantic diagnostic pass before analysis
   * (default true). Pass false only when the same orchestration already
   * verified the workspace with tsc; the Typert-specific analysis checks
   * (annotation coverage, private cross-package references, unretainable
   * merges) run regardless.
   */
  readonly checkDiagnostics?: boolean
  /**
   * Fail when an analyzed face program loads a file from a workspace
   * package's `lib/` directory or cannot resolve an import of a workspace
   * package (default false); see
   * `WorkspaceAnalyzerOptions.rejectBuildOutputs`.
   */
  readonly rejectBuildOutputs?: boolean
}

/** Discover, analyze, and emit package reflection from independent faces. */
export class WorkspaceTypertGenerator {
  /** Parsed-config and program-host state shared by every analyzer this generator creates. */
  private readonly caches = new WorkspaceCaches()

  /**
   * Bind generation to one workspace root.
   * @param root - directory containing face aggregate tsconfigs.
   * @param options - behavior switches applied to every pass of this generator.
   */
  constructor(
    private readonly root: string,
    private readonly options: WorkspaceTypertGeneratorOptions = {},
  ) {}

  /**
   * Find public package faces that contribute Cordis services/events or
   * explicitly tagged Typert roots.
   * @param faces - optional independent program faces to inspect.
   * @param includeManifest - optional `package.json` predicate; a rejected package's sources and project config are not read.
   * @returns discovered packages in stable package-name order.
   */
  discover(
    faces?: readonly TypertFace[],
    includeManifest?: (manifest: Readonly<Record<string, unknown>>) => boolean,
  ): DiscoveredTypertPackage[] {
    return new WorkspaceAnalyzer({
      root: this.root,
      caches: this.caches,
      ...(faces === undefined ? {} : { faces }),
    }).discoverPackages(includeManifest)
  }

  /**
   * Generate all discovered contributors, or an explicit package subset.
   * @param packages - optional exact package names to emit; every pass includes the same face-wide declaration merges.
   * @param faces - optional independent program faces to analyze.
   * @returns one artifact per package face.
   */
  generate(packages?: readonly string[], faces?: readonly TypertFace[]): WorkspaceEmitResult[] {
    const contributors = this.discover(faces).map(candidate => candidate.package)
    const selected = new Set(packages ?? contributors)
    const workspace = new WorkspaceAnalyzer({
      root: this.root,
      packages: contributors,
      caches: this.caches,
      ...(faces === undefined ? {} : { faces }),
      ...(this.options.checkDiagnostics === undefined ? {} : { checkDiagnostics: this.options.checkDiagnostics }),
      ...(this.options.rejectBuildOutputs === undefined ? {} : { rejectBuildOutputs: this.options.rejectBuildOutputs }),
    }).analyze()
    const artifacts: WorkspaceEmitResult[] = []
    for (const face of workspace.faces) {
      const emitter = new FaceModelEmitter(face)
      for (const packageModel of face.packages) {
        if (!selected.has(packageModel.name)) continue
        const artifact = {
          ...emitter.emit(packageModel.name),
          packageRoot: packageModel.root,
        }
        this.validateExport(artifact)
        artifacts.push(artifact)
      }
    }
    return artifacts
  }

  /**
   * Generate every explicit contributor: a package whose manifest declares a
   * Typert artifact export and whose public graph has a Typert surface.
   * @param faces - optional independent program faces to analyze.
   * @returns one artifact per contributor face.
   */
  generateContributors(faces?: readonly TypertFace[]): WorkspaceEmitResult[] {
    const packages = this.discover(faces, manifest => hasTypertExport(manifest.exports))
      .map(candidate => candidate.package)
    return packages.length === 0 ? [] : this.generate(packages, faces)
  }

  private validateExport(artifact: WorkspaceEmitResult): void {
    const manifestPath = resolve(this.root, artifact.packageRoot, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      exports?: unknown
      files?: unknown
    }
    const subpath = artifact.face === 'host' ? './typert' : './client/typert'
    const expected = {
      types: `./lib/typert.${artifact.face}.d.ts`,
      default: `./lib/typert.${artifact.face}.js`,
    }
    const actual = manifest.exports !== null && typeof manifest.exports === 'object'
      ? (manifest.exports as Record<string, unknown>)[subpath]
      : undefined
    if (!sameExport(actual, expected)) {
      throw new TypertAnalysisError(
        `typert(${artifact.face}): ${artifact.package} must export ${subpath} as ${JSON.stringify(expected)}`,
      )
    }
    const files = Array.isArray(manifest.files) ? manifest.files : []
    for (const file of [`lib/typert.${artifact.face}.js`, `lib/typert.${artifact.face}.d.ts`]) {
      if (!files.includes(file)) {
        throw new TypertAnalysisError(`typert(${artifact.face}): ${artifact.package} package files must include ${file}`)
      }
    }
    if (artifact.face !== 'host') return
    const remoteExpected = {
      types: './lib/typert.remote-client.d.ts',
      default: './lib/typert.remote-client.js',
    }
    const remoteActual = manifest.exports !== null && typeof manifest.exports === 'object'
      ? (manifest.exports as Record<string, unknown>)['./remote']
      : undefined
    // The declaration map is emitted beside these two but never published: it
    // serves editor navigation in the workspace, where the package link
    // resolves its source.
    const remoteFiles = [
      'lib/typert.remote-client.js',
      'lib/typert.remote-client.d.ts',
    ]
    if (artifact.remote === undefined) {
      if (remoteActual !== undefined || remoteFiles.some(file => files.includes(file))) {
        throw new TypertAnalysisError(
          `typert(host): ${artifact.package} publishes Remote artifacts but has no Remote methods`,
        )
      }
      return
    }
    if (!sameExport(remoteActual, remoteExpected)) {
      throw new TypertAnalysisError(
        `typert(host): ${artifact.package} must export ./remote as ${JSON.stringify(remoteExpected)}`,
      )
    }
    for (const file of remoteFiles) {
      if (!files.includes(file)) {
        throw new TypertAnalysisError(`typert(host): ${artifact.package} package files must include ${file}`)
      }
    }
  }
}

/**
 * Find the workspace root that Typert generation runs against: the nearest
 * directory at or above `start` that holds both `tsconfig.host.json` and
 * `packages/`. The analyzer registers projects under `<root>/packages`, so a
 * package's own `tsconfig.host.json` face leaf does not qualify.
 * @param start - directory to search from, such as a bundle output or a working directory.
 * @returns the absolute workspace root.
 * @throws If no ancestor of `start` qualifies.
 */
export function findWorkspaceRoot(start: string): string {
  let current = resolve(start)
  while (!existsSync(join(current, 'tsconfig.host.json')) || !existsSync(join(current, 'packages'))) {
    const parent = dirname(current)
    if (parent === current) throw new Error(`typert-generator: cannot find workspace root above ${start}`)
    current = parent
  }
  return current
}

/**
 * Whether a `package.json#exports` field declares a Typert artifact subpath
 * (`./typert`, `./client/typert`, or `./remote`).
 * @param exportsField - the manifest's `exports` value.
 * @returns true when the package opts in to Typert publication.
 */
export function hasTypertExport(exportsField: unknown): boolean {
  if (exportsField === null || typeof exportsField !== 'object' || Array.isArray(exportsField)) return false
  return Object.hasOwn(exportsField, './typert')
    || Object.hasOwn(exportsField, './client/typert')
    || Object.hasOwn(exportsField, './remote')
}

function sameExport(actual: unknown, expected: { types: string; default: string }): boolean {
  if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return false
  const value = actual as Record<string, unknown>
  return value.types === expected.types && value.default === expected.default
}
