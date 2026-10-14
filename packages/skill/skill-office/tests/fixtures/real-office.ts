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

/**
 * Assert that a non-rendering task has received no rendering commands or detailed guidance.
 * @param events - Recorded task events, including nested skill and shell results.
 */
export function expectNoRenderContext(events: SessionEvent[]): void {
  const messages = Session.create(SessionId('office-context'), events).deriveMessages()
  expect(JSON.stringify(messages)).not.toMatch(/imageRendering|maxPixels|fragment rectangles|render --input|--output-dir|uniformly blank/)
}
