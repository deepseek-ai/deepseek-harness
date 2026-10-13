/**
 * Worker Thread entry for workspace-mode Typert generation. It generates every
 * explicit contributor of the requested workspace, posts exactly one
 * {@link WorkspaceWorkerResponse}, and exits.
 * @module @deepseek-ai/dsh-typert-generator/worker
 */

import { parentPort, workerData } from 'node:worker_threads'
import { WorkspaceTypertGenerator } from './workspace.ts'
import type { WorkspaceEmitResult, WorkspaceTypertGeneratorOptions } from './workspace.ts'
import type { TypertFace } from './model.ts'

/** Generation inputs passed as `workerData`. */
export interface WorkspaceWorkerRequest {
  /** Workspace root containing the face aggregate tsconfigs. */
  readonly root: string
  /** Faces to generate; every face when absent. */
  readonly faces?: readonly TypertFace[]
  /** Generator switches applied to the pass. */
  readonly options: WorkspaceTypertGeneratorOptions
}

/** The single message the worker posts: every generated artifact, or the failure that stopped generation. */
export type WorkspaceWorkerResponse =
  | { readonly kind: 'artifacts'; readonly artifacts: readonly WorkspaceEmitResult[] }
  | { readonly kind: 'failure'; readonly name: string; readonly message: string; readonly stack?: string }

function parseRequest(value: unknown): WorkspaceWorkerRequest {
  const request = typeof value === 'object' && value !== null
    ? value as Partial<Record<keyof WorkspaceWorkerRequest, unknown>>
    : {}
  const { root, faces, options } = request
  const checkDiagnostics = typeof options === 'object' && options !== null
    ? (options as Partial<Record<keyof WorkspaceTypertGeneratorOptions, unknown>>).checkDiagnostics
    : null
  if (typeof root !== 'string'
    || (faces !== undefined
      && (!Array.isArray(faces) || !faces.every((face): face is TypertFace => face === 'host' || face === 'client')))
    || (checkDiagnostics !== undefined && typeof checkDiagnostics !== 'boolean')) {
    throw new TypeError('typert-generator: malformed workspace worker request')
  }
  return {
    root,
    ...(faces === undefined ? {} : { faces }),
    options: checkDiagnostics === undefined ? {} : { checkDiagnostics },
  }
}

function respond(): WorkspaceWorkerResponse {
  try {
    const request = parseRequest(workerData)
    const generator = new WorkspaceTypertGenerator(request.root, request.options)
    return { kind: 'artifacts', artifacts: generator.generateContributors(request.faces) }
  } catch (error) {
    if (!(error instanceof Error)) return { kind: 'failure', name: 'Error', message: String(error) }
    return {
      kind: 'failure',
      name: error.name,
      message: error.message,
      ...(error.stack === undefined ? {} : { stack: error.stack }),
    }
  }
}

if (parentPort === null) throw new Error('typert-generator: the workspace worker entry must run in a Worker Thread')
parentPort.postMessage(respond())
