import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { AgentToolRegistry } from '@deepseek-ai/dsh-tools/pipeline'

export const name = 'snapshot-in-history-series-start'
export const inject = ['tools', 'systemPrompt']

/**
 * Change the rendered prompt after the first read, then replace the first admitted user
 * message before the third step. That step starts a new request series while the rendered
 * prompt is unchanged, which must keep both prompt versions in the request.
 */
export function apply(ctx: Context): void {
  const tools = new AgentToolRegistry()
  ctx.effect(() => tools.register(defineContentToolFixture({
    name: 'snapshot_ping', description: 'Return pong once.', parameters: {},
    async execute() { return [{ type: 'text', text: 'pong' }] },
  })), 'snapshot-in-history-series-start.snapshot_ping')
  ctx.tools.include(tools)
  let guidance = ''
  ctx.systemPrompt.section({ name: 'snapshot:series-start-guidance', order: 400, text: () => guidance })
  // The calling Agent's next step declares the tool change.
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const downstream = await next()
    if (result.isError || exec.agent === undefined) return downstream
    if (exec.name === 'read' && guidance === '') {
      guidance = 'Snapshot guidance added after the first read: call snapshot_ping once, then reply DONE.'
      tools.set(exec.agent, ['snapshot_ping'])
    }
    if (exec.name === 'snapshot_ping') tools.set(exec.agent, [])
    return downstream
  })
  let steps = 0
  ctx.on('agent/pre-step', ({ agent }, next) => {
    steps += 1
    if (steps === 3) {
      const seq = agent.session.surface.nodes.find(node =>
        agent.session.eventAt(node)?.type === 'user/message')
      if (seq !== undefined) {
        agent.session.append('user/message', createUserMessage({
          content: [{ type: 'text', text: 'Snapshot checkpoint replacing the first admitted user message.' }],
          source: { kind: 'test-compaction' },
        }), { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] })
      }
    }
    return next()
  })
  let requests = 0
  ctx.on('llm/stream', (options, next) => {
    requests += 1
    const systems = options.messages.filter(message => message.role === 'system').length
    if (requests === 3) assert.equal(systems, 2, 'series-start request keeps both system prompt versions')
    return next()
  })
}
