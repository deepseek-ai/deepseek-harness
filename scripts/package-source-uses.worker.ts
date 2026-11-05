/** Worker entry: collect the source package uses of one slice of workspace packages. */
import { parentPort, workerData } from 'node:worker_threads'
import { readAllSourceUses } from './source-parse-uses.ts'
import type { PackageDependencyManifest } from './verify-package-dependencies.ts'

/** One package whose `src` tree this worker walks. */
interface SourceUsesTask {
  /** Position of the package in the caller's selection, used to restore that order. */
  readonly index: number
  /** Package directory relative to the repository root. */
  readonly dir: string
  /** Package name, reported back so the caller can key the result. */
  readonly name: string
  /** Workspace manifest of the package, which decides @types-versus-runtime usage. */
  readonly manifest: PackageDependencyManifest
}

/** Work one worker receives when it starts. */
export interface SourceUsesWorkerRequest {
  /** Repository root containing the workspace sources. */
  readonly root: string
  /** Packages this worker walks, in caller order. */
  readonly tasks: readonly SourceUsesTask[]
}

/** Source uses collected for one package. */
export interface SourceUsesWorkerResult {
  /** Package name of the analysed package. */
  readonly name: string
  /** Bare package name to the repository paths whose source references it. */
  readonly uses: Map<string, string[]>
}

const request = workerData as SourceUsesWorkerRequest
const results: SourceUsesWorkerResult[] = request.tasks.map(task => ({
  name: task.name,
  uses: readAllSourceUses(request.root, {
    dir: task.dir,
    manifestPath: `${task.dir}/package.json`,
    manifest: task.manifest,
    name: task.name,
  }),
}))
parentPort?.postMessage(results)
