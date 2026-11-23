import { brandString } from '@deepseek-ai/dsh-brand'
import { describe, expect, it } from 'vitest'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import { type ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ContinuableSubagentDescriptorData } from '../src/descriptor.ts'
import { snapshotSubagentDescriptor } from '../src/descriptor.ts'
import { requireInitialModel, restorationOptions } from '../src/model-selection.ts'

const CURRENT = snapshotSubagentDescriptor({ mode: 'continuable', provider: 'spawn', label: 'child' })
const HISTORICAL: ContinuableSubagentDescriptorData = {
  ...CURRENT,
  agentProvider: 'initial', agentModel: 'historical', agentReasoningEffort: brandString<ReasoningEffortId>('low'),
}
const RECORDED = { provider: 'chosen', model: 'next' }

describe('initial child model selection', () => {
  it('captures the route and explicit effort without activation controls', () => {
    const options = { provider: 'p', model: 'm', reasoningEffort: brandString<ReasoningEffortId>('high'), maxTokens: 2048 }
    expect(requireInitialModel(options)).toEqual({ provider: 'p', model: 'm', reasoningEffort: 'high' })
    expect(requireInitialModel({ provider: 'p', model: 'm' })).toEqual({ provider: 'p', model: 'm' })
  })

  it.each<AgentOptions>([{}, { provider: 'p' }, { model: 'm' }])('rejects an unresolved route: %j', (options) => {
    expect(() => requireInitialModel(options)).toThrow(expect.objectContaining({ code: 'MODEL_UNAVAILABLE' }))
  })
})

describe('restored child options', () => {
  it('leaves a current child to its recorded choice', () => {
    expect(restorationOptions(CURRENT, RECORDED)).toEqual({})
  })

  it.each([RECORDED, null, undefined])('keeps a historical route as the fallback when the recorded choice is %j', (recorded) => {
    expect(restorationOptions(HISTORICAL, recorded))
      .toEqual({ provider: 'initial', model: 'historical', reasoningEffort: 'low' })
    const { agentReasoningEffort: _effort, ...withoutEffort } = HISTORICAL
    expect(restorationOptions(withoutEffort, recorded)).toEqual({ provider: 'initial', model: 'historical' })
  })

  it.each([null, undefined])('rejects a child with no recorded choice and no complete route (%j)', (recorded) => {
    const { agentModel: _model, ...partial } = HISTORICAL
    for (const descriptor of [CURRENT, partial]) {
      const restore = () => restorationOptions(descriptor, recorded)
      expect(restore).toThrow(expect.objectContaining({ code: 'NOT_RESUMABLE' }))
      expect(restore).toThrow('no complete saved model selection')
    }
    expect(restorationOptions(partial, RECORDED)).toEqual({ provider: 'initial', reasoningEffort: 'low' })
  })

  it('routes a maintenance restoration through the choice it records only when no saved model exists', () => {
    const selecting = { provider: 'repair', model: 'chosen', reasoningEffort: brandString<ReasoningEffortId>('high') }
    expect(restorationOptions(CURRENT, null, selecting)).toEqual(selecting)
    expect(restorationOptions(CURRENT, RECORDED, selecting)).toEqual({})
    expect(restorationOptions(HISTORICAL, null, selecting))
      .toEqual({ provider: 'initial', model: 'historical', reasoningEffort: 'low' })
  })
})
