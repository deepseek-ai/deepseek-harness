/** Initial and incremental tool definitions survive current-format restoration and forks. */
import { describe, expect, expectTypeOf, it } from 'vitest'
import { createDeveloperMessage } from '@deepseek-ai/dsh-llm'
import type { ToolAdditionBlock, ToolSchema } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { buildForkSeed } from '@deepseek-ai/dsh-session/fork'
import { createSessionFormatCatalog } from '@deepseek-ai/dsh-session-format'
import { restoreReleasedV4Artifact } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import { sessionFormatCatalogOptions } from '../src/generated.ts'
import type { SessionFormatEvent } from '@deepseek-ai/dsh-session-format'
import { sessionFormatCatalog } from '../src/index.ts'

function restore(session: Session): Session {
  const header = { ...session.header, delegationDepth: 0 }
  const reader = sessionFormatCatalog.createRestore(
    sessionFormatCatalog.encodeCurrentHeader(header, session.inheritedEventCount),
    { recovery: 'strict', validation: 'current' },
  )
  for (const event of session.snapshotEvents()) {
    reader.decodeRow(sessionFormatCatalog.encodeCurrentEvent(event as unknown as SessionFormatEvent))
  }
  const artifact = reader.finish()
  return Session.fromRestore(SessionId(artifact.header.id), artifact.events as SessionEvent[],
    artifact.header as unknown as SessionHeader, SessionLogOffset(artifact.inheritedEventCount), 'detached')
}

function toolStates(session: Session): (ToolSchema | undefined)[] {
  const initial = session.snapshotEvents().find(event => event.type === 'request/header')
  if (initial?.type !== 'request/header') throw new Error('missing initial request header')
  const active = new Map(initial.data.header.tools?.map(tool => [tool.name, tool]))
  const states = [active.get('search')]
  const events = session.snapshotEvents()
  for (const seq of session.surface.nodes) {
    const event = events[seq]
    if (event?.type !== 'developer/message') continue
    for (const block of event.data.message.content) {
      if (block.type === 'tool-addition') {
        const source = events[event.data.headerSeq!]
        if (source?.type !== 'request/header') throw new Error('missing referenced header')
        const tool = source.data.header.tools?.find(tool => tool.name === block.toolName)
        if (tool === undefined) throw new Error('missing referenced definition')
        active.set(block.toolName, tool)
      }
      else if (block.type === 'tool-removal') active.delete(block.toolName)
      else continue
      states.push(active.get('search'))
    }
  }
  return states
}

describe('developer tool history', () => {

  it.each([false, true])('defers ignorable developer interpretation until catalog completion (known: %s)', (knowsDeveloper) => {
    const header = { version: 4, id: 'opaque-developer', createdAt: 1, isSeeded: false, delegationDepth: 0 }
    const events: SessionFormatEvent[] = [
      { type: 'developer/message', seq: 0, time: 1, ignorable: true, surfaceOp: { future: true }, data: {
        message: { role: 'developer', source: { kind: 'plugin' } }, future: true,
      } },
      { type: 'turn/start', seq: 1, time: 2, data: { turn: 1 } },
      { type: 'step/start', seq: 2, time: 3, data: { turn: 1, step: 1 } },
    ]
    const known = new Set(events.map(event => event.type))
    if (!knowsDeveloper) known.delete('developer/message')
    const catalog = createSessionFormatCatalog({
      ...sessionFormatCatalogOptions,
      restoreCurrent: candidate => restoreReleasedV4Artifact(candidate, known),
    })
    const reader = catalog.createRestore(sessionFormatCatalog.encodeCurrentHeader(header, 0), { recovery: 'strict', validation: 'current' })
    for (const event of events) reader.decodeRow(event)
    if (knowsDeveloper) expect(() => reader.finish()).toThrow()
    else expect(reader.finish()).toEqual({ header, events, inheritedEventCount: 0 })
  })

  it('stores only the activated name in each addition', () => {
    expectTypeOf<ToolAdditionBlock>().toEqualTypeOf<{ type: 'tool-addition'; toolName: string; tool?: never }>()
  })

  it('reconstructs remove/re-add and replacement from historical headers after restart and fork', () => {
    const parent = Session.create(SessionId('tool-history'))
    const initial: ToolSchema = { name: 'search', description: 'Initial', parameters: {} }
    const first: ToolSchema = { name: 'search', description: 'First', parameters: { properties: { query: { type: 'string' } } }, deferLoading: true }
    const second: ToolSchema = { name: 'search', description: 'Second', parameters: { properties: { limit: { type: 'number' } } } }
    const third: ToolSchema = { name: 'search', description: 'Third', parameters: { properties: { exact: { type: 'boolean' } } } }
    const expected = structuredClone([initial, first, undefined, second, third])
    const append = (turn: number, tool: ToolSchema) => {
      const headerSeq = parent.append('request/header', { reason: 'change', header: { config: { provider: 'test', model: 'test' }, tools: [tool] } }).seq
      return parent.append('developer/message', {
        turn, step: 1, headerSeq, message: createDeveloperMessage({ source: { kind: 'tool-registry' }, content: [{ type: 'tool-addition', toolName: tool.name }] }),
      }, { surfaceOp: 'append' })
    }
    parent.append('turn/start', { turn: 1 })
    parent.append('step/start', { turn: 1, step: 1 })
    parent.append('request/header', { reason: 'initial', header: { config: { provider: 'test', model: 'test' }, tools: [initial] } })
    append(1, first)
    parent.append('developer/message', { turn: 1, step: 1, message: createDeveloperMessage({
      source: { kind: 'tool-registry' }, content: [{ type: 'tool-removal', toolName: 'search' }],
    }) }, { surfaceOp: 'append' })
    append(1, second)
    parent.append('step/end', { turn: 1, step: 1 })
    const boundary = parent.append('turn/end', { turn: 1, reason: { kind: 'completed' } }).seq
    parent.append('turn/start', { turn: 2 })
    parent.append('step/start', { turn: 2, step: 1 })
    append(2, third)
    parent.append('step/end', { turn: 2, step: 1 })
    parent.append('turn/end', { turn: 2, reason: { kind: 'completed' } })

    initial.description = 'mutated initial definition'
    first.description = 'mutated producer definition'
    first.parameters['properties'] = {}
    second.description = 'mutated replacement'
    expect(toolStates(parent)).toEqual(expected)
    expect(toolStates(restore(parent))).toEqual(expected)

    const childId = SessionId('tool-history-fork')
    const child = Session.create(childId, buildForkSeed(parent.snapshotEvents(), boundary),
      { ...parent.header, id: childId, parentSession: parent.id, isSeeded: true }, SessionLogOffset(boundary + 1))
    expect(toolStates(restore(child))).toEqual(expected.slice(0, 4))
  })
})
