import { Context } from '@deepseek-ai/cordis'
import { AgentModel, modelSelectionProjectionDefinition } from '@deepseek-ai/dsh-agent'
import AgentRegistry, { type ModelSelection } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { ReasoningEffortId, type LlmRuntime } from '@deepseek-ai/dsh-llm'
import { AcpModelControl } from '../src/model-control.ts'

/** Minimal LLM catalog/runtime double for pure standard-option tests. */
function llmRuntime(overrides: Partial<LlmRuntime> = {}): LlmRuntime {
  return {
    listProviders: () => [{ id: 'mock', name: 'Mock' }],
    listModels: () => Promise.resolve([{ provider: 'mock', id: 'mock', name: 'Mock' }]),
    resolveCallConfig: (selection: { provider?: string; model?: string; reasoningEffort?: string }) => Promise.resolve({
      provider: selection.provider ?? 'mock',
      model: selection.model ?? 'mock',
      ...selection.reasoningEffort === undefined
        ? { reasoningEffort: ReasoningEffortId('high') }
        : { reasoningEffort: ReasoningEffortId(selection.reasoningEffort) },
    }),
    resolveModelInfo: (provider: string, model: string) => Promise.resolve({
      provider,
      id: model,
      name: model,
      reasoning: {
        efforts: [
          { id: ReasoningEffortId('low'), name: 'Low', description: 'Less thought.' },
          { id: ReasoningEffortId('high'), name: 'High' },
        ],
        defaultEffort: ReasoningEffortId('high'),
      },
    }),
    ...overrides,
  } as unknown as LlmRuntime
}

async function createControl(runtime: LlmRuntime, initial?: ModelSelection) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  const session = ctx.sessions.create(SessionId('model-control'))
  const options = initial ?? {}
  const projection = await ctx.sessionProjections.register(modelSelectionProjectionDefinition)
  const model = new AgentModel(() => projection.stateOf(session), session, options)
  return { control: new AcpModelControl(runtime, model), session, model }
}

describe('ACP model configuration control', () => {
  it('represents an absent route and validates value types before mutation', async () => {
    const { control, session, model } = await createControl(llmRuntime())

    expect(model.current()).toBeUndefined()
    await expect(control.options()).resolves.toEqual([])
    await expect(control.set('model', false)).rejects.toThrow(/requires a select value/)
    await expect(control.set('model', 'missing')).rejects.toThrow(/no model selection/)

    session.append('model/selection', { provider: 'mock', model: 'mock' })
    expect(model.current()).toEqual({ provider: 'mock', model: 'mock' })
  })

  it('synthesizes an unlisted current route and exposes reasoning descriptions', async () => {
    const { control, model: agentModel } = await createControl(llmRuntime({ listProviders: () => [] }), {
      provider: 'private',
      model: 'unlisted',
    })

    const options = await control.options()

    const model = options.find(option => option.id === 'model')
    const reasoning = options.find(option => option.id === 'reasoning_effort')
    expect(model).toMatchObject({
      type: 'select',
      currentValue: '["private","unlisted"]',
      options: [{ group: 'private', name: 'private', options: [{ name: 'unlisted' }] }],
    })
    expect(reasoning).toMatchObject({
      type: 'select',
      currentValue: 'high',
      options: [{ name: 'Low', description: 'Less thought.' }, { name: 'High' }],
    })

    expect(agentModel.current()).toEqual({ provider: 'private', model: 'unlisted' })

  })

  it('keeps the selected route when its provider catalog is temporarily unavailable', async () => {
    const listModels = vi.fn(() => Promise.reject(new Error('catalog unavailable')))
    const { control } = await createControl(llmRuntime({ listModels }), { provider: 'mock', model: 'mock' })

    const options = await control.options()

    expect(listModels).toHaveBeenCalledWith('mock')
    expect(options[0]).toMatchObject({
      type: 'select',
      options: [{ group: 'mock', options: [{ name: 'mock' }] }],
    })
  })

  it('rejects an unadvertised reasoning effort and accepts a later valid change', async () => {
    const { control, session } = await createControl(llmRuntime(), { provider: 'mock', model: 'mock' })

    await expect(control.set('reasoning_effort', 'extreme')).rejects.toThrow(/unknown reasoning effort/)
    const options = await control.set('reasoning_effort', 'low')

    expect(options.find(option => option.id === 'reasoning_effort')).toMatchObject({ currentValue: 'low' })
    expect(session.snapshotEvents().map(event => ({ type: event.type, data: event.data }))).toEqual([{
      type: 'model/selection', data: { provider: 'mock', model: 'mock', reasoningEffort: 'low' },
    }])
  })

  it('exposes and restores a provider-owned reasoning default', async () => {
    const runtime = llmRuntime({
      resolveCallConfig: (selection: { provider?: string; model?: string; reasoningEffort?: string }) => Promise.resolve({
        provider: selection.provider ?? 'mock',
        model: selection.model ?? 'mock',
        ...selection.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: ReasoningEffortId(selection.reasoningEffort) },
      }),
      resolveModelInfo: (provider: string, model: string) => Promise.resolve({
        provider,
        id: model,
        name: model,
        reasoning: {
          efforts: [
            { id: ReasoningEffortId('low'), name: 'Low' },
            { id: ReasoningEffortId('high'), name: 'High' },
          ],
        },
      }),
    })
    const { control, model } = await createControl(runtime, { provider: 'mock', model: 'mock' })

    const initial = await control.options()
    expect(initial.find(option => option.id === 'reasoning_effort')).toMatchObject({
      currentValue: '',
      options: [{ value: '', name: 'Provider default' }, { value: 'low' }, { value: 'high' }],
    })
    await control.set('reasoning_effort', 'low')
    const restored = await control.set('reasoning_effort', '')

    expect(restored.find(option => option.id === 'reasoning_effort')).toMatchObject({ currentValue: '' })
    expect(model.current()).toEqual({ provider: 'mock', model: 'mock' })
  })
})
