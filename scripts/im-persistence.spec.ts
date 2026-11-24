/** IM attribution remains readable without the producer in released V4 and current readers. */
import { describe, expect, it } from 'vitest'
import { Session, SessionId, SessionLogOffset, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionFormatEventCollector, type SessionFormatEvent } from '@deepseek-ai/dsh-session-format'
import { releasedV4SessionFormatCodec as released, restoreReleasedV4Artifact } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'

const header = { version: 4, id: SessionId('im-reader'), createdAt: 1, isSeeded: false, delegationDepth: 0 } satisfies SessionHeader

function messages(im: boolean): SessionFormatEvent[] {
  return [
    { kind: 'user' },
    ...(im ? [{ kind: 'im', form: 'relay' }] : []),
  ].map((source, index) => ({ type: 'user/message', seq: index, time: index + 1, surfaceOp: 'append',
    data: { id: `message-${index}`, role: 'user', source, content: [{ type: 'text', text: `input-${index}` }] } }))
}

describe('IM source persistence compatibility', () => {
  it.each([false, true])('preserves historical input and optional IM attribution (IM present: %s)', (im) => {
    const events = messages(im)
    const physical = released.encodeHeader(header, 0)
    const collector = new SessionFormatEventCollector()
    const decoder = released.createDecoder(physical, 'strict')
    const current = sessionFormatCatalog.createRestore(physical, { recovery: 'strict', validation: 'current' })
    for (const event of events) {
      const row = released.encodeEvent(event)
      decoder.decodeRow(row, collector)
      current.decodeRow(row)
    }
    decoder.finish(collector)
    const oldRead = restoreReleasedV4Artifact({ header, events: collector.values, inheritedEventCount: 0 }, new Set(['user/message']))
    const newRead = current.finish()
    expect(oldRead.events).toEqual(events)
    expect(newRead.events).toEqual(events)
    for (const read of [oldRead, newRead]) {
      const session = Session.fromRestore(header.id, read.events as SessionEvent[], header, SessionLogOffset(0), 'detached')
      expect(session.deriveMessages()).toEqual(events.map(event => event['data']))
    }
  })
})
