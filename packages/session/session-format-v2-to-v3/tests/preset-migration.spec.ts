/** Released preset references change after strict source admission without rewriting opaque ids. */

import { describe, expect, it } from 'vitest'
import { SessionFormatError, SessionFormatEventCollector, SessionFormatUnsupportedMigrationError } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatEvent, SessionFormatJsonValue } from '@deepseek-ai/dsh-session-format'
import { sessionFormatV2ToV3 } from '../src/index.ts'

const header = Object.freeze({
  version: 2, id: 'code', createdAt: 1, isSeeded: false, delegationDepth: 0,
})

function migrate(event: SessionFormatEvent): SessionFormatEvent | undefined {
  const stage = sessionFormatV2ToV3.createStage({
    sourceHeader: header, targetHeader: sessionFormatV2ToV3.migrateHeader(header),
    sourceInheritedEventCount: 0, sourceKind: 'decoded',
  })
  const collector = new SessionFormatEventCollector()
  stage.transformEvent(event, collector)
  expect(stage.finish(collector)).toBe(0)
  return collector.values[0]
}

describe('released code preset references', () => {
  it.each([undefined, 'code', 'ptc', 'standard', 'minimal', 'custom-agent', 'code-custom', 'Code'])(
    'migrates only the exact legacy header preset (%s)', (agentPreset) => {
      const source = Object.freeze({ ...header, ...(agentPreset === undefined ? {} : { agentPreset }) })
      expect(sessionFormatV2ToV3.migrateHeader(source)).toEqual({
        ...source, version: 3, ...(agentPreset === 'code' ? { agentPreset: 'ptc' } : {}),
      })
      expect(source.version).toBe(2)
      expect(source.agentPreset).toBe(agentPreset)
    },
  )

  it.each(['code', 'ptc', 'standard', 'minimal', 'custom-agent', 'code-custom', 'Code'])(
    'preserves admitted selection metadata (%s)', (agentPreset) => {
      const event = Object.freeze({
        type: 'agent-preset/selected', seq: 0, time: -7, ignorable: true,
        data: Object.freeze({ agentPreset }),
      })
      const output = migrate(event)
      expect(output).toEqual({
        ...event, data: { ...event.data, agentPreset: agentPreset === 'code' ? 'ptc' : agentPreset },
      })
      expect(event.data.agentPreset).toBe(agentPreset)
    },
  )

  it.each<SessionFormatJsonValue>([null, [], {}, { agentPreset: 1 }])(
    'refuses a malformed durable selection (%j)', (data) => {
      expect(() => migrate({ type: 'agent-preset/selected', seq: 0, time: 1, data }))
        .toThrow(SessionFormatError)
    },
  )

  it.each([
    { extension: 'code', data: { agentPreset: 'code' } },
    { data: { agentPreset: 'code', extension: { agentPreset: 'code' } } },
  ])('refuses unaudited selection fields (%j)', (fields) => {
    expect(() => migrate({ type: 'agent-preset/selected', seq: 0, time: 1, ...fields }))
      .toThrow(/unexpected field extension/)
  })

  it('refuses sparse source sequences', () => {
    expect(() => migrate({ type: 'agent-preset/selected', seq: 19, time: 1, data: { agentPreset: 'code' } }))
      .toThrow(/source events must be dense/)
  })

  it('refuses unclassified preset-looking events even when ignorable', () => {
    const event = Object.freeze({
      type: 'external/selected', seq: 0, time: 1, ignorable: true,
      data: Object.freeze({ agentPreset: 'code', code: 'code' }),
    })
    expect(() => migrate(event)).toThrow(SessionFormatUnsupportedMigrationError)
  })
})
