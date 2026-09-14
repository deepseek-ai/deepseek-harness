/** Current-generation benchmark seeds retain the system head across continuation. */
import { expect, it } from 'vitest'
import { createSystemMessage } from '@deepseek-ai/dsh-llm'
import { parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { syntheticHistory as browserHistory } from '../long-session-browser/synthetic-history.ts'
import { syntheticHistory } from './workload.ts'

const header = { type: 'session', version: SESSION_FORMAT_VERSION, id: 'benchmark-seed-check', createdAt: 1_700_000_000_000, cwd: '/bench', isSeeded: false, delegationDepth: 0 }

for (const [name, generate] of [
  ['continuation', () => [JSON.stringify(header), ...syntheticHistory(2).map(event => JSON.stringify(event))].join('\n')],
  ['browser', browserHistory],
] as const) {
  it(name + ' seed preserves a protected head when the next prompt replaces it', () => {
    const events = parseSessionLog(generate())
    expect(events.slice(0, 4).map(event => event.type)).toEqual(['turn/start', 'step/start', 'system/message', 'user/message'])
    const session = Session.create(SessionId(header.id), events)
    const head = session.surface.nodes[0]!
    expect(session.eventAt(head)).toMatchObject({ type: 'system/message', data: { turn: 1, step: 1, message: { role: 'system', content: [] } } })
    const history = session.deriveMessages()
    const turn = events.filter(event => event.type === 'turn/start').length + 1
    session.append('turn/start', { turn })
    session.append('step/start', { turn, step: 1 })
    const replacement = session.append('system/message', {
      turn, step: 1, message: createSystemMessage('Next synthetic prompt', '@deepseek-ai/dsh-system-prompt'),
    }, { surfaceOp: { op: 'replace', startSeq: head, endSeq: head }, sourceEventSeqs: [head] })
    const restored = Session.create(SessionId(header.id), parseSessionLog([
      JSON.stringify(header), ...session.snapshotEvents().map(event => JSON.stringify(event)),
    ].join('\n')))
    expect(restored.surface.nodes[0]).toBe(replacement.seq)
    expect(restored.deriveMessages()[0]).toMatchObject({ role: 'system', content: [{ type: 'text', text: 'Next synthetic prompt' }] })
    expect(restored.deriveMessages().slice(1)).toEqual(history)
    for (const event of events) {
      if (event.type === 'session/title') expect(session.eventAt(event.data.messageSeqs[0]!)?.type).toBe('user/message')
      if (event.type === 'tool/result') expect(session.eventAt(event.sourceEventSeqs![0]!)?.type).toBe('tool/call')
    }
  })
}
