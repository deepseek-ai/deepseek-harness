import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { ToolCallId, LlmAdapter } from '@deepseek-ai/dsh-llm'

/**
 * Test adapter for the `mock-delegate` model: the first request calls the
 * `subagent` tool once, and the follow-up streams the tool result text back
 * verbatim — so the ACP child's answer (the scripted mock server's cwd echo)
 * reaches the REPL stdout for the driving e2e to assert.
 */
class MockDelegatingAdapter extends LlmAdapter {
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const last = options.messages.at(-1)
    const toolResultText = last?.role === 'tool'
      ? last.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
      : ''

    if (toolResultText.length === 0) {
      const args = JSON.stringify({ description: 'cwd probe', prompt: 'report your workspace' })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: ToolCallId('call-delegate'), name: 'subagent', argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('call-delegate'), name: 'subagent', arguments: args } }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }

    const reply = `child reported:\n${toolResultText}`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: reply }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: reply.length } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export const name = 'mock-llm'
export const inject = ['llm']

/**
 * Register the delegating mock adapter under the `mock` provider.
 * @param ctx - the plugin context supplying `ctx.llm`.
 */
export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(['mock'], new MockDelegatingAdapter())
}
