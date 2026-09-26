/** Unknown producer attribution survives the native codec and detached Session reader. */
import { describe, expect, it } from 'vitest'
import { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionFormatEventCollector } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatEvent } from '@deepseek-ai/dsh-session-format'
import { releasedV4SessionFormatCodec as codec, restoreReleasedV4Artifact } from '../src/index.ts'

const header = { version: 4, id: 'unknown-attribution', createdAt: 1, isSeeded: false, delegationDepth: 0 }

describe('uninstalled producer attribution', () => {
  it.each(['user', 'developer'] as const)('preserves %s source metadata through decoding, adoption and derivation', (role) => {
    const message = {
      id: 'attributed-message', role,
      source: { kind: 'external-attribution', location: { file: 'notes.txt', lines: [2, 5] }, enabled: false },
      content: [{ type: 'text', text: 'Retain this context.' }],
    }
    const input: SessionFormatEvent[] = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
      { type: `${role}/message`, seq: 2, time: 3, surfaceOp: 'append', data: role === 'user' ? message : { turn: 1, step: 1, message } },
      { type: 'step/end', seq: 3, time: 4, data: { turn: 1, step: 1 } },
      { type: 'turn/end', seq: 4, time: 5, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    const physical = input.map(event => JSON.stringify(codec.encodeEvent(event)))
    const output = new SessionFormatEventCollector()
    const decoder = codec.createDecoder(codec.encodeHeader(header, 0), 'strict')
    for (const row of physical) decoder.decodeRow(JSON.parse(row), output)
    const inheritedEventCount = decoder.finish(output)
    const artifact = { header, events: output.values, inheritedEventCount }
    const restored = restoreReleasedV4Artifact(artifact, new Set(input.map(event => event.type)))
    expect(restored.events).toEqual(input)
    // The format reader validates stored JSON; adoption validates the current Session fields.
    const session = Session.fromRestore(
      SessionId(header.id), restored.events as readonly SessionEvent[], restored.header as unknown as SessionHeader,
      SessionLogOffset(restored.inheritedEventCount), 'detached',
    )
    expect(session.deriveMessages()).toEqual([message])
    expect(restored.events.map(event => JSON.stringify(codec.encodeEvent(event)))).toEqual(physical)
  })
})
