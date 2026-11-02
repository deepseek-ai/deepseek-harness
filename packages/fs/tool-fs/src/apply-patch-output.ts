/** Canonical patch results, typed refusals, and compact model output. */
import { FsError } from '@deepseek-ai/dsh-fs'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { computeHunkDiffs } from './diff.ts'
import type { FileDiff, InferValue } from '@deepseek-ai/dsh-tools'
import type { PatchExecutionReport, PatchFailureCode, PatchRefusal } from './patch/types.ts'

/** Strict canonical output; full file texts feed rendering and are excluded from presentation metadata. */
export const patchOutputSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    phase: { type: 'string', const: 'commit', required: true },
    cancelled: { type: 'boolean', required: true },
    operations: { type: 'array', required: true, items: {
      type: 'object', additionalProperties: false,
      properties: {
        index: { type: 'integer', required: true },
        kind: { type: 'string', enum: ['add', 'update', 'delete', 'move'], required: true },
        path: { type: 'string', required: true },
        destination: { type: 'string' },
        patchLine: { type: 'integer', required: true },
        status: { type: 'string', enum: ['completed', 'failed', 'unknown', 'skipped'], required: true },
        code: { type: 'string' },
        message: { type: 'string' },
        hunkLine: { type: 'integer' },
        changes: { type: 'array', items: {
          type: 'object', additionalProperties: false,
          properties: {
            path: { type: 'string', required: true },
            before: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
            after: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
          },
        } },
      },
    } },
    affectedPaths: { type: 'array', items: { type: 'string' }, required: true },
  },
} as const

/** Validated commit value shared by rendering and presentation. */
export type PatchToolValue = InferValue<typeof patchOutputSchema>

/** Patch syntax and symbolic-link refusals retain their own stable codes. */
export class PatchToolError extends HarnessError {}

function rejection(code: PatchFailureCode, message: string): HarnessError {
  return code === 'PATCH_SYNTAX' || code === 'PATCH_SYMLINK_SOURCE'
    ? new PatchToolError(message, code) : new FsError(message, code)
}

function refusalError(first: PatchRefusal, ...rest: PatchRefusal[]): HarnessError {
  const refusals = [first, ...rest]
  const lines = refusals.map(({ operation, failure }) =>
    `- operation ${operation.index + 1} (${operation.kind} ${operation.path}, patch line ${operation.patchLine}): ${failure.message}`)
  return rejection(first.failure.code, `Patch rejected before any change (${refusals.length} problems):\n${lines.join('\n')}`)
}

/**
 * Convert a report into a commit value, or reject while no disk change exists.
 * A commit whose first operation failed without any change, such as a provider sandbox
 * denial, rejects like a preflight refusal so the error code reaches the same retry paths.
 * @param report - executor report.
 * @returns a flat, lossless JSON commit value, including partial failures.
 * @throws FsError or PatchToolError for syntax, preflight, or first-operation refusals.
 */
export function patchToolValue(report: PatchExecutionReport): PatchToolValue {
  if (report.phase === 'syntax') {
    throw rejection(report.failure.code, report.failure.message)
  }
  if (report.phase === 'preflight') throw refusalError(...report.refusals)
  const [first, ...rest] = report.outcomes
  if (first?.status === 'failed' && first.changes.length === 0 && rest.every(outcome => outcome.status === 'skipped')) {
    throw refusalError(first)
  }
  return { phase: 'commit', cancelled: report.cancelled, affectedPaths: report.affectedPaths,
    operations: report.outcomes.map(outcome => ({
      ...outcome.operation, status: outcome.status,
      ...'failure' in outcome ? outcome.failure : {},
      ...'changes' in outcome ? { changes: outcome.changes } : {},
    })),
  }
}

/**
 * Identify a stopped commit, including cancellation before the next operation.
 * @param value - canonical patch result.
 * @returns whether the patch did not finish every operation.
 */
export function patchStopped(value: PatchToolValue): boolean {
  return value.cancelled || value.operations.some(operation => operation.status !== 'completed')
}

function completedLines(operations: PatchToolValue['operations']): string[] {
  // Codex groups A/M/D, and records a completed move as M at its destination path.
  return ['add', 'update', 'delete'].flatMap(kind => operations
    .filter(operation => operation.status === 'completed' && (operation.kind === 'move' ? 'update' : operation.kind) === kind)
    .map(operation => `${kind === 'add' ? 'A' : kind === 'delete' ? 'D' : 'M'} ${operation.destination ?? operation.path}`))
}

/**
 * Render completed paths and actionable stopped-operation diagnostics.
 * @param value - canonical patch result; paths already use the executor's display spelling.
 * @returns concise model-visible text without whole-file contents.
 */
export function renderPatch(value: PatchToolValue): string {
  if (!patchStopped(value)) {
    return value.operations.length === 0 ? 'Success. No operations in patch.'
      : ['Success. Updated the following files:', ...completedLines(value.operations)].join('\n')
  }
  const completed = value.operations.filter(operation => operation.status === 'completed').length
  const lines = [`Patch stopped after ${completed} of ${value.operations.length} operations.`]
  if (completed > 0) lines.push('Completed:', ...completedLines(value.operations))
  for (const [status, title] of [['failed', 'Failed:'], ['unknown', 'Outcome unknown:'], ['skipped', 'Not executed:']] as const) {
    const operations = value.operations.filter(operation => operation.status === status)
    if (operations.length === 0) continue
    lines.push(title)
    for (const operation of operations) {
      const label = `- operation ${operation.index + 1} (${operation.kind} ${operation.path}`
      if (status === 'skipped') { lines.push(`${label})`); continue }
      const destination = operation.destination === undefined ? '' : ` -> ${operation.destination}`
      lines.push(`${label}${destination}, patch line ${operation.patchLine}): ${operation.message}`)
      if (status === 'failed' && operation.kind === 'move' && operation.changes?.length) {
        lines.push(`  destination ${operation.destination} was written; source ${operation.path} remains`)
      }
    }
  }
  return lines.join('\n')
}

/**
 * Derive hunks only from known completed effects, including a partial move destination.
 * Creations store no diff, as for `write`; a removal without a bounded basis stores none either.
 * @param value - canonical commit value containing the provider's bounded baselines.
 * @returns serializable diff hunks and an explicit stopped flag; no whole-file change records.
 */
export function patchPresentationMeta(value: PatchToolValue): {
  diffs: { path: string; oldText: string | null; newText: string }[]
  stopped: boolean
} {
  const diffs = value.operations.flatMap((operation) => {
    if (operation.status !== 'completed' && operation.status !== 'failed') return []
    return (operation.changes ?? []).flatMap(({ path, before, after }): FileDiff[] => {
      if (before === null) return []
      if (after === null) return [{ path, oldText: before, newText: '' }]
      return computeHunkDiffs(path, before, after)
    })
  })
  return { diffs: diffs.map(({ path, oldText, newText }) => ({ path, oldText, newText })), stopped: patchStopped(value) }
}
