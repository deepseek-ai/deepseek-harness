import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { createVolatile, updateVolatile } from '@deepseek-ai/cosmokit'
import type { Config as ActionCardsConfig } from '@deepseek-ai/dsh-action-cards'
import type { BundleInfo } from '@deepseek-ai/dsh-plugin-manager/types'
import { fixture } from './fixture.ts'

const SKILL = 'official-plugins'
const FEISHU = '@deepseek-ai/dsh-feishu'
const LINEAR = '@deepseek-ai/dsh-linear'
const ALL_APPS = 'Check DSH’s plugins when the user asks how to do something in this app, whether it can, or says a capability is missing or should change: input, thinking or title display, session search, terminals, worktrees, desktop control, automation, access, approvals, badges or signatures, plugin sources; or a task needs Feishu, WeCom, DingTalk, Tencent Meeting, Notion, Tencent Docs or Linear. Not a request to develop DSH, even in its repo: load before reading files. Not for other tasks or quoted wishes.'
const LINEAR_ONLY = 'Check DSH’s plugins when the user asks how to do something in this app, whether it can, or says a capability is missing or should change: input, thinking or title display, session search, terminals, worktrees, desktop control, automation, access, approvals, badges or signatures, plugin sources; or a task needs Linear. Not a request to develop DSH, even in its repo: load before reading files. Not for other tasks or quoted wishes.'
const NO_APP = 'Check DSH’s plugins when the user asks how to do something in this app, whether it can, or says a capability is missing or should change: input, thinking or title display, session search, terminals, worktrees, desktop control, automation, access, approvals, badges or signatures, plugin sources. Not a request to develop DSH, even in its repo: load before reading files. Not for other tasks or quoted wishes.'
const WITHOUT_FEISHU = ALL_APPS.replace('Feishu, ', '')
const CONNECTORS = [FEISHU, '@deepseek-ai/dsh-wecom', '@deepseek-ai/dsh-dingtalk', '@deepseek-ai/dsh-tencent-meeting',
  '@deepseek-ai/dsh-notion', '@deepseek-ai/dsh-tencent-docs', LINEAR]

/** An installed connector as the plugin manager lists it, switched off unless `fields` say otherwise. */
function connector(name: string, fields: Partial<BundleInfo> = {}): BundleInfo {
  return { name, official: false, optional: false, availability: 'profile', enabled: false, installed: true, removable: true,
    rows: [], overrides: [], ...fields }
}

async function entry(f: Awaited<ReturnType<typeof fixture>>, cwd?: string): Promise<string | undefined> {
  return (await f.ctx.skills.list(cwd === undefined ? {} : { cwd })).find(skill => skill.name === SKILL)?.description
}

