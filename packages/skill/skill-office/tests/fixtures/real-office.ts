/** Shared model configuration and context assertions for real Office workflows. */
import { expect } from 'vitest'
import type { ImageBlock } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'

/** @returns Model provider patches for the configured development or official API. */
export function officeModelPatches() {
  const model = process.env.MODEL_NAME ?? 'deepseek-flash'
  const completions = process.env.DSH_OFFICE_TEST_API === 'openai-completions'
  return [
    ...completions ? [
      { id: 'llm-deepseek', disabled: true },
      { id: 'llm-pi-ai', config: { providers: { 'office-test': {
        api: 'openai-completions', apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: process.env.DEEPSEEK_BASE_URL,
        compat: { thinkingFormat: 'deepseek' },
        models: [{ id: model, contextWindow: 128000, maxTokens: 8192, input: ['text', 'image'] }],
      } } } },
    ] : [{ id: 'llm-deepseek', config: { thinking: 'enabled', reasoningEffort: 'high', maxTokens: 8192,
      models: [{ id: model, contextWindow: 128000, maxTokens: 8192, inputModalities: ['text', 'image'] }],
    } }],
    { id: 'agent-default-model', config: { provider: completions ? 'office-test' : 'deepseek-official', model } },
  ]
}

/** @returns Patches mounting the Office kit and tools, which the headless profile does not compose. */
export function officeToolPatches() {
  return [{ insert: [
    { id: 'office-kit', name: '@deepseek-ai/dsh-office-kit' },
    { id: 'tool-office', name: '@deepseek-ai/dsh-tool-office' },
  ] }]
}

/** One Office call from a native tool call or a PTC dispatch. */
export interface OfficeCall {
  readonly callId: string
  readonly name: 'office_render' | 'office_convert' | 'office_recalculate'
  readonly args: { readonly input?: string; readonly format?: string; readonly pages?: number[] }
}

/**
 * Collect the Office calls of a recorded task by tool name.
 * @param events - Recorded task events.
 * @returns Native and PTC Office calls in log order.
 */
export function officeCalls(events: readonly SessionEvent[]): OfficeCall[] {
  return events.flatMap((event): OfficeCall[] => {
    if (event.type !== 'tool/call' && event.type !== 'tool/ptc-dispatch') return []
    const { name } = event.data
    if (name !== 'office_render' && name !== 'office_convert' && name !== 'office_recalculate') return []
    return event.type === 'tool/call'
      ? [{ callId: event.data.callId, name, args: JSON.parse(event.data.arguments) as OfficeCall['args'] }]
      : [{ callId: event.data.subCallId, name, args: event.data.arguments as OfficeCall['args'] }]
  })
}

/**
 * Collect images displayed during an Office task.
 * @param events - Recorded task events.
 * @returns Images in successful tool results and PTC additional context, excluding private dispatch output.
 */
export function officeImages(events: readonly SessionEvent[]): ImageBlock[] {
  return events.flatMap((event) => {
    const content = event.type === 'tool/result' && !event.data.message.isError ? event.data.message.content
      : event.type === 'user/message' && event.data.source.kind === 'ptc-mode' ? event.data.content : []
    return content.filter(block => block.type === 'image')
  })
}

/**
 * Reject recorded Office render calls and the "Render the saved deliverable" instruction.
 * @param events - Recorded task events, including nested skill and shell results.
 */
export function expectNoRenderContext(events: readonly SessionEvent[]): void {
  const calls = officeCalls(events)
  expect(calls.filter(call => call.name === 'office_render'), JSON.stringify(calls)).toEqual([])
  const messages = Session.create(SessionId('office-context'), events).deriveMessages()
  expect(JSON.stringify(messages)).not.toMatch(/Render the saved deliverable/)
}
