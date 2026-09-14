/** Structural promotion preserves each historical request and distinguishes local from captured coordinates. */

import { describe, expect, it } from 'vitest'
import { SessionFormatEventCollector, SessionFormatUnsupportedMigrationError } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatArtifact, SessionFormatEvent, SessionFormatHeader, SessionFormatJsonObject } from '@deepseek-ai/dsh-session-format'
import { releasedV3SessionFormatCodec, restoreReleasedV3Artifact, sessionFormatV2ToV3 } from '../src/index.ts'

const header: SessionFormatHeader = {
  version: 2, id: 'structural-regressions', createdAt: 1, isSeeded: false, delegationDepth: 0,
}
const config = { provider: 'mock', model: 'mock' }
const message = (id: string) => ({ id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: id }] })
const row = (type: string, data: SessionFormatEvent['data'], fields: SessionFormatJsonObject = {}): SessionFormatEvent => ({ type, seq: 0, time: 0, data, ...fields })
const user = (id: string) => row('user/message', message(id), { surfaceOp: 'append' })
const request = (system?: string) => row('request/header', { reason: 'initial', header: { config, ...(system === undefined ? {} : { system }) } })
const dense = (events: readonly SessionFormatEvent[]) => events.map((event, seq) => ({ ...event, seq, time: -100 + seq * 7 }))
const opening = (turn = 1, step = 1) => [row('turn/start', { turn }), row('step/start', { turn, step })]
const closing = (turn = 1, step = 1) => [row('step/end', { turn, step }), row('turn/end', { turn, reason: { kind: 'completed' } })]
const turn = (number: number, prompt: string) => [...opening(number), user(`user-${number}`), request(prompt), ...closing(number)]

function migrate(events: readonly SessionFormatEvent[], sourceHeader = header, sourceInheritedEventCount?: number): SessionFormatArtifact {
  const targetHeader = sessionFormatV2ToV3.migrateHeader(sourceHeader)
  const stage = sessionFormatV2ToV3.createStage({ sourceHeader, targetHeader, sourceInheritedEventCount, sourceKind: 'decoded' })
  const collector = new SessionFormatEventCollector()
  for (const event of events) stage.transformEvent(event, collector)
  return restoreReleasedV3Artifact({
    header: targetHeader, inheritedEventCount: stage.finish(collector), events: collector.values,
  }, new Set())
}

function roundTrip(artifact: SessionFormatArtifact): SessionFormatArtifact {
  const decoder = releasedV3SessionFormatCodec.createDecoder(releasedV3SessionFormatCodec.encodeHeader(artifact.header, artifact.inheritedEventCount), 'strict')
  const collector = new SessionFormatEventCollector()
  for (const event of artifact.events) decoder.decodeRow(releasedV3SessionFormatCodec.encodeEvent(event), collector)
  return restoreReleasedV3Artifact({
    header: decoder.header, inheritedEventCount: decoder.finish(collector), events: collector.values,
  }, new Set())
}

function requestMessages(events: readonly SessionFormatEvent[]) {
  const surface: SessionFormatEvent[] = []
  const requests: unknown[] = []
  for (const event of events) {
    if (event['surfaceOp'] === 'append') surface.push(event)
    else if (event['surfaceOp'] !== undefined) {
      const operation = event['surfaceOp'] as SessionFormatJsonObject
      const start = surface.findIndex(candidate => candidate.seq === operation['startSeq'])
      const end = surface.findIndex(candidate => candidate.seq === operation['endSeq'])
      expect(start).toBeGreaterThanOrEqual(0)
      expect(end).toBeGreaterThanOrEqual(start)
      surface.splice(start, end - start + 1, event)
    }
    if (event.type === 'request/header') {
      requests.push(surface.flatMap((entry) => {
        const data = entry.data as SessionFormatJsonObject
        const value = (entry.type === 'user/message' ? data : data['message']) as SessionFormatJsonObject
        return (value['content'] as readonly unknown[]).length === 0 ? [] : [{ role: value['role'], content: value['content'] }]
      }))
    }
  }
  return requests
}

