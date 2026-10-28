import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import type { BundleInfo, ChangeResult } from '@deepseek-ai/dsh-plugin-manager/types'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as PluginRecommendations from '../src/index.ts'
import { ACTION, bundle, callId, fixture, logProposal, proposal, RESULT_TEXT } from './fixture.ts'

describe('official recommendations', () => {
  it('offers the live catalog through a skill, adds no tools of its own, and withdraws the skill and card kind on unload', async () => {
    const f = await fixture()
    const tools = () => f.ctx.tools.definitions().map(tool => tool.name).sort()
    const withPlugin = tools()
    const discovered = (await f.ctx.skills.list()).filter(skill => skill.name === 'official-plugins')
    expect(discovered).toMatchSnapshot('skill discovery')
    // The skill catalog cuts entries longer than its default 500 characters, which would drop the exclusions at the end.
    expect(discovered[0]!.description.length).toBeLessThanOrEqual(500)
    expect(f.manager.listBundles).not.toHaveBeenCalled()
    const noMeta = { ...bundle }
    delete noMeta.meta
    f.manager.listBundles.mockResolvedValue([
      bundle, { ...bundle, name: 'enabled', enabled: true },
      { ...noMeta, name: 'described', description: 'History search' }, { ...noMeta, name: 'bare' },
      { ...bundle, name: 'custom', official: false }, { ...bundle, name: 'missing', availability: 'missing' },
      { ...bundle, name: 'on-demand', optional: false }, { ...bundle, name: 'read-only', readOnlyReason: 'management-required' },
      { ...bundle, name: 'failed', error: { code: 'operation-error', diagnostic: 'load failed' } },
      { ...bundle, name: 'unsupported-shipped', listedByDefault: false, error: { code: 'unsupported-platform' } },
      { ...bundle, name: 'unsupported-installed', installed: true, error: { code: 'unsupported-platform' } },
      { ...bundle, name: 'unsupported-catalog', availability: 'missing', error: { code: 'unsupported-platform' } },
    ])
    const result = await executeToolFixture(f.ctx, { name: 'skill', arguments: { name: 'official-plugins' }, agent: f.agent,
      callId: ToolCallId('discovery'), signal: new AbortController().signal })
    expect(result.isError, JSON.stringify(result.content)).toBe(false)
    expect(result.value).toMatchSnapshot('skill policy and current catalog')
    const controller = new AbortController()
    f.manager.listBundles.mockImplementationOnce(async () => { controller.abort(); return [bundle] })
    await expect(f.ctx.skills.get('official-plugins', { signal: controller.signal })).rejects.toThrow()
    f.propose()
    await f.fiber.dispose()
    expect(tools()).toEqual(withPlugin)
    expect(f.ctx.get('pluginRecommendations')).toBeUndefined()
    expect((await f.ctx.skills.list()).some(skill => skill.name === 'official-plugins')).toBe(false)
    expect(await f.ctx.actionCards.act(f.agent, callId, 'enable')).toEqual({ status: 'refused', reason: 'unavailable' })
    expect(f.manager.setBundleEnabled).not.toHaveBeenCalled()
  })

  it('ends an accepted card call with the invitation to click Enable, and a refused call without it', async () => {
    const f = await fixture()
    const adapter = new MockAdapter([
      toolCallResponse('call-skill', 'skill', { name: 'official-plugins' }),
      toolCallResponse('call-card', 'propose_action', { action: ACTION, ...proposal }),
      toolCallResponse('call-again', 'propose_action', { action: ACTION, ...proposal }),
      textResponse('Search is one click away.'),
    ])
    f.ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await f.ctx.agentLoop.create(SessionId('invitation'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Can DSH search my old conversations?' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const results = agent.session.snapshotEvents().flatMap(event => event.type === 'tool/result' ? [event.data.message] : [])
    expect(results.map(message => message.isError === true)).toEqual([false, false, true])
    expect(results[1]?.content).toEqual([{ type: 'text', text: RESULT_TEXT }])
    expect(results[2]?.content).toEqual([{ type: 'text', text: 'Error: One card per turn; the earlier card stands.' }])
    expect(f.manager.setBundleEnabled).not.toHaveBeenCalled()
  })

  it('describes a logged card from the current catalog and refuses other cards and names outside it', async () => {
    const f = await fixture()
    expect(await f.ctx.pluginRecommendations.describe(f.agent, callId)).toEqual({ status: 'refused', reason: 'unknown' })
    f.propose()
    expect(await f.ctx.pluginRecommendations.describe(f.agent, callId)).toEqual({
      status: 'available', title: { en: 'Search', zh: '搜索' }, description: 'Search past conversations.', enabled: false,
    })
    const noMeta = { ...bundle }
    delete noMeta.meta
    f.manager.listBundles.mockResolvedValueOnce([{ ...noMeta, description: 'History search', enabled: true }])
    expect(await f.ctx.pluginRecommendations.describe(f.agent, callId)).toEqual({
      status: 'available', title: bundle.name, description: 'History search', enabled: true,
    })
    f.manager.listBundles.mockResolvedValueOnce([noMeta])
    expect(await f.ctx.pluginRecommendations.describe(f.agent, callId)).toMatchObject({ title: bundle.name, description: '' })
    for (const listed of [[], [{ ...bundle, official: false }]] satisfies BundleInfo[][]) {
      f.manager.listBundles.mockResolvedValueOnce(listed)
      expect(await f.ctx.pluginRecommendations.describe(f.agent, callId)).toEqual({ status: 'refused', reason: 'unavailable' })
    }
    // A card of another kind, and one whose details name no plugin, describe nothing.
    f.agent.session.append('turn/start', { turn: 2 })
    const page = logProposal(f.ctx, f.agent, 'call-page', { title: 'Counter', brief: 'Count.', details: { slot: 'page' } }, 'create_personalized_page')
    expect(await f.ctx.pluginRecommendations.describe(f.agent, page)).toEqual({ status: 'refused', reason: 'unknown' })
    f.agent.session.append('turn/start', { turn: 3 })
    const unnamed = f.propose('call-unnamed', { ...proposal, details: {} })
    expect(await f.ctx.pluginRecommendations.describe(f.agent, unnamed)).toEqual({ status: 'refused', reason: 'unknown' })
    expect(await f.ctx.actionCards.act(f.agent, unnamed, 'enable')).toEqual({ status: 'refused', reason: 'unavailable' })
    expect(await f.ctx.pluginRecommendations.describe(f.agent, ToolCallId('toString'))).toEqual({ status: 'refused', reason: 'unknown' })
    vi.spyOn(f.ctx.agents, 'roots').mockReturnValueOnce([])
    expect(await f.ctx.pluginRecommendations.describe(f.agent, callId)).toEqual({ status: 'refused', reason: 'not-live-root' })
    const service = f.ctx.pluginRecommendations
    await f.fiber.dispose()
    expect(await service.describe(f.agent, callId)).toEqual({ status: 'refused', reason: 'closing' })
  })

  it('records the enabled card once, never wakes the conversation, and keeps the decision in the Session', async () => {
    const f = await fixture()
    const steer = vi.spyOn(f.agent, 'steer')
    const followup = vi.spyOn(f.agent, 'followup')
    f.propose()
    const enabled = { callId, action: ACTION, phase: 'enabled' }
    expect(await f.ctx.actionCards.act(f.agent, callId, 'enable')).toEqual({ status: 'settled', decision: enabled })
    expect(await f.ctx.actionCards.act(f.agent, callId, 'enable')).toEqual({ status: 'settled', decision: enabled })
    expect(f.manager.setBundleEnabled).toHaveBeenCalledExactlyOnceWith(bundle.name, true)
    expect(steer).not.toHaveBeenCalled()
    expect(followup).not.toHaveBeenCalled()
    expect(f.card()).toEqual(enabled)
  })

  it.each([
    ['restart-required', { phase: 'enabled', data: { application: 'restart-required' } }, false],
    ['failed', { phase: 'failed' }, true],
  ] as const)('records the %s outcome and retries only failures', async (application, recorded, retried) => {
    const f = await fixture()
    f.propose()
    f.manager.setBundleEnabled.mockResolvedValue({ application, changed: false, stage: 'enable', target: bundle.name })
    expect(await f.ctx.actionCards.act(f.agent, callId, 'enable')).toEqual({ status: 'settled', decision: { callId, action: ACTION, ...recorded } })
    f.manager.setBundleEnabled.mockResolvedValue({ application: 'applied', changed: true, stage: 'enable', target: bundle.name })
    expect(await f.ctx.actionCards.act(f.agent, callId, 'enable')).toEqual({ status: 'settled',
      decision: retried ? { callId, action: ACTION, phase: 'enabled' } : { callId, action: ACTION, ...recorded } })
    expect(f.manager.setBundleEnabled).toHaveBeenCalledTimes(retried ? 2 : 1)
  })

  it('settles an already-enabled plugin without another profile change', async () => {
    const f = await fixture()
    f.propose()
    f.manager.listBundles.mockResolvedValue([{ ...bundle, enabled: true }])
    expect(await f.ctx.actionCards.act(f.agent, callId, 'enable')).toEqual({ status: 'settled',
      decision: { callId, action: ACTION, phase: 'already-enabled' } })
    expect(f.manager.setBundleEnabled).not.toHaveBeenCalled()
  })

  it('records the management error code without the diagnostic text', async () => {
    const f = await fixture()
    f.propose()
    f.manager.setBundleEnabled.mockResolvedValue({ application: 'failed', changed: false, stage: 'enable', target: bundle.name,
      error: { code: 'incompatible-version', diagnostic: '/private/profile/path' } })
    expect(await f.ctx.actionCards.act(f.agent, callId, 'enable')).toEqual({ status: 'settled',
      decision: { callId, action: ACTION, phase: 'failed', data: { errorCode: 'incompatible-version' } } })
    expect(JSON.stringify(f.events)).not.toContain('/private/profile/path')
  })

  it('records a rejected profile change as failed with a generic code and lets the user retry', async () => {
    const f = await fixture()
    f.propose()
    f.manager.setBundleEnabled.mockRejectedValueOnce(new Error('profile lock timed out'))
    expect(await f.ctx.actionCards.act(f.agent, callId, 'enable')).toEqual({ status: 'settled',
      decision: { callId, action: ACTION, phase: 'failed', data: { errorCode: 'operation-error' } } })
    expect(await f.ctx.actionCards.act(f.agent, callId, 'enable')).toEqual({ status: 'settled', decision: { callId, action: ACTION, phase: 'enabled' } })
    expect(f.manager.setBundleEnabled).toHaveBeenCalledTimes(2)
  })

  it.each(['plugin', 'plugin-reload', 'agent'] as const)('does not start enabling after the %s leaves during catalog lookup', async (target) => {
    const f = await fixture()
    f.propose()
    const entered = Promise.withResolvers<undefined>()
    const gate = Promise.withResolvers<BundleInfo[]>()
    onTestFinished(() => { gate.resolve([bundle]) })
    f.manager.listBundles.mockImplementationOnce(() => { entered.resolve(undefined); return gate.promise })
    const action = f.ctx.actionCards.act(f.agent, callId, 'enable')
    await entered.promise
    const disposal = target === 'agent' ? f.handle.dispose()
      : target === 'plugin' ? f.fiber.dispose() : f.fiber.restart()
    if (target === 'agent') await disposal
    gate.resolve([bundle])
    expect(await action).toEqual({ status: 'refused', reason: target === 'agent' ? 'not-live-root' : 'closing' })
    await disposal
    expect(f.manager.setBundleEnabled).not.toHaveBeenCalled()
  })

  it('dismisses durably, rejects unknown cards, and rechecks catalog eligibility before enabling', async () => {
    const f = await fixture()
    expect(await f.ctx.actionCards.act(f.agent, callId, 'enable')).toEqual({ status: 'refused', reason: 'unknown' })
    f.propose()
    f.manager.listBundles.mockResolvedValue([])
    expect(await f.ctx.actionCards.act(f.agent, callId, 'enable')).toEqual({ status: 'refused', reason: 'unavailable' })
    f.manager.listBundles.mockResolvedValue([{ ...bundle, optional: false }])
    expect(await f.ctx.actionCards.act(f.agent, callId, 'enable')).toEqual({ status: 'refused', reason: 'unavailable' })
    const dismissed = { callId, action: ACTION, phase: 'dismissed' }
    expect(await f.ctx.actionCards.act(f.agent, callId, 'dismiss')).toEqual({ status: 'settled', decision: dismissed })
    expect(await f.ctx.actionCards.act(f.agent, callId, 'enable')).toEqual({ status: 'settled', decision: dismissed })
    expect(f.manager.setBundleEnabled).not.toHaveBeenCalled()
  })

  it('leaves a replaced card unenabled', async () => {
    const f = await fixture()
    const first = f.propose('call-first')
    f.agent.session.append('turn/start', { turn: 2 })
    f.propose('call-second')
    expect(await f.ctx.actionCards.act(f.agent, first, 'enable')).toEqual({ status: 'settled', decision: { callId: first, action: ACTION, phase: 'replaced' } })
    expect(f.manager.setBundleEnabled).not.toHaveBeenCalled()
  })

  it('allows dismissal without global profile access but refuses enabling', async () => {
    const f = await fixture()
    f.propose()
    vi.spyOn(f.ctx.remoteAccess, 'allows').mockReturnValue(false)
    expect(await f.ctx.actionCards.act(f.agent, callId, 'enable')).toEqual({ status: 'refused', reason: 'access-denied' })
    expect(await f.ctx.actionCards.act(f.agent, callId, 'dismiss')).toMatchObject({ status: 'settled', decision: { phase: 'dismissed' } })
    expect(f.manager.setBundleEnabled).not.toHaveBeenCalled()
  })

  it('refuses a click whose root leaves while the catalog is read', async () => {
    const f = await fixture()
    f.propose()
    const roots = f.ctx.agents.roots()
    vi.spyOn(f.ctx.agents, 'roots').mockReturnValueOnce(roots).mockReturnValue([])
    expect(await f.ctx.actionCards.act(f.agent, callId, 'enable')).toEqual({ status: 'refused', reason: 'not-live-root' })
    expect(f.manager.setBundleEnabled).not.toHaveBeenCalled()
  })

  it('coalesces actions and releases local work when HMR must unload this plugin before applying', async () => {
    const f = await fixture()
    f.propose()
    const gate = Promise.withResolvers<ChangeResult>()
    onTestFinished(() => { gate.resolve({ application: 'applied', changed: true, stage: 'enable', target: bundle.name }) })
    const entered = Promise.withResolvers<undefined>()
    f.manager.setBundleEnabled.mockImplementation(() => { entered.resolve(undefined); return gate.promise })
    const first = f.ctx.actionCards.act(f.agent, callId, 'enable')
    await entered.promise
    const second = f.ctx.actionCards.act(f.agent, callId, 'dismiss')
    await f.fiber.dispose()
    expect(await first).toEqual({ status: 'unconfirmed', reason: 'closing' })
    expect(await second).toEqual(await first)
    // The lost outcome stays on the card, retryable.
    expect(f.card()).toEqual({ callId, action: ACTION, phase: 'unconfirmed' })
    const before = f.events.length
    gate.resolve({ application: 'applied', changed: true, stage: 'enable', target: bundle.name })
    await gate.promise
    expect(f.events).toHaveLength(before)
    expect(f.manager.setBundleEnabled).toHaveBeenCalledOnce()
    expect(await f.ctx.actionCards.act(f.agent, callId, 'enable')).toEqual({ status: 'refused', reason: 'unavailable' })
    // Reloaded, a retry that finds the plugin on records this card's own change, not one made elsewhere.
    await f.ctx.plugin(PluginRecommendations)
    f.manager.listBundles.mockResolvedValue([{ ...bundle, enabled: true }])
    expect(await f.ctx.actionCards.act(f.agent, callId, 'enable')).toEqual({ status: 'settled', decision: { callId, action: ACTION, phase: 'enabled' } })
    expect(f.manager.setBundleEnabled).toHaveBeenCalledOnce()
  })

  it('retries an unconfirmed enable that did not land', async () => {
    const f = await fixture()
    f.propose()
    f.ctx.actionCards.record(f.agent, { callId, action: ACTION, phase: 'unconfirmed' })
    expect(await f.ctx.actionCards.act(f.agent, callId, 'enable')).toEqual({ status: 'settled', decision: { callId, action: ACTION, phase: 'enabled' } })
    expect(f.manager.setBundleEnabled).toHaveBeenCalledOnce()
  })

  it('settles Not now on an unconfirmed card as enabled when its interrupted enable has landed', async () => {
    const f = await fixture()
    f.propose()
    f.ctx.actionCards.record(f.agent, { callId, action: ACTION, phase: 'unconfirmed' })
    f.manager.listBundles.mockResolvedValue([{ ...bundle, enabled: true }])
    const enabled = { callId, action: ACTION, phase: 'enabled' }
    expect(await f.ctx.actionCards.act(f.agent, callId, 'dismiss')).toEqual({ status: 'settled', decision: enabled })
    expect(f.card()).toEqual(enabled)
    expect(f.manager.setBundleEnabled).not.toHaveBeenCalled()
  })

  it('records enabled when an unconfirmed enable lands between the profile check and the retry', async () => {
    const f = await fixture()
    f.propose()
    f.ctx.actionCards.record(f.agent, { callId, action: ACTION, phase: 'unconfirmed' })
    f.manager.listBundles.mockResolvedValueOnce([bundle]).mockResolvedValue([{ ...bundle, enabled: true }])
    expect(await f.ctx.actionCards.act(f.agent, callId, 'enable')).toEqual({ status: 'settled', decision: { callId, action: ACTION, phase: 'enabled' } })
    expect(f.manager.setBundleEnabled).not.toHaveBeenCalled()
  })

  it('dismisses an unconfirmed card', async () => {
    const f = await fixture()
    f.propose()
    f.ctx.actionCards.record(f.agent, { callId, action: ACTION, phase: 'unconfirmed' })
    expect(await f.ctx.actionCards.act(f.agent, callId, 'dismiss')).toMatchObject({ status: 'settled', decision: { phase: 'dismissed' } })
  })
})
