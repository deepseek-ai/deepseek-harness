/** Shared top-level-call post-policy selection for search result spill. @module dsh-tool-fs-search/direct-call */

import type { PostToolDecision, ToolDefinition, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/**
 * Return the accepted canonical value only when this tool's definition ran a
 * direct successful top-level call and no downstream policy replaced either projection.
 * @param tool - the exact registered definition whose value may be projected.
 * @param exec - the completed execution identity and the definition it ran.
 * @param result - the canonical result before post-policy decisions are applied.
 * @param decision - the composed downstream post-policy decision.
 * @returns the canonical value to project, or `undefined` when spill must defer.
 */
export function acceptedDirectCallValue(
  tool: ToolDefinition,
  exec: ToolExecution,
  result: ToolExecutionResult,
  decision: PostToolDecision,
): JsonValue | undefined {
  if (decision.kind !== 'accept' || decision.content !== undefined || Object.hasOwn(decision, 'value')
    || exec.parent !== undefined || exec.name !== tool.name || result.isError
    || exec.definition !== tool) return undefined
  return result.value
}
