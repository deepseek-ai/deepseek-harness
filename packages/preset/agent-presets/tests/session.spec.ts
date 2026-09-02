/** The Session projection that records which preset a Session runs. */

import { describe, expect, it } from 'vitest'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { agentPresetProjectionDefinition } from '../src/session.ts'

/** A header carrying the creation-time preset, if any. */
function header(agentPreset?: string): SessionHeader {
  return {
    version: 0,
    id: SessionId('s'),
    createdAt: 1,
    isSeeded: false,
    delegationDepth: 0,
    ...agentPreset === undefined ? {} : { agentPreset },
  }
}

/** One logged selection, as `agentPreset.select` appends it. */
function selected(agentPreset: string, seq: SessionSeq): SessionEvent {
  return { type: 'agent-preset/selected', seq, time: seq, data: { agentPreset } }
}

describe('agent preset selection projection', () => {
  it('starts from the creation header, including no configured preset', () => {
    expect(agentPresetProjectionDefinition.init(header('standard'))).toBe('standard')
    expect(agentPresetProjectionDefinition.init(header())).toBeNull()
  })

  it('starts from the header and keeps the latest selected preset', () => {
    const definition = agentPresetProjectionDefinition
    let state = definition.init(header('standard'))
    expect(state).toBe('standard')

    state = definition.apply(state, selected('minimal', SessionSeq(0)))
    state = definition.apply(state, {
      type: 'turn/end', seq: SessionSeq(1), time: 1, data: { turn: 1, reason: { kind: 'completed' } },
    })
    state = definition.apply(state, selected('cordis', SessionSeq(2)))

    expect(definition.wire.view(state)).toBe('cordis')
    expect(definition.stateSchema.parse(state)).toBe('cordis')
  })
})
