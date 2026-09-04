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
    const openTurn = agent.session.snapshotEvents().findLast(event => event.type === 'turn/start')
    if (openTurn?.type !== 'turn/start') throw new Error('workspace snapshot compaction has no open turn')
    const compactionId = CompactionId('workspace-context-fixture')
    const content = [{ type: 'text' as const, text: 'Earlier context was compacted for this snapshot.' }]
    agent.session.append('compaction/start', { compactionId, turn: openTurn.data.turn })
    agent.session.append('compaction/summary', {
      compactionId,
      summary: content,
      shadowedRange: { start: baseline.seq, end: baseline.seq },
      shadowedSeqs: [baseline.seq],
      shadowedTokenCount: 1,
      provider: 'snapshot',
      model: 'snapshot',
    })
    agent.session.append('user/message', createUserMessage({
      content,
      source: compactCheckpointSource(compactionId),
    }), {
      surfaceOp: { op: 'replace', start: baseline.seq, end: baseline.seq },
      sourceEventSeqs: [baseline.seq],
    })
    agent.session.append('compaction/end', { compactionId, turn: openTurn.data.turn })
    return downstream
  })
}