describe('the official-plugins catalog entry', () => {
  it('names all seven apps for a profile that holds no connector, within the catalog\'s description limit', async () => {
    const f = await fixture()
    f.manager.listBundles.mockResolvedValue([])
    expect(await entry(f)).toBe(ALL_APPS)
    // tool-skill's default `catalogDescriptionMaxLength` is 500; a longer entry would lose the exclusions at its end.
    expect(ALL_APPS.length).toBeLessThanOrEqual(500)
    expect(ALL_APPS).toHaveLength(498)
    expect(NO_APP).toHaveLength(408)
  })

  it.each([
    ['leaves out the app of an enabled connector', [connector(FEISHU, { enabled: true })], WITHOUT_FEISHU],
    ['keeps the app of an installed connector that is switched off', [connector(FEISHU)], ALL_APPS],
    ['leaves out the app of an installed connector a card cannot enable', [connector(FEISHU, { error: { code: 'incompatible-version' } })],
      WITHOUT_FEISHU],
    ['names a single app on its own', CONNECTORS.filter(name => name !== LINEAR).map(name => connector(name, { enabled: true })), LINEAR_ONLY],
    ['names no app when no connector can be offered', CONNECTORS.map(name => connector(name, { enabled: true })), NO_APP],
  ])('%s', async (_case, listed, expected) => {
    const f = await fixture()
    f.manager.listBundles.mockResolvedValue(listed)
    expect(await entry(f)).toBe(expected)
  })

  it('composes the entry again once Plugin Manager announces a change', async () => {
    const f = await fixture()
    f.manager.listBundles.mockResolvedValue([])
    expect(await entry(f)).toBe(ALL_APPS)
    f.manager.listBundles.mockResolvedValue([connector(FEISHU, { enabled: true })])
    // The registry keeps a completed catalog until a provider invalidates it.
    expect(await entry(f)).toBe(ALL_APPS)
    f.ctx.emit('plugin-manager/changed', { reason: 'bundle' })
    expect(await entry(f)).toBe(WITHOUT_FEISHU)
    expect(f.manager.listBundles).toHaveBeenCalledTimes(2)
  })

  it('reads the listing once for lookups from different working directories', async () => {
    const f = await fixture()
    f.manager.listBundles.mockResolvedValue([])
    // The registry keeps a catalog per working directory, so each of these lookups asks this provider.
    expect(await entry(f, '/projects/first')).toBe(ALL_APPS)
    expect(await entry(f, '/projects/second')).toBe(ALL_APPS)
    expect(f.manager.listBundles).toHaveBeenCalledOnce()
  })

  it('stops a lookup cancelled while the shared read is in flight, and the read still serves another lookup', async () => {
    const f = await fixture()
    const listing = Promise.withResolvers<BundleInfo[]>()
    onTestFinished(() => { listing.resolve([]) })
    f.manager.listBundles.mockImplementationOnce(() => listing.promise)
    const cancelled = new AbortController()
    const first = f.ctx.skills.list({ cwd: '/projects/first', signal: cancelled.signal })
    const second = entry(f, '/projects/second')
    await vi.waitFor(() => { expect(f.manager.listBundles).toHaveBeenCalledOnce() })
    cancelled.abort()
    await expect(first).rejects.toThrow()
    listing.resolve([connector(FEISHU, { enabled: true })])
    expect(await second).toBe(WITHOUT_FEISHU)
    expect(await entry(f, '/projects/third')).toBe(WITHOUT_FEISHU)
    expect(f.manager.listBundles).toHaveBeenCalledOnce()
  })

  it('keeps the entry a change started when an older listing fails afterwards', async () => {
    const f = await fixture()
    const older = Promise.withResolvers<BundleInfo[]>()
    onTestFinished(() => { older.resolve([]) })
    f.manager.listBundles.mockImplementationOnce(() => older.promise).mockResolvedValue([connector(FEISHU, { enabled: true })])
    const stale = entry(f, '/projects/first')
    await vi.waitFor(() => { expect(f.manager.listBundles).toHaveBeenCalledOnce() })
    f.ctx.emit('plugin-manager/changed', { reason: 'bundle' })
    expect(await entry(f, '/projects/second')).toBe(WITHOUT_FEISHU)
    older.reject(new Error('profile unreadable'))
    await stale
    expect(await entry(f, '/projects/third')).toBe(WITHOUT_FEISHU)
    expect(f.manager.listBundles).toHaveBeenCalledTimes(2)
  })

  it('loads the definition with the entry its lookup listed', async () => {
    const f = await fixture()
    f.manager.listBundles.mockResolvedValue([connector(FEISHU, { enabled: true })])
    expect((await f.ctx.skills.get(SKILL))?.description).toBe(WITHOUT_FEISHU)
  })

  it('lists no entry and reads no listing while recommendations are switched off', async () => {
    const f = await fixture()
    updateVolatile((f.cards.effectiveConfig as ActionCardsConfig).enabled, createVolatile(false))
    f.cards.ctx.emit('loader/volatile-update', [['enabled']])
    expect((await f.ctx.skills.list()).map(skill => skill.name)).not.toContain(SKILL)
    expect(f.manager.listBundles).not.toHaveBeenCalled()
  })

  it('leaves the skill out of an incomplete catalog while the listing fails, and lists it on the next lookup', async () => {
    const f = await fixture()
    f.manager.listBundles.mockRejectedValueOnce(new Error('profile unreadable')).mockResolvedValue([])
    const failed = await f.ctx.skills.snapshot()
    expect(failed.complete).toBe(false)
    expect(failed.skills.map(skill => skill.name)).not.toContain(SKILL)
    const retried = await f.ctx.skills.snapshot()
    expect(retried.complete).toBe(true)
    expect(retried.skills.find(skill => skill.name === SKILL)?.description).toBe(ALL_APPS)
    expect(f.manager.listBundles).toHaveBeenCalledTimes(2)
  })

  it('stops a lookup cancelled before or while the profile is read', async () => {
    const f = await fixture()
    const before = new AbortController()
    const early = f.ctx.skills.list({ signal: before.signal })
    before.abort()
    await expect(early).rejects.toThrow()
    expect(f.manager.listBundles).not.toHaveBeenCalled()
    const during = new AbortController()
    f.manager.listBundles.mockImplementationOnce(async () => { during.abort(); return [] })
    await expect(f.ctx.skills.list({ signal: during.signal })).rejects.toThrow()
    expect(f.manager.listBundles).toHaveBeenCalledOnce()
  })
})
