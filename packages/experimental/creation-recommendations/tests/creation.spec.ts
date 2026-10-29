import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { appendPluginRecord, SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ChangeResult } from '@deepseek-ai/dsh-plugin-manager/types'
import * as CreationRecommendations from '../src/index.ts'
import { ACTION, fixture, callId, proposal, installedBundle, recordCard, writeBundle } from './fixture.ts'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'

/** The Remote result for a recorded page decision. */
function settled(phase: string, data: object) {
  return { status: 'settled', decision: { callId, action: ACTION, phase, data } }
}

describe('interface creation', () => {
  it('loads page planning with a live duplicate-check catalog and withdraws the skill and card kind on unload', async () => {
    const f = await fixture()
    f.bundles.push(
      { ...installedBundle('enabled'), official: true, meta: { title: 'Existing view', description: 'Inspect current work' } },
      { ...installedBundle('disabled'), official: true, enabled: false, description: 'Optional view' },
      { ...installedBundle('empty'), official: true },
      { ...installedBundle('localized'), official: true, meta: { title: { en: 'Counter', zh: '计数器' }, description: { en: 'Count tasks', zh: '统计任务' } } },
      installedBundle('third-party'),
    )
    expect(f.ctx.tools.get('plugin_manager')).toBeUndefined()
    expect(await f.ctx.skills.list()).toMatchSnapshot('skill discovery')
    expect(f.manager.listBundles).not.toHaveBeenCalled()
    const result = await executeToolFixture(f.ctx, { name: 'skill', arguments: { name: 'personalized-pages' }, agent: f.agent,
      callId: ToolCallId('discovery'), signal: new AbortController().signal })
    expect(result.isError, JSON.stringify(result.content)).toBe(false)
    expect(result.value).toMatchSnapshot('skill policy and current catalog')
    f.bundles[0] = { ...f.bundles[0]!, enabled: false }
    const changed = await f.ctx.skills.get('personalized-pages')
    expect(changed?.content).toContain('"name":"enabled","title":"Existing view","description":"Inspect current work","enabled":false')
    const controller = new AbortController()
    f.manager.listBundles.mockImplementationOnce(async () => { controller.abort(); return f.bundles })
    await expect(f.ctx.skills.get('personalized-pages', { signal: controller.signal })).rejects.toThrow()
    expect(f.manager.installBundle).not.toHaveBeenCalled()
    expect(f.startActivation).not.toHaveBeenCalled()
    await f.propose()
    await f.fiber.dispose()
    expect(await f.ctx.skills.list()).toEqual([])
    expect(await f.act('create')).toEqual({ status: 'refused', reason: 'unavailable' })
  })

  it('requires a logged proposal and explicit user creation, then reuses Creator with the chosen location', async () => {
    const f = await fixture()
    expect(await f.act('create')).toEqual({ status: 'refused', reason: 'unknown' })
    await f.propose()
    expect(f.startActivation).not.toHaveBeenCalled()
    expect(await f.act('keep')).toEqual({ status: 'refused', reason: 'unavailable' })
    expect(await f.act('create')).toEqual({ status: 'accepted' })
    expect(await f.act('create')).toEqual({ status: 'accepted' })
    const spec = await f.complete()
    expect(spec).toMatchObject({ provider: 'spawn', delivery: 'caller', request: { agentPreset: 'cordis' } })
    expect(spec.request.parent).toBe(f.agent)
    const guide = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-creation-recommendations/references/session-tab.md'))
    expect(spec.request.prompt.find(block => block.type === 'text')?.text).toContain(JSON.stringify(guide))
    expect(await readFile(guide, 'utf8')).toContain('conversation.view')
    expect(spec.request.cwd!.startsWith(join(f.agent.session.header.cwd!, '.dsh-created-plugins'))).toBe(true)
    expect(f.manager.installBundle).toHaveBeenCalledOnce()
    const installedDirectory = f.manager.installBundle.mock.calls[0]![0]
    expect(spec.request.cwd).not.toBe(installedDirectory)
    await rm(spec.request.cwd!, { recursive: true })
    expect(JSON.parse(await readFile(join(installedDirectory, 'package.json'), 'utf8'))).toMatchObject({ name: f.current()?.bundleName })
    expect(JSON.stringify(f.current())).not.toContain(f.directory)
    expect(f.current()).toMatchObject({ phase: 'installed', slot: 'page', application: 'applied' })
    expect(f.dispose).toHaveBeenCalledOnce()
    await f.fiber.dispose()
    expect(f.manager.removeBundle).not.toHaveBeenCalled()
    await f.ctx.plugin(CreationRecommendations)
    expect(f.current()?.phase).toBe('installed')
    expect((await f.act('create')).status).toBe('settled')
    await f.act('keep')
    expect(f.current()?.phase).toBe('kept')
    expect(f.manager.removeBundle).not.toHaveBeenCalled()
    await f.act('undo')
    expect(f.manager.removeBundle).toHaveBeenCalledExactlyOnceWith(f.current()?.bundleName)
    expect(f.current()?.phase).toBe('removed')
    await f.act('undo')
    expect(f.manager.removeBundle).toHaveBeenCalledOnce()
  })

  it('passes the user-selected left entry to Creator with only its location reference', async () => {
    const f = await fixture()
    await f.propose()
    await f.act('create', 'sidebar-left')
    const spec = await f.complete()
    const instructions: unknown = JSON.parse(spec.request.prompt.find(block => block.type === 'text')!.text)
    expect(instructions).toMatchObject({ location: 'sidebar-left', uiReference: fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-creation-recommendations/references/sidebar-entry.md')),
      locationPolicy: 'location and uiReference are the user’s final choice in the card. They override any earlier location described in brief; preserve the requested behavior and data scope while adapting the interface to this chosen location.',
    })
    expect(f.current()).toMatchObject({ phase: 'installed', slot: 'sidebar-left' })
    const source = await readFile(join(spec.request.cwd!, 'package.json'), 'utf8')
    await f.act('undo')
    expect(f.current()?.phase).toBe('removed')
    expect(await readFile(join(spec.request.cwd!, 'package.json'), 'utf8')).toBe(source)
  })

  it('retains actual task content separately from the short plan and hands it to Creator after reload', async () => {
    const f = await fixture()
    const initialContent = '| 项目 | 负责人 | 状态 |\n| A | 小李 | 未开始 |\n| B | 小王 | 进行中 |\n| C | 小陈 | 已完成 |'
    await f.propose('call-creation-1', { ...proposal, details: { ...proposal.details, initialContent } })
    expect(f.startActivation).not.toHaveBeenCalled()
    await f.fiber.dispose()
    await f.ctx.plugin(CreationRecommendations)
    await f.act('create', 'sidebar-left')
    const spec = await f.complete()
    const prompt: unknown = JSON.parse(spec.request.prompt.find(block => block.type === 'text')!.text)
    expect(prompt).toMatchObject({ brief: proposal.brief, initialContent, location: 'sidebar-left' })
    const stringMatcher: unknown = expect.any(String)
    expect(prompt).toMatchSnapshot({
      directory: stringMatcher,
      packageName: stringMatcher,
      uiReference: stringMatcher,
    }, 'Creator handoff after reload')
    expect(f.startActivation).toHaveBeenCalledOnce()
  })

  it('uses the profile workspace when an accepted Session has no recorded working directory', async () => {
    const f = await fixture()
    const handle = await f.ctx.agents.create({ sessionId: SessionId('without-cwd') })
    await f.propose('call-creation-1', proposal, handle.agent)
    await f.act('create', 'sidebar-right', undefined, handle.agent)
    const spec = await f.entered.promise
    expect(spec.request.cwd!.startsWith(join(f.ctx.profileContext.cwd, '.dsh-created-plugins'))).toBe(true)
    await f.act('cancel', 'sidebar-right', undefined, handle.agent)
    expect(f.manager.installBundle).not.toHaveBeenCalled()
  })

  it('persists a written placement and gives Creator the human request with the existing location references', async () => {
    const f = await fixture()
    await f.propose()
    for (const invalid of ['', '  ', 'x'.repeat(1001)]) {
      expect(await f.act('create', 'page', invalid)).toEqual({ status: 'refused', reason: 'invalid-location' })
    }
    expect(await f.ctx.actionCards.act(f.agent, callId, 'create')).toEqual({ status: 'refused', reason: 'invalid-location' })
    expect(f.startActivation).not.toHaveBeenCalled()
    await f.act('create', 'page', '  左侧入口打开全屏日历  ')
    const spec = await f.complete()
    const instructions: unknown = JSON.parse(spec.request.prompt.find(block => block.type === 'text')!.text)
    const references = ['sidebar-right.md', 'session-tab.md', 'sidebar-entry.md'].map(file =>
      fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-creation-recommendations/references/' + file)))
    expect(instructions).toMatchObject({ location: { request: '左侧入口打开全屏日历' }, uiReferences: references })
    expect(instructions).toHaveProperty('locationPolicy', expect.stringContaining('instead of silently substituting another location'))
    expect(instructions).not.toHaveProperty('uiReference')
    for (const reference of references) expect(await readFile(reference, 'utf8')).toMatch(/^# /)
    expect(f.current()).toMatchObject({ phase: 'installed', customLocation: '左侧入口打开全屏日历' })
    recordCard(f.agent.session, { ...f.current()!, phase: 'interrupted' })
    await f.fiber.dispose()
    await f.ctx.plugin(CreationRecommendations)
    expect(f.current()?.customLocation).toBe('左侧入口打开全屏日历')
    await f.act('undo')
    expect(f.current()).toMatchObject({ phase: 'removed', customLocation: '左侧入口打开全屏日历' })
  })

  it.each(['', '右侧查看当前会话'])('allows dismissing a custom location without creation: %s', async (customLocation) => {
    const f = await fixture()
    await f.propose()
    expect((await f.act('dismiss', 'page', customLocation)).status).toBe('settled')
    expect(f.current()?.phase).toBe('dismissed')
    expect(f.current()?.customLocation).toBe(customLocation === '' ? undefined : customLocation)
    expect(f.startActivation).not.toHaveBeenCalled()
  })

  it('cancels generation, drains its child, preserves source and permits a fresh retry', async () => {
    const f = await fixture()
    await f.propose()
    expect(await f.act('cancel')).toEqual({ status: 'refused', reason: 'unavailable' })
    await f.act('create')
    const spec = await f.entered.promise
    const firstName = f.current()!.bundleName!
    await writeBundle(spec.request.cwd!, firstName)
    const cleanup = Promise.withResolvers<undefined>()
    onTestFinished(() => { cleanup.resolve(undefined) })
    f.dispose.mockImplementation(async () => { f.result.resolve({ output: [], stopReason: 'aborted' }); await cleanup.promise })
    const access = vi.spyOn(f.ctx.remoteAccess, 'allows').mockReturnValue(false)
    const cancelling = f.act('cancel')
    await vi.waitFor(() => { expect(spec.signal.aborted).toBe(true) })
    access.mockRestore()
    expect(f.act('create')).toBe(cancelling)
    expect(f.current()?.phase).toBe('creating')
    expect(f.manager.installBundle).not.toHaveBeenCalled()
    cleanup.resolve(undefined)
    expect(await cancelling).toEqual({ status: 'accepted' })
    expect(f.current()?.phase).toBe('cancelled')
    expect(await readFile(join(spec.request.cwd!, 'package.json'), 'utf8')).toContain(firstName)
    expect((await f.act('cancel')).status).toBe('settled')
    f.startActivation.mockImplementationOnce(async (retry) => {
      await writeBundle(retry.request.cwd!, f.current()!.bundleName!)
      return { childId: retry.childId!, result: Promise.resolve({ output: [], stopReason: 'completed', structured: { ready: true } }),
        dispose: vi.fn(async () => {}) }
    })
    await f.act('create')
    await vi.waitFor(() => { expect(f.current()?.phase).toBe('installed') })
    expect(f.current()?.bundleName).not.toBe(firstName)
    expect(f.startActivation).toHaveBeenCalledTimes(2)
    expect(f.manager.installBundle).toHaveBeenCalledOnce()
  })

  it('finishes an accepted installation when cancellation arrives too late', async () => {
    const f = await fixture()
    await f.propose()
    const installing = Promise.withResolvers<undefined>()
    const gate = Promise.withResolvers<ChangeResult>()
    onTestFinished(() => { gate.resolve({ application: 'failed', changed: false, stage: 'install', target: 'fixture' }) })
    f.manager.installBundle.mockImplementation(() => { installing.resolve(undefined); return gate.promise })
    await f.act('create')
    const spec = await f.entered.promise
    const name = f.current()!.bundleName!
    await writeBundle(spec.request.cwd!, name)
    f.result.resolve({ output: [], stopReason: 'completed', structured: { ready: true } })
    await installing.promise
    expect(f.current()?.phase).toBe('installing')
    expect(await f.act('cancel')).toEqual({ status: 'accepted' })
    expect(spec.signal.aborted).toBe(false)
    f.bundles.push(installedBundle(name))
    gate.resolve({ application: 'applied', changed: true, stage: 'install', target: name })
    await vi.waitFor(() => { expect(f.current()?.phase).toBe('installed') })
    expect(f.manager.removeBundle).not.toHaveBeenCalled()
  })

  it('coalesces rapid clicks without creating twice, and dismisses durably', async () => {
    const f = await fixture()
    await f.propose()
    const one = f.act('dismiss')
    const two = f.act('create')
    expect(two).toBe(one)
    expect(await one).toEqual(settled('dismissed', { slot: 'page' }))
    await f.act('create')
    expect(f.startActivation).not.toHaveBeenCalled()
  })

  it('refuses clicks from non-root or unauthorized connections', async () => {
    const f = await fixture()
    await f.propose()
    const roots = vi.spyOn(f.ctx.agents, 'roots').mockReturnValue([])
    expect(await f.act('create')).toEqual({ status: 'refused', reason: 'not-live-root' })
    roots.mockRestore()
    vi.spyOn(f.ctx.remoteAccess, 'allows').mockReturnValue(false)
    expect(await f.act('create')).toEqual({ status: 'refused', reason: 'access-denied' })
    expect(await f.act('restore')).toEqual({ status: 'refused', reason: 'access-denied' })
    expect(f.startActivation).not.toHaveBeenCalled()
  })

  it('returns a typed invalid-location refusal and falls back for invalid dismissal locations', async () => {
    const f = await fixture()
    await f.propose()
    expect(await f.act('create', 'unknown-location')).toEqual({ status: 'refused', reason: 'invalid-location' })
    vi.spyOn(f.ctx.remoteAccess, 'allows').mockReturnValue(false)
    expect(await f.act('dismiss', 'unknown-location', '   ')).toEqual(settled('dismissed', { slot: proposal.details.slot }))
    expect(f.startActivation).not.toHaveBeenCalled()
  })

  it('keeps a Session usable when profile recovery fails, and checks again before any retry', async () => {
    const f = await fixture({ callId, phase: 'creating', slot: 'page', bundleName: '@dsh-local/recover' })
    await f.propose()
    recordCard(f.agent.session, { callId: ToolCallId('other-kept'), phase: 'kept', slot: 'page', bundleName: '@dsh-local/kept' })
    await f.fiber.dispose()
    f.manager.listBundles.mockRejectedValue(new Error('profile read failed'))
    await f.ctx.plugin(CreationRecommendations)
    expect(f.current()?.phase).toBe('unconfirmed')
    expect(await f.act('create')).toEqual({ status: 'refused', reason: 'unavailable' })
    expect(f.startActivation).not.toHaveBeenCalled()
    f.manager.listBundles.mockResolvedValue([installedBundle('@dsh-local/recover')])
    expect((await f.act('create')).status).toBe('settled')
    expect(f.current()?.phase).toBe('installed')
  })

  it('keeps unsuccessful uninstall outcomes visible and permits retry only for the owned bundle', async () => {
    const f = await fixture()
    await f.propose()
    await f.act('create')
    await f.complete()
    const owned = f.current()!.bundleName!
    f.manager.removeBundle.mockResolvedValueOnce({ application: 'restart-required', changed: true, stage: 'remove', target: owned })
    await f.act('undo')
    expect(f.current()).toMatchObject({ phase: 'installed', application: 'restart-required' })
    await f.act('undo')
    expect(f.current()?.phase).toBe('removed')
  })

  it('settles an already removed plugin without another removal and refuses incomplete old receipts', async () => {
    const f = await fixture()
    await f.propose()
    recordCard(f.agent.session, { callId, phase: 'installed', slot: 'page' })
    expect(await f.act('undo')).toEqual({ status: 'refused', reason: 'unavailable' })
    recordCard(f.agent.session, { callId, phase: 'installed', slot: 'page', bundleName: '@dsh-local/removed' })
    await f.act('undo')
    expect(f.current()?.phase).toBe('removed')
    expect(f.manager.removeBundle).not.toHaveBeenCalled()
  })

  it('ignores page receipts whose data no longer validates and decisions of other kinds', async () => {
    const f = await fixture()
    await f.propose()
    const other = { callId: ToolCallId('other-card'), action: 'other_action', phase: 'creating', data: { slot: 'page', bundleName: '@dsh-local/other' } }
    appendPluginRecord(f.agent.session, 'plugin:action-cards/decision', other)
    f.ctx.actionCards.record(f.agent, { callId, action: ACTION, phase: 'installed', data: { slot: 'elsewhere' } })
    expect(await f.act('keep')).toEqual({ status: 'refused', reason: 'unavailable' })
    f.ctx.actionCards.record(f.agent, { callId, action: ACTION, phase: 'installed' })
    expect(await f.act('create')).toEqual({ status: 'accepted' })
    expect(f.ctx.actionCards.view(f.agent.session).decisions['other-card']).toEqual(other)
  })

  it.each(['error', 'completed'] as const)('does not install an incomplete %s Creator result', async (stopReason) => {
    const f = await fixture()
    await f.propose()
    await f.act('create')
    await f.entered.promise
    f.result.resolve({ output: [], stopReason, structured: { ready: false } })
    await vi.waitFor(() => { expect(f.current()?.phase).toBe('failed') })
    expect(f.manager.installBundle).not.toHaveBeenCalled()
  })

  it('does not install generated files when Creator ends without a completion receipt', async () => {
    const f = await fixture()
    await f.propose()
    await f.act('create')
    const spec = await f.entered.promise
    await writeBundle(spec.request.cwd!, f.current()!.bundleName!)
    f.result.resolve({ output: [], stopReason: 'completed' })
    await vi.waitFor(() => { expect(f.current()?.phase).toBe('failed') })
    expect(f.manager.installBundle).not.toHaveBeenCalled()
    expect(f.dispose).toHaveBeenCalledOnce()
  })

  it('reconciles an unconfirmed card before Not now, so its installed page keeps Undo', async () => {
    const f = await fixture({ callId, phase: 'creating', slot: 'page', bundleName: '@dsh-local/view-recover' })
    await f.propose()
    await f.fiber.dispose()
    f.manager.listBundles.mockRejectedValue(new Error('profile read failed'))
    await f.ctx.plugin(CreationRecommendations)
    expect(f.current()?.phase).toBe('unconfirmed')
    expect(await f.act('dismiss')).toEqual({ status: 'refused', reason: 'unavailable' })
    expect(f.current()?.phase).toBe('unconfirmed')
    f.manager.listBundles.mockResolvedValue([installedBundle('@dsh-local/view-recover')])
    expect(await f.act('dismiss')).toEqual(settled('installed', { slot: 'page', bundleName: '@dsh-local/view-recover' }))
    expect(await f.act('undo')).toEqual(settled('removed', { slot: 'page', bundleName: '@dsh-local/view-recover', application: 'applied' }))
    expect(f.manager.removeBundle).toHaveBeenCalledWith('@dsh-local/view-recover')
  })

  it('reconciles an interrupted receipt with the installed profile before retrying', async () => {
    const f = await fixture()
    await f.propose()
    recordCard(f.agent.session, { callId, phase: 'interrupted', slot: 'page', bundleName: '@dsh-local/recovered' })
    f.bundles.push(installedBundle('@dsh-local/recovered'))
    expect((await f.act('create')).status).toBe('settled')
    expect(f.current()?.phase).toBe('installed')
    expect(f.current()?.application).toBeUndefined()
    expect(f.startActivation).not.toHaveBeenCalled()
  })

  it('recovers a lost creation as interrupted and retains installation errors', async () => {
    const f = await fixture({ callId, phase: 'creating', slot: 'page', bundleName: '@dsh-local/recovered' })
    expect(f.current()?.phase).toBe('interrupted')
    f.bundles.push({ ...installedBundle('@dsh-local/recovered'), enabled: false })
    await f.fiber.dispose()
    await f.ctx.plugin(CreationRecommendations)
    expect(f.current()).toMatchObject({ phase: 'installed', application: 'failed' })
  })

  it('aborts owned children on unload and waits for their cleanup without uninstalling anything', async () => {
    const f = await fixture()
    await f.propose()
    await f.act('create')
    const spec = await f.entered.promise
    await f.fiber.dispose()
    expect(spec.signal.aborted).toBe(true)
    expect(f.dispose).toHaveBeenCalledOnce()
    expect(f.current()?.phase).toBe('interrupted')
    expect(f.manager.installBundle).not.toHaveBeenCalled()
    expect(f.manager.removeBundle).not.toHaveBeenCalled()
    expect(await f.act('create')).toEqual({ status: 'refused', reason: 'unavailable' })
  })

  it('blocks Creator profile mutations while leaving reads and unrelated agents usable', async () => {
    const f = await fixture()
    await f.propose()
    await f.act('create')
    const spec = await f.entered.promise
    const child = await f.harness.create(spec.childId!)
    f.ctx.tools.register(defineTool({ name: 'plugin_manager', description: 'fixture', parameters: { action: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: async () => 'done' }))
    const run = (action: string, agent = child) => executeToolFixture(f.ctx, { name: 'plugin_manager', arguments: { action },
      callId: ToolCallId('manager'), agent, signal: new AbortController().signal })
    expect((await run('install')).isError).toBe(true)
    expect((await run('list_bundles')).isError).toBe(false)
    expect((await run('install', f.agent)).isError).toBe(false)
    const unrelated = await f.harness.create(SessionId('other-root'))
    expect((await run('install', unrelated)).isError).toBe(false)
    const helper = await f.ctx.agents.create({ sessionId: SessionId('creator-helper'), parentAgent: child,
      meta: { parentSession: child.id, origin: 'subagent' } })
    const nested = await f.ctx.agents.create({ sessionId: SessionId('creator-nested'), parentAgent: helper.agent,
      meta: { parentSession: helper.agent.id, origin: 'subagent' } })
    for (const owned of [helper.agent, nested.agent]) {
      expect((await run('install', owned)).isError).toBe(true)
      expect((await run('list_bundles', owned)).isError).toBe(false)
    }
    // Session lineage alone is not runtime ownership.
    const lineage = await f.ctx.agents.create({ sessionId: SessionId('creator-lineage'), meta: { parentSession: child.id } })
    expect((await run('install', lineage.agent)).isError).toBe(false)
  })

  it('refuses to start a Creator while the Session is read-only and keeps dismissal available', async () => {
    const f = await fixture()
    await f.propose()
    const resolve = vi.fn(() => ({ mode: 'read-only', workspaceRoot: f.directory }))
    f.ctx.provide('sandboxPolicy', { resolve })
    expect(await f.act('create')).toEqual({ status: 'refused', reason: 'read-only' })
    expect(resolve).toHaveBeenCalledWith({ session: f.agent.session })
    expect(f.current()).toBeUndefined()
    expect(f.startActivation).not.toHaveBeenCalled()
    resolve.mockReturnValue({ mode: 'workspace-write', workspaceRoot: f.directory })
    expect(await f.act('create')).toEqual({ status: 'accepted' })
    expect(f.current()?.phase).toBe('creating')
  })

  it('releases installation follow-up when HMR unloads the creator and recovers its eventual result', async () => {
    const f = await fixture()
    await f.propose()
    const gate = Promise.withResolvers<ChangeResult>()
    onTestFinished(() => { gate.resolve({ application: 'failed', changed: false, stage: 'install', target: 'fixture' }) })
    const installing = Promise.withResolvers<undefined>()
    f.manager.installBundle.mockImplementation(() => { installing.resolve(undefined); return gate.promise })
    await f.act('create')
    const spec = await f.entered.promise
    await writeBundle(spec.request.cwd!, f.current()!.bundleName!)
    f.result.resolve({ output: [], stopReason: 'completed', structured: { ready: true } })
    await installing.promise
    await f.fiber.dispose()
    f.bundles.push(installedBundle(f.current()!.bundleName!))
    gate.resolve({ application: 'applied', changed: true, stage: 'install', target: 'fixture' })
    await gate.promise
    await f.ctx.plugin(CreationRecommendations)
    expect(f.current()?.phase).toBe('installed')
    expect(f.manager.removeBundle).not.toHaveBeenCalled()
  })

  it('does not start after the owner stops or the root disappears during receipt recovery', async () => {
    for (const target of ['plugin', 'agent'] as const) {
      const f = await fixture({ callId, phase: 'failed', slot: 'page', bundleName: '@dsh-local/failed' })
      await f.propose()
      const entered = Promise.withResolvers<undefined>()
      const gate = Promise.withResolvers<ReturnType<typeof f.manager.listBundles> extends Promise<infer T> ? T : never>()
      f.manager.listBundles.mockImplementationOnce(() => { entered.resolve(undefined); return gate.promise })
      const creating = f.act('create')
      await entered.promise
      const disposing = target === 'plugin' ? f.fiber.dispose() : f.agentHandle.dispose()
      if (target === 'agent') await disposing
      gate.resolve([])
      expect(await creating).toEqual({ status: 'refused', reason: target === 'plugin' ? 'closing' : 'not-live-root' })
      await disposing
      expect(f.startActivation).not.toHaveBeenCalled()
    }
  })

  it('aborts only the parent-owned job when an agent leaves, including a late activation', async () => {
    const f = await fixture()
    await f.propose()
    const gate = Promise.withResolvers<undefined>()
    const original = f.startActivation.getMockImplementation()!
    f.startActivation.mockImplementation(async (spec) => { const value = await original(spec); await gate.promise; return value })
    await f.act('create')
    const spec = await f.entered.promise
    const unrelated = await f.ctx.agents.create({ sessionId: SessionId('unrelated') })
    await unrelated.dispose()
    expect(spec.signal.aborted).toBe(false)
    await f.agentHandle.dispose()
    expect(spec.signal.aborted).toBe(true)
    gate.resolve(undefined)
    await f.fiber.dispose()
    expect(f.current()?.phase).toBe('interrupted')
    expect(f.dispose).toHaveBeenCalledOnce()
    expect(f.manager.installBundle).not.toHaveBeenCalled()
  })

  it('reports cleanup failure without leaving a live child or installing its files', async () => {
    const f = await fixture()
    await f.propose()
    await f.act('create')
    await f.entered.promise
    f.dispose.mockImplementation(async () => { f.result.resolve({ output: [], stopReason: 'aborted' }); throw new Error('cleanup failure') })
    await f.fiber.dispose()
    expect(f.current()?.phase).toBe('interrupted')
    expect(f.manager.installBundle).not.toHaveBeenCalled()
  })

  it('rejects a conflicting reserved name and reports an install that added no bundle', async () => {
    for (const collision of [true, false]) {
      const f = await fixture()
      await f.propose()
      await f.act('create')
      const spec = await f.entered.promise
      const name = f.current()!.bundleName!
      await writeBundle(spec.request.cwd!, name)
      if (collision) f.bundles.push(installedBundle(name))
      else f.manager.installBundle.mockResolvedValueOnce({ application: 'failed', changed: false, stage: 'install', target: name })
      f.result.resolve({ output: [], stopReason: 'completed', structured: { ready: true } })
      await vi.waitFor(() => { expect(f.current()?.phase).toBe('failed') })
      expect(f.manager.installBundle).toHaveBeenCalledTimes(collision ? 0 : 1)
    }
  })

  it('retains a late installed plugin after the parent disappears during installation', async () => {
    const f = await fixture()
    await f.propose()
    const installing = Promise.withResolvers<undefined>()
    const gate = Promise.withResolvers<ChangeResult>()
    f.manager.installBundle.mockImplementation(() => { installing.resolve(undefined); return gate.promise })
    await f.act('create')
    const spec = await f.entered.promise
    const name = f.current()!.bundleName!
    await writeBundle(spec.request.cwd!, name)
    f.result.resolve({ output: [], stopReason: 'completed', structured: { ready: true } })
    await installing.promise
    await f.agentHandle.dispose()
    f.bundles.push(installedBundle(name))
    gate.resolve({ application: 'applied', changed: true, stage: 'install', target: name })
    await vi.waitFor(() => { expect(f.manager.listBundles).toHaveBeenCalledTimes(2) })
    await f.fiber.dispose()
    expect(f.current()?.phase).toBe('installing')
    expect(f.manager.removeBundle).not.toHaveBeenCalled()
    expect(f.bundles.map(bundle => bundle.name)).toContain(name)
  })

  it('publishes a late installation to a reopened Session without another reopen or Creator', async () => {
    const f = await fixture()
    await f.propose()
    const installing = Promise.withResolvers<undefined>()
    const gate = Promise.withResolvers<ChangeResult>()
    onTestFinished(() => { gate.resolve({ application: 'failed', changed: false, stage: 'install', target: 'fixture' }) })
    f.manager.installBundle.mockImplementation(() => { installing.resolve(undefined); return gate.promise })
    await f.act('create')
    const spec = await f.entered.promise
    const name = f.current()!.bundleName!
    await writeBundle(spec.request.cwd!, name)
    f.result.resolve({ output: [], stopReason: 'completed', structured: { ready: true } })
    await installing.promise
    const seed = [...f.events]
    await f.agentHandle.dispose()
    const reopened = await f.ctx.agents.create({ sessionId: f.agent.id, seed })
    const current = () => f.cardOf(callId, reopened.agent)
    expect(current()?.phase).toBe('installing')
    expect(await f.act('create', 'page', undefined, reopened.agent)).toEqual({ status: 'accepted' })
    f.bundles.push(installedBundle(name))
    gate.resolve({ application: 'applied', changed: true, stage: 'install', target: name })
    await vi.waitFor(() => { expect(current()?.phase).toBe('installed') })
    expect(f.startActivation).toHaveBeenCalledOnce()
  })

  it('does not replace a job while its interrupted child is still disposing', async () => {
    const f = await fixture()
    await f.propose()
    const cleanup = Promise.withResolvers<undefined>()
    onTestFinished(() => { cleanup.resolve(undefined) })
    f.dispose.mockImplementation(async () => { f.result.resolve({ output: [], stopReason: 'aborted' }); await cleanup.promise })
    await f.act('create')
    await f.entered.promise
    await f.agentHandle.dispose()
    const reopened = await f.ctx.agents.create({ sessionId: f.agent.id, seed: [...f.events] })
    expect(await f.act('create', 'page', undefined, reopened.agent)).toEqual({ status: 'accepted' })
    expect(f.startActivation).toHaveBeenCalledOnce()
    cleanup.resolve(undefined)
    await f.fiber.dispose()
    expect(f.dispose).toHaveBeenCalledOnce()
  })

  it.each(['lookup', 'lookup-reload', 'remove'] as const)('releases Undo when the plugin unloads during %s', async (stage) => {
    const f = await fixture()
    await f.propose()
    await f.act('create')
    await f.complete()
    const entered = Promise.withResolvers<undefined>()
    const lookup = Promise.withResolvers<ReturnType<typeof installedBundle>[]>()
    const removing = Promise.withResolvers<ChangeResult>()
    onTestFinished(() => { lookup.resolve(f.bundles); removing.resolve({ application: 'applied', changed: true, stage: 'remove', target: 'fixture' }) })
    if (stage !== 'remove') f.manager.listBundles.mockImplementationOnce(() => { entered.resolve(undefined); return lookup.promise })
    else f.manager.removeBundle.mockImplementationOnce(() => { entered.resolve(undefined); return removing.promise })
    const result = f.act('undo')
    await entered.promise
    const disposing = stage === 'lookup-reload' ? f.fiber.restart() : f.fiber.dispose()
    lookup.resolve(f.bundles)
    await disposing
    expect(await result).toEqual({ status: stage === 'remove' ? 'unconfirmed' : 'refused', reason: 'closing' })
    if (stage !== 'remove') expect(f.manager.removeBundle).not.toHaveBeenCalled()
    removing.resolve({ application: 'applied', changed: true, stage: 'remove', target: 'fixture' })
    await removing.promise
    expect(f.current()?.phase).toBe('installed')
  })

  it('restores an undone page from its retained profile copy without running the Creator again', async () => {
    const f = await fixture()
    await f.propose()
    await f.act('create')
    await f.complete()
    const bundleName = f.current()!.bundleName!
    const directory = join(f.directory, 'created-plugins', bundleName.slice('@dsh-local/view-'.length))
    expect(f.manager.installBundle).toHaveBeenCalledExactlyOnceWith(directory)
    await f.act('undo')
    expect(f.current()).toMatchObject({ phase: 'removed', application: 'applied' })
    const access = vi.spyOn(f.ctx.remoteAccess, 'allows').mockReturnValue(false)
    expect(await f.act('restore')).toEqual({ status: 'refused', reason: 'access-denied' })
    access.mockRestore()
    let installing: unknown
    f.manager.installBundle.mockImplementationOnce(async (path: string) => {
      installing = f.current()
      f.bundles.push(installedBundle(bundleName))
      return { application: 'applied', changed: true, stage: 'install', target: path }
    })
    expect(await f.act('restore')).toEqual(settled('installed', { slot: 'page', bundleName, application: 'applied' }))
    expect(installing).toEqual({ callId, phase: 'installing', slot: 'page', bundleName })
    expect(f.manager.installBundle).toHaveBeenLastCalledWith(directory)
    expect(f.current()).toEqual({ callId, phase: 'installed', slot: 'page', bundleName, application: 'applied' })
    expect(f.startActivation).toHaveBeenCalledOnce()
  })

  it('refuses Restore without its profile copy or package name and records nothing', async () => {
    const f = await fixture()
    await f.propose()
    await f.act('create')
    await f.complete()
    await f.act('undo')
    await rm(f.manager.installBundle.mock.calls[0]![0], { recursive: true })
    const logged = f.events.length
    expect(await f.act('restore')).toEqual({ status: 'refused', reason: 'source-missing' })
    expect(f.events).toHaveLength(logged)
    expect(f.current()?.phase).toBe('removed')
    recordCard(f.agent.session, { callId, phase: 'removed', slot: 'page' })
    expect(await f.act('restore')).toEqual({ status: 'refused', reason: 'unavailable' })
    expect(f.manager.installBundle).toHaveBeenCalledOnce()
  })

  it('records a failed receipt instead of leaving Restore installing when the reinstallation throws', async () => {
    const f = await fixture()
    await f.propose()
    await f.act('create')
    await f.complete()
    const bundleName = f.current()!.bundleName!
    await f.act('undo')
    f.manager.installBundle.mockRejectedValueOnce(new Error('profile locked'))
    expect(await f.act('restore')).toEqual(settled('failed', { slot: 'page', bundleName }))
    expect(f.current()).toEqual({ callId, phase: 'failed', slot: 'page', bundleName })
    expect(f.startActivation).toHaveBeenCalledOnce()
  })

  it('settles Restore on a page that is not removed and confirms one reinstalled elsewhere without installing it', async () => {
    const f = await fixture()
    await f.propose()
    expect(await f.act('restore')).toEqual({ status: 'refused', reason: 'unavailable' })
    await f.act('create')
    await f.complete()
    const installed = f.current()!
    expect(await f.act('restore')).toEqual(settled('installed', { slot: 'page', bundleName: installed.bundleName, application: 'applied' }))
    await f.act('undo')
    f.bundles.push(installedBundle(installed.bundleName!))
    expect(await f.act('restore')).toEqual(settled('installed', { slot: 'page', bundleName: installed.bundleName }))
    expect(f.current()).toEqual({ callId, phase: 'installed', slot: 'page', bundleName: installed.bundleName })
    expect(f.manager.installBundle).toHaveBeenCalledOnce()
  })

  it.each(['lookup', 'install', 'outcome lookup'] as const)('releases Restore when the plugin unloads during %s', async (stage) => {
    const f = await fixture()
    await f.propose()
    await f.act('create')
    await f.complete()
    await f.act('undo')
    const entered = Promise.withResolvers<undefined>()
    const lookup = Promise.withResolvers<ReturnType<typeof installedBundle>[]>()
    const installing = Promise.withResolvers<ChangeResult>()
    onTestFinished(() => { lookup.resolve(f.bundles); installing.resolve({ application: 'applied', changed: true, stage: 'install', target: 'fixture' }) })
    const blocked = () => { entered.resolve(undefined); return lookup.promise }
    if (stage === 'lookup') f.manager.listBundles.mockImplementationOnce(blocked)
    else if (stage === 'install') f.manager.installBundle.mockImplementationOnce(() => { entered.resolve(undefined); return installing.promise })
    else f.manager.listBundles.mockImplementationOnce(async () => f.bundles).mockImplementationOnce(blocked)
    const restoring = f.act('restore')
    await entered.promise
    const disposing = f.fiber.dispose()
    if (stage === 'outcome lookup') lookup.reject(new Error('profile read failed'))
    else lookup.resolve(f.bundles)
    await disposing
    expect(await restoring).toEqual({ status: stage === 'lookup' ? 'refused' : 'unconfirmed', reason: 'closing' })
    expect(f.current()?.phase).toBe(stage === 'lookup' ? 'removed' : 'installing')
    expect(f.manager.installBundle).toHaveBeenCalledTimes(stage === 'lookup' ? 1 : 2)
  })

  it('does not publish an install result returned in the same callback that unloads its owner', async () => {
    const f = await fixture()
    await f.propose()
    const disposed = Promise.withResolvers<undefined>()
    f.manager.installBundle.mockImplementation(async () => {
      void f.fiber.dispose().then(() => { disposed.resolve(undefined) }, disposed.reject)
      return { application: 'applied', changed: true, stage: 'install', target: 'fixture' }
    })
    await f.act('create')
    const spec = await f.entered.promise
    await writeBundle(spec.request.cwd!, f.current()!.bundleName!)
    f.result.resolve({ output: [], stopReason: 'completed', structured: { ready: true } })
    await disposed.promise
    expect(f.current()?.phase).toBe('installing')
  })
})
