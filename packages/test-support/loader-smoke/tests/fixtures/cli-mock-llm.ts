import type { Context } from '@deepseek-ai/cordis'
import {
  ToolCallId,
  LlmAdapter,
  ReasoningEffortId,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'

const HIGH = ReasoningEffortId('high')
const OFF = ReasoningEffortId('off')
const SHELL_TOOL = process.platform === 'win32' ? 'pwsh' : 'bash'
const SHELL_COMMAND = process.platform === 'win32'
  ? "Write-Output 'CLI_TOOL_ROUND_TRIP'"
  : 'printf CLI_TOOL_ROUND_TRIP'

/** Keyless headless-agent adapter: one production shell call followed by a final answer. */
class CliMockAdapter extends LlmAdapter {
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return {
      provider,
      id: model,
      name: model,
      reasoning: {
        efforts: [
          { id: OFF, name: 'Off' },
          { id: HIGH, name: 'High' },
        ],
        defaultEffort: HIGH,
      },
    }
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (process.env.DSH_CLI_MOCK_FAILURE === '1') {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', message: 'CLI mock provider failed' } } }
      return
    }
    const last = options.messages.at(-1)
    const toolResult = last?.role === 'tool' ? last : undefined
    if (toolResult === undefined) {
      const reasoning = 'Inspecting the task before the tool call.'
      const args = JSON.stringify({ command: SHELL_COMMAND, description: 'Prove the CLI tool round trip.' })
      yield { type: 'block-start', index: 0, blockType: 'reasoning' }
      yield { type: 'reasoning-delta', index: 0, text: reasoning }
      yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoning } }
      yield { type: 'block-start', index: 1, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 1, id: ToolCallId('cli-smoke-call'), name: SHELL_TOOL, argumentsDelta: args }
      yield { type: 'block-end', index: 1, block: { type: 'tool-call', id: ToolCallId('cli-smoke-call'), name: SHELL_TOOL, arguments: args } }
      yield { type: 'usage', usage: { inputTokens: 11, outputTokens: 3, cacheReadTokens: 2 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }

    const toolText = toolResult.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    const reply = `CLI tool round trip complete: ${toolText.trim()}`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: reply }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    yield { type: 'usage', usage: { inputTokens: 7, outputTokens: 5, reasoningTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export const name = 'cli-mock-llm'
export const inject = ['llm']

/** Register the keyless `cli-mock` adapter. */
export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(['cli-mock'], new CliMockAdapter())
  ctx.on('agent/request', async ({ step }, next) => {
    const config = await next()
    return step === 2 ? { ...config, reasoningEffort: OFF } : config
  })
}
