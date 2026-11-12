/** Shared real Agent execution and deterministic provider for storage integration tests. @module */
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-loop'
import type {} from '@deepseek-ai/dsh-cmdline'

/** Deterministic model for user echoes, tool dispatch, and persisted-result recall. */
export class EchoModel extends LlmAdapter {
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const last = options.messages.findLast(message => message.role === 'user'
      && (!('source' in message) || message.source.kind === 'user'))
    let text = last?.content.filter(block => block.type === 'text').map(block => block.text).join('') ?? ''
    if ((text.includes('TRACE_TWO') || text.includes('LEGACY_THREE'))
      && !options.messages.some(message => message.role === 'tool')) throw new Error('Persisted tool history was not restored')
    if (text.includes('RECALL_LAST_TOOL')) {
      const previous = options.messages.findLast(message => message.role === 'tool')
      if (previous === undefined) throw new Error('Persisted tool result is missing')
      text = previous.content.filter(block => block.type === 'text').map(block => block.text).join('')
    }
    if (text.includes('TOOL_PROOF')) {
      const tool = options.messages.findLast(message => message.role === 'tool')
      if (tool === undefined || options.messages.indexOf(tool) < options.messages.indexOf(last!)) {
        const id = ToolCallId('segment-call')
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name: 'segment_probe', argumentsDelta: '{}' }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'segment_probe', arguments: '{}' } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      text = tool.content.filter(block => block.type === 'text').map(block => block.text).join('')
    }
    yield { type: 'block-start' as const, index: 0, blockType: 'text' }
    yield { type: 'text-delta' as const, index: 0, text }
    yield { type: 'block-end' as const, index: 0, block: { type: 'text' as const, text } }
    yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
  }
}

/**
 * Run one turn through the shipped Agent factory and await its durable checkpoint.
 * @param ctx - injected profile context.
 * @param id - fixture Session identity.
 * @param text - synthetic task.
 * @returns actual Agent class, backend and completed model output.
 */
export async function runSession(ctx: Context, id: string, text: string) {
  const legacy = await ctx.sessionPersistence.stat(SessionId(id))
  const model = ctx.agentDefaultModel.currentSelection()
  const handle = legacy === undefined
    ? await ctx.agents.create({ sessionId: SessionId(id), agentOptions: model, meta: { cwd: process.cwd() } })
    : await ctx.agents.resume({ resumeSessionId: SessionId(id), agentOptions: model })
  let output = '', failure: unknown
  const stop = ctx.on('session/event', (session, event) => {
    if (session === handle.agent.session && event.type === 'assistant/message') {
      output = event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('')
    }
  })
  const stopErrors = ctx.on('agent/error', ({ agent, error }) => { if (agent === handle.agent) failure = error })
  try {
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
    await handle.agent.whenIdle()
    await ctx.sessions.flush(handle.agent.session)
    if (failure !== undefined) throw failure
    const stored = await ctx.sessionPersistence.stat(SessionId(id))
    if (stored === undefined) throw new Error('Session did not materialize')
    let route: 'jsonl' | 'sqlite'
    if (stored.location?.kind === 'jsonl') route = 'jsonl'
    else if (stored.eventCount !== undefined) route = 'sqlite'
    else throw new Error('Expected materialized JSONL or SQLite storage metadata')
    return { id, route, runtime: handle.agent.constructor.name, output }
  } finally { stop(); stopErrors(); await handle.dispose() }
}
