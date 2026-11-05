/** Patch parsing and target identity shared by preflight and sequential commits. */
import type { Context } from '@deepseek-ai/cordis'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FsTarget, FsTargetKey, FsVersion, FsWriteIntent } from '@deepseek-ai/dsh-fs'
import { parsePatch } from '@deepseek-ai/dsh-fs-patch'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { remediateFsError } from '../error.ts'
import type { FsSandboxController } from '../sandbox.ts'
import { sessionResolveOptions } from '../session-cwd.ts'
import type { PatchExecutionRequest, PatchFailure, PatchOperationRecord, PatchPlan, PlannedOperation } from './types.ts'

/**
 * Resolve every operation without dropping repeated aliases or splitting moves.
 * @param ctx - filesystem service owner.
 * @param sandbox - filesystem diagnostic mapper.
 * @param exec - session cwd and execution signal.
 * @param request - raw patch and resolved per-call policy.
 * @returns resolved operations sharing one target per canonical key, plus resolution refusals.
 */
export async function planPatch(
  ctx: Context, sandbox: FsSandboxController, exec: ToolExecution, request: PatchExecutionRequest,
): Promise<PatchPlan> {
  const parsed = parsePatch(request.patch)
  const targets = new Map<FsTargetKey, FsTarget>()
  const resolve = async (path: string): Promise<FsTarget> => {
    const target = await ctx.fs.resolve(path, await sessionResolveOptions(ctx, exec))
    const prior = targets.get(target.targetKey)
    if (prior) return prior
    targets.set(target.targetKey, target)
    return target
  }
  const result: PatchPlan = { operations: [], refusals: [] }
  for (const [index, operation] of parsed.entries()) {
    const moveTo = operation.kind === 'update' ? operation.moveTo : undefined
    const record: PatchOperationRecord = {
      index, kind: moveTo === undefined ? operation.kind : 'move', path: operation.path, patchLine: operation.lineNumber,
      ...(moveTo === undefined ? {} : { destination: moveTo }),
    }
    let failurePath = operation.path
    try {
      const target = await resolve(operation.path)
      record.path = target.displayPath
      const base = { target, rawPath: operation.path, record }
      switch (operation.kind) {
        case 'add': result.operations.push({ ...base, kind: 'add', content: operation.content }); break
        case 'delete': result.operations.push({ ...base, kind: 'delete' }); break
        case 'update': {
          if (operation.moveTo === undefined) result.operations.push({ ...base, kind: 'update', hunks: operation.hunks })
          else {
            failurePath = operation.moveTo
            const destination = await resolve(operation.moveTo)
            record.destination = destination.displayPath
            result.operations.push({ ...base, kind: 'move', destination, hunks: operation.hunks })
          }
          break
        }
        /* v8 ignore next -- Closed parsed-operation union; assertNever checks exhaustiveness at compile time. */
        default: assertNever(operation)
      }
    } catch (error) {
      if (!(error instanceof FsError)) throw error
      result.refusals.push({ operation: record, failure: patchFailure(sandbox, request.sandboxPolicy, error, failurePath) })
    }
  }
  return result
}

/**
 * Obtain a source guard without recording an observation.
 * @param ctx - intent dispatcher.
 * @param exec - opaque observation actor.
 * @param target - resolved source.
 * @param kind - deletion or edit-family source policy.
 * @returns the observed version, or undefined for a bare provider.
 */
export function sourceIntent(ctx: Context, exec: ToolExecution, target: FsTarget, kind: 'delete' | 'edit'): Promise<{ version: FsVersion } | undefined> {
  return kind === 'delete'
    ? ctx.waterfall('fs/delete-intent', target, exec, () => undefined)
    : ctx.waterfall('fs/edit-intent', target, exec, () => undefined)
}

/**
 * Obtain a write guard without recording an observation.
 * @param ctx - intent dispatcher.
 * @param exec - opaque observation actor.
 * @param target - resolved write destination.
 * @returns the observed write intent, or undefined for a bare provider.
 */
export function destinationIntent(ctx: Context, exec: ToolExecution, target: FsTarget): Promise<FsWriteIntent | undefined> {
  return ctx.waterfall('fs/write-intent', target, exec, () => undefined)
}

/**
 * Preserve filesystem codes while applying the existing model-facing error policy.
 * @param sandbox - shared denial mapper.
 * @param policy - policy supplied by the request.
 * @param error - expected filesystem failure.
 * @param path - display path whose operation failed.
 * @returns the remediated code and message; unexpected mapper defects reject.
 */
export function patchFailure(
  sandbox: FsSandboxController, policy: SandboxExecutionPolicy | undefined, error: FsError, path: string,
): PatchFailure {
  const mapped = remediateFsError(sandbox.mapError(error, policy), path)
  return { code: mapped.code, message: mapped.message }
}

/**
 * List all targets the operation can mutate, with destination first for a move.
 * @param operation - resolved operation.
 * @returns targets whose versions the uncertainty comparison records.
 */
export function mutationTargets(operation: PlannedOperation): FsTarget[] {
  return operation.kind === 'move' ? [operation.destination, operation.target] : [operation.target]
}
