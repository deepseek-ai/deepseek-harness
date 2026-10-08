/**
 * Workspace-level discovery and model-driven Typert generation.
 * @module @deepseek-ai/dsh-typert-generator/workspace
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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
   * @returns discovered packages in stable package-name order.
   */
  discover(faces?: readonly TypertFace[]): DiscoveredTypertPackage[] {
    return new WorkspaceAnalyzer({
      root: this.root,
      caches: this.caches,
      ...(faces === undefined ? {} : { faces }),
    }).discoverPackages()
  }

  /**
   * Generate all discovered contributors, or an explicit package subset.
   * @param packages - optional exact package names for a focused pass.
   * @param faces - optional independent program faces to analyze.
   * @returns one artifact per package face.
   */
  generate(packages?: readonly string[], faces?: readonly TypertFace[]): WorkspaceEmitResult[] {
    const selected = packages ?? this.discover(faces).map(candidate => candidate.package)
    const workspace = new WorkspaceAnalyzer({
      root: this.root,
      packages: selected,
      caches: this.caches,
      ...(faces === undefined ? {} : { faces }),
      ...(this.options.checkDiagnostics === undefined ? {} : { checkDiagnostics: this.options.checkDiagnostics }),
    }).analyze()
    const artifacts: WorkspaceEmitResult[] = []
    for (const face of workspace.faces) {
      const emitter = new FaceModelEmitter(face)
      for (const packageModel of face.packages) {
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
    // The generated declaration carries a `sourceMappingURL`, and the payload
    // publishes that map beside the `src` it resolves, so an installed consumer
    // navigates from the Remote method to the Host implementation.
    const remoteFiles = [
      'lib/typert.remote-client.js',
      'lib/typert.remote-client.d.ts',
      'lib/typert.remote-client.d.ts.map',
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

function sameExport(actual: unknown, expected: { types: string; default: string }): boolean {
  if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return false
  const value = actual as Record<string, unknown>
  return value.types === expected.types && value.default === expected.default
}
