import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ImageBlock } from '@deepseek-ai/dsh-llm'
import { deriveEventMessage, foldSurface, Session, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionEventMap } from '@deepseek-ai/dsh-session'
import { imageOffloadProjection } from '../src/projection.ts'

function createSession(...args: Parameters<typeof Session.create>): Session {
  args[4] = [imageOffloadProjection]
  return Session.create(...args)
}

const image: ImageBlock = {
  type: 'image',
  attachment: { attachmentId: `sha256:${'a'.repeat(64)}` as never, mediaType: 'image/png', bytes: 1, width: 1, height: 1 },
}

function input(session: Session, content: ContentBlock[] = [image, image]) {
  return session.append('user/message', createUserMessage({ content, source: { kind: 'user' } }), { surfaceOp: 'append' })
}

function marked(session: Session): boolean[] {
  const result: boolean[] = []
  const visit = (content: readonly ContentBlock[]): void => {
    for (const block of content) {
      if (block.type === 'image') result.push(block.offloaded === true)
      if (block.type === 'tool-result') visit(block.content)
    }
  }
  for (const message of session.deriveMessages()) visit(message.content)
  return result
}

describe('durable image selections', () => {
  it('preserves message identity, original data, and previously derived snapshots', () => {
    const session = createSession(SessionId('images'))
    const source = input(session, [
      { type: 'text', text: 'before' }, image,
      { type: 'tool-result', toolCallId: ToolCallId('nested'), content: [image, { type: 'text', text: 'after' }] },
      { type: 'tool-result', toolCallId: ToolCallId('text'), content: [{ type: 'text', text: 'unchanged' }] },
      image,
    ])
    const before = session.deriveMessages()
    session.append('image/offload', { targets: [{ seq: source.seq, imageIndexes: [1] }] })
    expect(marked(session)).toEqual([false, true, false])
    const after = session.deriveMessages()
    expect(after[0]?.id).toBe(before[0]?.id)
    expect(after[0]).toBe(session.deriveEventMessage(source))
    expect(Object.isFrozen(after[0])).toBe(true)
    expect(Object.isFrozen(after[0]?.content)).toBe(true)
    expect(after[0]?.content[0]).toBe(before[0]?.content[0])
    expect(after[0]?.content[3]).toBe(before[0]?.content[3])
    expect(JSON.stringify(source)).not.toContain('offloaded')
    expect(JSON.stringify(before)).not.toContain('offloaded')
    expect(session.surface.nodes).toEqual([source.seq])
    expect(session.surface.replaceGeneration).toBe(0)
    expect(session.surface.contentGeneration).toBe(1)
    expect(session.deriveEventMessage(session.snapshotEvents().at(-1)!)).toBeNull()
    session.append('image/offload', { targets: [{ seq: source.seq, imageIndexes: [0, 2] }] })
    expect(marked(session)).toEqual([true, true, true])
    expect(session.surface.contentGeneration).toBe(2)
    expect(after[0]).not.toBe(session.deriveMessages()[0])
  })

  it('reconstructs the same selections through pure folding, resume, restore, and fork', () => {
    const session = createSession(SessionId('source'))
    const source = input(session)
    const before = session.snapshotEvents()
    session.append('image/offload', { targets: [{ seq: source.seq, imageIndexes: [0] }] })
    const events = session.snapshotEvents()
    const fold = foldSurface(events, [imageOffloadProjection])
    expect(deriveEventMessage(source, fold.projectedMessages)).toEqual(session.deriveMessages()[0])
    expect(marked(createSession(SessionId('before'), before))).toEqual([false, false])
    expect(marked(createSession(SessionId('resume'), events))).toEqual([true, false])
    const restored = Session.fromRestore(session.id, events, session.header, SessionLogOffset(0), 'shared-frozen', [imageOffloadProjection])
    expect(marked(restored)).toEqual([true, false])
    const childId = SessionId('child')
    const child = createSession(childId, events, {
      ...session.header, id: childId, parentSession: session.id, isSeeded: true,
    }, SessionLogOffset(events.length))
    expect(marked(child)).toEqual([true, false])
    input(child, [image])
    expect(marked(child)).toEqual([true, false, false])
    expect(marked(session)).toEqual([true, false])
  })

  it('counts all images in a tool result without changing its call identity', () => {
    const session = createSession(SessionId('tool'))
    const source = session.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({ callId: ToolCallId('shot'), isError: false, content: [image, image] }),
    }, { surfaceOp: 'append' })
    session.append('image/offload', { targets: [{ seq: source.seq, imageIndexes: [1] }] })
    expect(marked(session)).toEqual([false, true])
    expect(session.deriveEventMessage(source)?.source).toEqual(source.data.message.source)
  })

  it.each([
    null, {}, { targets: [] }, { targets: 'bad' }, { targets: [null] },
    { targets: [{ seq: 0, imageIndexes: [] }] },
    { targets: [{ seq: 0, imageIndexes: [0], extra: true }] },
    { targets: [{ seq: 0, imageIndexes: [0] }], extra: true },
    { targets: [{ seq: -1, imageIndexes: [0] }] },
    { targets: [{ seq: 0, imageIndexes: [-1] }] },
    { targets: [{ seq: 0, imageIndexes: [0.5] }] },
    { targets: [{ seq: 0, imageIndexes: ['0'] }] },
    { targets: [{ seq: 0, imageIndexes: [1, 0] }] },
    { targets: [{ seq: 0, imageIndexes: [0, 0] }] },
    { targets: [{ seq: 0, imageIndexes: [2] }] },
    { targets: [{ seq: 1, imageIndexes: [0] }] },
    { targets: [{ seq: 0, imageIndexes: [0] }, { seq: 0, imageIndexes: [1] }] },
  ])('rejects malformed selections at append and replay without partial application: %j', (data) => {
    const session = createSession(SessionId('invalid'))
    input(session)
    const events = session.snapshotEvents()
    const candidate = { type: 'image/offload', seq: SessionSeq(1), time: 0, data } as SessionEvent
    expect(() => session.append('image/offload', data as SessionEventMap['image/offload'])).toThrow(/image\/offload/)
    expect(() => createSession(SessionId('seed'), [...events, candidate])).toThrow(/image\/offload/)
    expect(() => foldSurface([...events, candidate], [imageOffloadProjection])).toThrow(/image\/offload/)
    expect(session.snapshotEvents()).toEqual(events)
    expect(marked(session)).toEqual([false, false])
    expect(session.surface.contentGeneration).toBe(0)
    session.append('image/offload', { targets: [{ seq: SessionSeq(0), imageIndexes: [1] }] })
    expect(marked(session)).toEqual([false, true])
  })

  it('rejects repeated offloads and shadowed or assistant targets', () => {
    const session = createSession(SessionId('invalid-targets'))
    const source = input(session)
    session.append('image/offload', { targets: [{ seq: source.seq, imageIndexes: [0] }] })
    expect(() => session.append('image/offload', { targets: [{ seq: source.seq, imageIndexes: [0] }] })).toThrow(/already offloaded/)
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'summary' }], source: { kind: 'user' } }), {
      surfaceOp: { op: 'replace', startSeq: source.seq, endSeq: source.seq }, sourceEventSeqs: [source.seq],
    })
    expect(() => session.append('image/offload', { targets: [{ seq: source.seq, imageIndexes: [1] }] })).toThrow(/not a current/)
    const assistant = session.append('assistant/message', {
      turn: 1, step: 1, stream: [],
      message: createAssistantMessage({ content: [image], source: { provider: 'mock', model: 'mock' } }),
    }, { surfaceOp: 'append' })
    expect(() => session.append('image/offload', { targets: [{ seq: assistant.seq, imageIndexes: [0] }] })).toThrow(/must be user\/message/)
  })
})