const visible = (role: string, text: string) => ({ role, content: [{ type: 'text', text }] })
const systems = (artifact: SessionFormatArtifact) => artifact.events.filter(event => event.type === 'system/message')
const systemId = (event: SessionFormatEvent) => ((event.data as SessionFormatJsonObject)['message'] as SessionFormatJsonObject)['id']

function startedToolCall(): SessionFormatEvent[] {
  return [
    row('assistant/message', { turn: 1, step: 1, stream: [], message: {
      id: 'tool-request', role: 'assistant', source: { kind: 'model', provider: 'mock', model: 'mock' },
      content: [{ type: 'tool-call', id: 'call', name: 'read', arguments: '{}' }],
    } }, { surfaceOp: 'append' }),
    row('tool/call', { turn: 1, step: 1, callId: 'call', name: 'read', arguments: '{}' }),
  ]
}

const carriers = [
  ['user', (value: SessionFormatJsonObject) => row('user/message', value, { surfaceOp: 'append' })],
  ['assistant', (value: SessionFormatJsonObject) => row('assistant/message', { turn: 1, step: 1, stream: [], message: { ...value, role: 'assistant', source: { kind: 'model', provider: 'mock', model: 'mock' } } }, { surfaceOp: 'append' })],
  ['tool', (value: SessionFormatJsonObject) => row('tool/result', { turn: 1, step: 1, message: { ...value, source: { kind: 'tool', callId: 'call' }, content: [{ type: 'tool-result', toolCallId: 'call', content: [] }] } }, { surfaceOp: 'append' })],
  ['inbox', (value: SessionFormatJsonObject) => row('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [value] })],
  ['title', (value: SessionFormatJsonObject) => row('session/title-llm-request', { titleProvider: 'mock', messageSeqs: [2], route: config, system: 'title', messages: [{ ...value, source: { kind: 'plugin', plugin: 'dsh-session-title-llm' } }], maxTokens: 20 })],
] satisfies [string, (value: SessionFormatJsonObject) => SessionFormatEvent][]

describe('structural prompt history regressions', () => {
  it('preserves every request across step and turn changes, repeated text, clear and reintroduction', () => {
    const input = dense([
      ...opening(), user('a'), request('alpha'), row('step/end', { turn: 1, step: 1 }),
      row('step/start', { turn: 1, step: 2 }), user('b'), request('beta'), request('beta'), ...closing(1, 2),
      ...opening(2), user('c'), request(), request('alpha'), ...closing(2),
    ])
    const before = JSON.stringify(input)
    const target = migrate(input)
    const a = visible('user', 'a')
    const b = visible('user', 'b')
    const c = visible('user', 'c')
    expect(requestMessages(target.events)).toEqual([
      [visible('system', 'alpha'), a],
      [visible('system', 'beta'), a, b],
      [visible('system', 'beta'), a, b],
      [a, b, c],
      [visible('system', 'alpha'), a, b, c],
    ])
    expect(systems(target).map(event => [event.seq, event.time, (event.data as SessionFormatJsonObject)['turn'], (event.data as SessionFormatJsonObject)['step'], event['surfaceOp'], event['sourceEventSeqs']])).toEqual([
      [2, input[1]!.time, 1, 1, 'append', undefined],
      [4, input[3]!.time, 1, 1, { op: 'replace', startSeq: 2, endSeq: 2 }, [2]],
      [9, input[7]!.time, 1, 2, { op: 'replace', startSeq: 4, endSeq: 4 }, [4]],
      [17, input[14]!.time, 2, 1, { op: 'replace', startSeq: 9, endSeq: 9 }, [9]],
      [19, input[15]!.time, 2, 1, { op: 'replace', startSeq: 17, endSeq: 17 }, [17]],
    ])
    expect(target.events.filter(event => event.type === 'user/message').map(event => event.data)).toEqual([message('a'), message('b'), message('c')])
    expect(target.events.filter(event => event.type !== 'system/message').map(event => [event.type, event.time])).toEqual(input.map(event => [event.type, event.time]))
    expect(target.events.filter(event => event.type === 'request/header').map(event => event.data)).toEqual(Array.from({ length: 5 }, () => ({ reason: 'initial', header: { config } })))
    expect(roundTrip(target)).toEqual(target)
    expect(JSON.stringify(input)).toBe(before)
  })

  it('keeps generated identities stable across reads but distinct across Session IDs and source anchors', () => {
    const input = dense([...opening(), request('alpha'), request('beta'), request('alpha')])
    const target = migrate(input)
    const ids = systems(target).map(systemId)
    expect(new Set(ids).size).toBe(4)
    expect(systems(migrate(input)).map(systemId)).toEqual(ids)
    expect(systems(migrate(input, { ...header, id: 'another-session' })).map(systemId).every(id => !ids.includes(id))).toBe(true)
    expect(systems(migrate(input.map(event => ({ ...event, time: event.time + 1000 })))).map(systemId)).toEqual(ids)
  })

  it.each(carriers)('refuses generated head IDs in later %s message carriers', (name, carry) => {
    const prefix = dense([...opening(), user('human'), request('prompt'), ...(name === 'tool' ? startedToolCall() : [])])
    const id = systemId(systems(migrate(prefix))[0]!) as string
    const ordinary = carry(message('ordinary'))
    const control = migrate(dense([...prefix, ordinary, ...closing()]))
    expect(control.events.at(-3)?.data).toEqual(name === 'title'
      ? { ...ordinary.data as SessionFormatJsonObject, messageSeqs: [3] }
      : ordinary.data)
    expect(roundTrip(control)).toEqual(control)
    const input = dense([...prefix, carry(message(id)), ...closing()])
    const before = JSON.stringify(input)
    expect(() => migrate(input)).toThrow(SessionFormatUnsupportedMigrationError)
    expect(() => migrate(input)).toThrow(/source message id collides/)
    expect(JSON.stringify(input)).toBe(before)
  })
})

describe('structural inherited ownership and reference regressions', () => {
  it.each([undefined, 13])('maps the last inherited marker independently of later local prompt insertions (source cut %s)', (cut) => {
    const input = dense([
      ...turn(1, 'grandparent'), row('session/end-seed', { inherited: true }),
      ...turn(2, 'parent'), row('session/end-seed', { inherited: true }),
      ...turn(3, 'local'), row('session/end-seed', {}),
    ])
    const target = migrate(input, { ...header, isSeeded: true, parentSession: 'parent' }, cut)
    expect(target.inheritedEventCount).toBe(16)
    expect(target.events.filter(event => event.type === 'session/end-seed')).toEqual([
      { ...input[6], seq: 8 }, { ...input[13], seq: 16 }, { ...input[20], seq: 24 },
    ])
    expect(systems(target).map(event => event.seq < target.inheritedEventCount)).toEqual([true, true, true, false])
    expect(requestMessages(target.events)).toEqual([
      [visible('system', 'grandparent'), visible('user', 'user-1')],
      [visible('system', 'parent'), visible('user', 'user-1'), visible('user', 'user-2')],
      [visible('system', 'local'), visible('user', 'user-1'), visible('user', 'user-2'), visible('user', 'user-3')],
    ])
    expect(roundTrip(target)).toEqual(target)
  })

  it('keeps a zero-length inherited prefix when the first step and all generated systems are local', () => {
    const input = dense([row('session/end-seed', { inherited: true }), ...turn(1, 'local')])
    const target = migrate(input, { ...header, isSeeded: true, parentSession: 'parent' }, 0)
    expect(target.inheritedEventCount).toBe(0)
    expect(target.events[0]).toEqual(input[0])
    expect(systems(target).map(event => event.seq)).toEqual([3, 5])
    expect(roundTrip(target)).toEqual(target)
  })

  it('remaps references on both sides of a prompt insertion without reinterpreting same-Session captures or framed title input', () => {
    const capture = { sessionId: header.id, label: 'same-session', capturedThroughSeq: 2, capturedFormatVersion: 2, compacted: false, originalMessages: 1, retainedMessages: 1, omittedMessages: 0, omittedBytes: 0, truncated: false, inputIndex: 0 }
    const recalled = { ...message('capture'), source: { kind: 'session-reference', form: 'recall', version: 1, references: [capture] } }
    const titleInput = { ...message('title-input'), source: { kind: 'plugin', plugin: 'dsh-session-title-llm' }, content: [{ type: 'text', text: 'Generate the session title from this JSON array of human messages:\n[{"seq":2,"text":"a"},{"seq":4,"text":"b"}]' }] }
    const input = dense([
      ...opening(), user('a'), request('prompt'), user('b'),
      row('user/message', recalled, { surfaceOp: 'append', sourceEventSeqs: [2, 4] }),
      row('command/run', { commandId: 'command', name: 'recall', source: { kind: 'user' } }),
      row('command/done', { commandId: 'command', kind: 'success', sourceEventSeq: 5 }),
      row('session/title', { title: 'title', messageSeqs: [2, 4], source: { kind: 'fallback' } }),
      row('session/title-llm-request', { titleProvider: 'mock', messageSeqs: [2, 4], route: config, system: 'title prompt', messages: [titleInput], maxTokens: 20 }),
    ])
    const target = migrate(input)
    expect(target.events[7]).toEqual({ ...input[5], seq: 7, sourceEventSeqs: [3, 6] })
    expect(target.events[7]?.data).toEqual(recalled)
    expect(target.events[9]?.data).toEqual({ commandId: 'command', kind: 'success', sourceEventSeq: 7 })
    expect(target.events[10]?.data).toEqual({ title: 'title', messageSeqs: [3, 6], source: { kind: 'fallback' } })
    expect(target.events[11]?.data).toEqual({ titleProvider: 'mock', messageSeqs: [3, 6], route: config, system: 'title prompt', messages: [titleInput], maxTokens: 20 })
    expect(roundTrip(target)).toEqual(target)
  })
})

describe('nested source audit regressions', () => {
  it.each(carriers.filter(([name]) => name !== 'assistant' && name !== 'tool'))('refuses unknown content in %s messages even when the event is ignorable', (_name, carry) => {
    const input = dense([...opening(), user('human'), { ...carry({ ...message('future'), content: [{ type: 'future-block', sourceEventSeq: 2 }] }), ignorable: true }])
    expect(() => migrate(input)).toThrow(/cannot safely transform unclassified message content/)
  })

  it('audits nested tool-result content instead of preserving unknown blocks as opaque tool JSON', () => {
    const result = (content: SessionFormatJsonObject[]) => row('tool/result', { turn: 1, step: 1, message: {
      id: 'result', role: 'user', source: { kind: 'tool', callId: 'call' },
      content: [{ type: 'tool-result', toolCallId: 'call', content }],
    } }, { surfaceOp: 'append', ignorable: true })
    const prefix = [...opening(), request('prompt'), ...startedToolCall()]
    const ordinary = result([{ type: 'text', text: 'file contents' }])
    const control = migrate(dense([...prefix, ordinary, ...closing()]))
    expect(control.events.at(-3)?.data).toEqual(ordinary.data)
    expect(roundTrip(control)).toEqual(control)
    const unknown = result([{ type: 'future-block', sourceEventSeq: 2 }])
    expect(() => migrate(dense([...prefix, unknown, ...closing()]))).toThrow(/cannot safely transform unclassified message content/)
  })
})
