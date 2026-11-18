/** Plan text and resource identities derived from logged native or PTC calls. */
import type {} from '@deepseek-ai/dsh-tool-executor-ptc/client'
import type { ToolCallId } from '@deepseek-ai/dsh-llm/types'

/** Complete Markdown and the heading displayed by a plan card. */
export interface PlanDocument {
  readonly markdown: string
  readonly title: string
}

/** One submitted plan, identified by its originating tool invocation. */
export interface SubmittedPlan extends PlanDocument {
  readonly callId: ToolCallId
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read the level-one heading that opens a plan.
 * @param markdown - Plan Markdown.
 * @returns the heading text, or undefined when the trimmed Markdown does not start with `# `.
 */
export function planTitle(markdown: string): string | undefined {
  return /^#\s+(\S[^\r\n]*)/.exec(markdown.trim())?.[1]
}

/**
 * Read a complete plan from untrusted logged arguments.
 * @param event - Native call or PTC dispatch event from Session history.
 * @returns the submitted plan, or undefined for unrelated or malformed data.
 */
export function submittedPlan(event: { readonly type: string; readonly data: unknown }): SubmittedPlan | undefined {
  if (event.type !== 'tool/call' && event.type !== 'tool/ptc-dispatch-start' && event.type !== 'tool/ptc-dispatch') return undefined
  const data = event.data
  if (!record(data) || data.name !== 'exit_plan_mode') return undefined
  const callId = event.type === 'tool/call' ? data.callId : data.subCallId
  if (typeof callId !== 'string' || callId === '') return undefined
  let args: unknown = data.arguments
  if (event.type === 'tool/call') {
    if (typeof args !== 'string') return undefined
    try { args = JSON.parse(args) as unknown }
    catch (_error) { return undefined /* Malformed model JSON remains in the generic tool row. */ }
  }
  if (!record(args) || typeof args.plan !== 'string') return undefined
  const markdown = args.plan
  const title = planTitle(markdown)
  return title === undefined ? undefined : { callId: callId as ToolCallId, markdown, title }
}
