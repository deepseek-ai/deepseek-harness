import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { expect } from 'vitest'

/**
 * Retain model inputs while binding tool-history references to message positions.
 * @param options - captured request from the native or SDK command path.
 * @returns comparable model inputs with all message content preserved.
 */
export function modelInput(options: GenerateOptions) {
  return structuredClone({
    provider: options.provider, model: options.model, system: options.system,
    messages: options.messages.map(message => ({ role: message.role, content: message.content })),
    tools: options.tools,
    toolHistory: options.toolHistory === undefined ? undefined : {
      tools: options.toolHistory.tools,
      updates: options.toolHistory.updates.map(({ messageId, additions }) => {
        const messageIndex = options.messages.findIndex(message => message.id === messageId)
        expect(messageIndex).toBeGreaterThanOrEqual(0)
        return { messageIndex, additions }
      }),
    },
    maxTokens: options.maxTokens,
    reasoningEffort: options.reasoningEffort, temperature: options.temperature, stop: options.stop,
  })
}
