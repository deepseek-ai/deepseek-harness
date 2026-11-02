/** Shared model configuration and context assertions for real Office workflows. */
import { expect } from 'vitest'
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

/** @returns Patches mounting the Office kit and the `office` tool, which the headless profile does not compose. */
export function officeToolPatches() {
  return [{ insert: [
    { id: 'office-kit', name: '@deepseek-ai/dsh-office-kit' },
    { id: 'tool-office', name: '@deepseek-ai/dsh-tool-office' },
  ] }]
}

/** One `office` call from a native tool call or a PTC dispatch. */
export interface OfficeCall {
  readonly callId: string
  readonly args: { readonly operation?: string; readonly input?: string; readonly format?: string; readonly pages?: number[] }
}

/**
 * Collect the `office` calls of a recorded task.
 * @param events - Recorded task events.
 * @returns Native and PTC `office` calls in log order.
 */
export function officeCalls(events: SessionEvent[]): OfficeCall[] {
  return events.flatMap((event) => {
    if (event.type === 'tool/call' && event.data.name === 'office') {
      return [{ callId: event.data.callId, args: JSON.parse(event.data.arguments) as OfficeCall['args'] }]
    }
    if (event.type === 'tool/ptc-dispatch' && event.data.name === 'office') {
      return [{ callId: event.data.subCallId, args: event.data.arguments as OfficeCall['args'] }]
    }
    return []
  })
}

/**
 * Assert that a non-rendering task has received no render calls or render-skill guidance.
 * @param events - Recorded task events, including nested skill and shell results.
 */
export function expectNoRenderContext(events: readonly SessionEvent[]): void {
  const messages = Session.create(SessionId('office-context'), events).deriveMessages()
  expect(JSON.stringify(messages)).not.toMatch(/Render the saved deliverable|"operation":"render"/)
}
