/** Plan text and resource identities derived from logged native or PTC calls. */
import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionAddress } from '@deepseek-ai/dsh-api-session-controller/types'

/** Complete Markdown and the heading displayed by a plan preview. */
export interface PlanDocument {
  readonly markdown: string
  readonly title: string
}

/** One submitted plan, identified by its originating tool invocation. */
export interface SubmittedPlan extends PlanDocument {
  readonly callId: ToolCallId
}

/** A saved sidebar resource names one invocation in one Session. */
export interface PlanAddress {
  readonly session: SessionAddress
  readonly callId: ToolCallId
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
  const title = /^#\s+(\S[^\r\n]*)/.exec(markdown.trim())?.[1]
  return title === undefined ? undefined : { callId: callId as ToolCallId, markdown, title }
}

/**
 * Encode the durable identity of a plan without retaining its text in layout storage.
 * @param target - Session and tool-call identity.
 * @returns the plan resource address.
 */
export function planAddress(target: PlanAddress): string {
  const { session, callId } = target
  const parts = session.kind === 'session'
    ? [session.sessionId, callId]
    : ['subagent', session.parentSessionId, session.childSessionId, session.mode, callId]
  return `dsh-resource://plan/${parts.map(encodeURIComponent).join('/')}`
}

/**
 * Validate a saved or caller-supplied plan resource address.
 * @param address - Address submitted to the sidebar or resource provider.
 * @returns the decoded identity, or undefined for an unsupported address.
 */
export function parsePlanAddress(address: string): PlanAddress | undefined {
  const match = /^dsh-resource:\/\/plan\/([^?#]+)$/.exec(address)
  if (match === null) return undefined
  try {
    const parts = (match[1] as string).split('/').map(decodeURIComponent)
    if (parts.some(part => part === '')) return undefined
    if (parts.length === 2) return {
      session: { kind: 'session', sessionId: parts[0] as SessionId }, callId: parts[1] as ToolCallId,
    }
    if (parts.length === 5 && parts[0] === 'subagent' && (parts[3] === 'one-shot' || parts[3] === 'continuable' || parts[3] === 'unknown')) return {
      session: { kind: 'subagent', parentSessionId: parts[1] as SessionId, childSessionId: parts[2] as SessionId, mode: parts[3] },
      callId: parts[4] as ToolCallId,
    }
    return undefined
  } catch (_error) {
    // Invalid saved percent encoding cannot identify a Session or invocation.
    return undefined
  }
}
