import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { CompactionId, compactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-tools'

export const name = 'workspace-context-compaction'

/** Replace the visible workspace baseline after the first touch is fully projected. */
export function apply(ctx: Context): void {
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const downstream = await next()
    if (result.isError
      || exec.agent === undefined
      || exec.name !== 'read'
      || typeof exec.arguments !== 'object'
      || exec.arguments === null
      || !('file_path' in exec.arguments)
      || exec.arguments.file_path !== 'nested/task.txt') return downstream
    const agent = exec.agent
    const baseline = agent.session.surface.nodes
      .map(seq => agent.session.snapshotEvents()[seq])
      .find(event => event?.type === 'user/message'
        && event.data.source.kind === 'agent-instructions'
        && event.data.source.baseline === true)
    if (baseline === undefined) throw new Error('workspace baseline missing before snapshot compaction')
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Earlier context was compacted for this snapshot.' }],
      source: compactCheckpointSource(CompactionId('workspace-context-fixture')),
    }), {
      surfaceOp: { op: 'replace', start: baseline.seq, end: baseline.seq },
      sourceEventSeqs: [baseline.seq],
    })
    return downstream
  })
}
