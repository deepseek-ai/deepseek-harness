import { readdir, readFile } from 'node:fs/promises'
import { describe, expect, it, onTestFinished } from 'vitest'
import { getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot'
import type { ActionCardFields } from '@deepseek-ai/dsh-action-cards'
import type { BundleInfo, ChangeResult, PluginInstallFailureKind } from '@deepseek-ai/dsh-plugin-manager/types'
import { OFFICIAL_CONNECTOR_CATALOG } from '@deepseek-ai/dsh-official-bundles'
import { CONNECTORS_TAB_BUNDLE } from '../src/connectors.ts'
import * as PluginRecommendations from '../src/index.ts'
import { ACTION, bundle, cardId, fixture } from './fixture.ts'

const FEISHU = '@deepseek-ai/dsh-feishu'
const NOTION = '@deepseek-ai/dsh-notion'
const LINEAR = '@deepseek-ai/dsh-linear'
const BUILDS = ['@larksuite/cli@1.0.97']
const version = getDshRuntimeVersion()
const install = { saveExact: true, expected: { name: FEISHU, version } }
/** An installed connector as the plugin manager lists it: a profile dependency, neither official nor optional. */
const feishu: BundleInfo = {
  name: FEISHU, official: false, optional: false, availability: 'profile', enabled: false, installed: true, removable: true,
  rows: [], overrides: [], meta: { title: { en: 'Feishu', zh: '飞书' }, description: { en: 'Use Feishu documents.', zh: '使用飞书文档。' } },
}
/** The shipped optional bundle that adds the Connectors tab, switched off. */
const tab: BundleInfo = { ...bundle, name: CONNECTORS_TAB_BUNDLE }
const applied: ChangeResult = { application: 'applied', changed: true, stage: 'enable', target: FEISHU, enabled: true }

/** A failed installation whose last pnpm run failed as `kind`, with the undecided scripts the profile lists afterwards. */
function failedInstall(kind: PluginInstallFailureKind, pendingBuilds: string[], diagnostic: string): ChangeResult {
  return {
    application: 'failed', changed: false, stage: 'install', target: `${FEISHU}@${version}`, pendingBuilds,
    packageResult: { exitCode: 1, output: diagnostic, truncated: false, logPath: '/profile/logs/install.log', kind },
    error: { code: 'operation-error', diagnostic },
  }
}
const blocked = failedInstall('build-blocked', BUILDS, '[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: @larksuite/cli@1.0.97')
const alreadyInstalled: ChangeResult = {
  application: 'failed', changed: false, stage: 'install', target: `${FEISHU}@${version}`, error: { code: 'already-installed' },
}

/** A card offering Feishu, with the profile listing `listed`. */
async function connectorCard(listed: BundleInfo[] = []) {
  const f = await fixture()
  f.manager.listBundles.mockResolvedValue(listed)
  f.propose(undefined, { title: '飞书', brief: '读取你分享的飞书文档。', details: { name: FEISHU } })
  const act = (verb: string, payload?: ActionCardFields) => f.ctx.actionCards.act(f.agent, cardId, verb, payload)
  return { ...f, act }
}

function decision(phase: string, data?: ActionCardFields) {
  return { status: 'settled', decision: { cardId, action: ACTION, phase, ...data === undefined ? {} : { data } } }
}

describe('official connector cards', () => {
  it('offers every official connector package through the connector catalog', async () => {
    const root = new URL('../../../connector/', import.meta.url)
    const packages: string[] = []
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const manifest = JSON.parse(await readFile(new URL(`${entry.name}/package.json`, root), 'utf8')) as { name: string; dsh?: { bundle?: object } }
      // The account and skill helpers beside the connectors declare no bundle.
      if (manifest.dsh?.bundle !== undefined) packages.push(manifest.name)
    }
    expect(OFFICIAL_CONNECTOR_CATALOG.map(entry => entry.packageName).toSorted()).toEqual(packages.toSorted())
  })

  it('appends every connector to the catalog with whether the profile holds and selects it', async () => {
    const f = await fixture()
    f.manager.listBundles.mockResolvedValue([bundle, { ...feishu, enabled: true }, { ...feishu, name: NOTION }, tab])
    const skill = await f.ctx.skills.get('official-plugins')
    const catalog: unknown = JSON.parse(skill!.content.split('## Official plugins\n\n')[1]!)
    expect(catalog).toEqual([
      { name: bundle.name, title: 'Search', description: 'Search past conversations.', enabled: false },
      { name: CONNECTORS_TAB_BUNDLE, title: 'Search', description: 'Search past conversations.', enabled: false },
      ...OFFICIAL_CONNECTOR_CATALOG.map(({ packageName: name, meta: { title, description } }) => ({
        name, title: title.en, description: description.en, enabled: name === FEISHU, installed: name === FEISHU || name === NOTION,
      })),
    ])
  })

  it('classifies each catalog connector as its card would', async () => {
    const f = await fixture()
    f.manager.listBundles.mockResolvedValue([
      { ...feishu, error: { code: 'incompatible-version' } },
      // A selection whose package the profile no longer holds is installed again, so it is not enabled.
      { ...feishu, name: NOTION, installed: false, enabled: true, error: { code: 'not-bundle' } },
      { ...feishu, name: LINEAR, enabled: true },
    ])
    const skill = await f.ctx.skills.get('official-plugins')
    const catalog = JSON.parse(skill!.content.split('## Official plugins\n\n')[1]!) as { name: string }[]
    // An installed connector a card cannot enable is left out, as an ineligible plugin is.
    expect(catalog.map(entry => entry.name)).not.toContain(FEISHU)
    expect(catalog.find(entry => entry.name === NOTION)).toMatchObject({ enabled: false, installed: false })
    expect(catalog.find(entry => entry.name === LINEAR)).toMatchObject({ enabled: true, installed: true })
  })

  it('describes a connector the profile does not hold as installable and an installed one by its own text', async () => {
    const f = await connectorCard()
    const { meta } = OFFICIAL_CONNECTOR_CATALOG.find(entry => entry.packageName === FEISHU)!
    const installable = { status: 'installable', title: meta.title, description: meta.description }
    const described = await f.ctx.pluginRecommendations.describe(f.agent, cardId)
    expect(described).toEqual(installable)
    // The card has the connector's text in every shipped language, not only in English and Chinese.
    expect(described).toHaveProperty('description.ja', meta.description.ja)
    // A selection whose package the profile no longer holds is installed again.
    f.manager.listBundles.mockResolvedValueOnce([{ ...feishu, installed: false, enabled: true, error: { code: 'not-bundle' } }])
    expect(await f.ctx.pluginRecommendations.describe(f.agent, cardId)).toEqual(installable)
    f.manager.listBundles.mockResolvedValueOnce([feishu])
    expect(await f.ctx.pluginRecommendations.describe(f.agent, cardId)).toEqual({
      status: 'available', title: feishu.meta!.title, description: feishu.meta!.description, enabled: false, connector: true,
    })
    const unusable: BundleInfo[] = [
      { ...feishu, availability: 'missing' }, { ...feishu, readOnlyReason: 'management-required' }, { ...feishu, error: { code: 'incompatible-version' } },
    ]
    for (const listed of unusable) {
      f.manager.listBundles.mockResolvedValueOnce([listed])
      expect(await f.ctx.pluginRecommendations.describe(f.agent, cardId)).toEqual({ status: 'refused', reason: 'unavailable' })
    }
  })

  it('installs a connector the profile does not hold at the DSH version and records it enabled', async () => {
    const f = await connectorCard()
    expect(await f.act('enable')).toEqual(decision('enabled'))
    expect(await f.act('enable')).toEqual(decision('enabled'))
    expect(f.manager.installBundle).toHaveBeenCalledExactlyOnceWith(`${FEISHU}@${version}`, install)
    expect(f.manager.setBundleEnabled).not.toHaveBeenCalled()
  })

  const outcomes: [string, ChangeResult, ReturnType<typeof decision>][] = [
    ['a restart', { ...applied, application: 'restart-required' }, decision('enabled', { application: 'restart-required' })],
    ['another package', { ...applied, application: 'failed', pendingBuilds: [], error: { code: 'unexpected-package', diagnostic: 'other@1.0.0' } },
      decision('failed', { errorCode: 'unexpected-package' })],
    ['blocked install scripts', blocked, decision('failed', { errorCode: 'operation-error', pendingBuilds: BUILDS })],
    ['blocked install scripts it cannot name', { ...blocked, pendingBuilds: [] }, decision('failed', { errorCode: 'operation-error' })],
  ]
  it.each(outcomes)('records an installation that reports %s without its diagnostic', async (_outcome, result, recorded) => {
    const f = await connectorCard()
    f.manager.installBundle.mockResolvedValueOnce(result)
    expect(await f.act('enable')).toEqual(recorded)
    expect(JSON.stringify(f.events)).not.toContain('ERR_PNPM')
    expect(JSON.stringify(f.events)).not.toContain('other@1.0.0')
  })

  it('records a rejected installation as failed and installs again on the next click', async () => {
    const f = await connectorCard()
    f.manager.installBundle.mockRejectedValueOnce(new Error('profile lock timed out'))
    expect(await f.act('enable')).toEqual(decision('failed', { errorCode: 'operation-error' }))
    expect(await f.act('enable')).toEqual(decision('enabled'))
    expect(f.manager.installBundle).toHaveBeenCalledTimes(2)
  })

  it('records a cancelled installation as failed and installs again on the next click', async () => {
    const f = await connectorCard()
    f.manager.installBundle.mockResolvedValueOnce({ application: 'cancelled', changed: false, stage: 'install', target: `${FEISHU}@${version}` })
    expect(await f.act('enable')).toEqual(decision('failed'))
    expect(await f.act('enable')).toEqual(decision('enabled'))
    expect(f.manager.installBundle).toHaveBeenCalledTimes(2)
  })

  it('retries a blocked installation allowing exactly the scripts its failure recorded', async () => {
    const f = await connectorCard()
    f.manager.installBundle.mockResolvedValueOnce(blocked)
    expect(await f.act('enable')).toEqual(decision('failed', { errorCode: 'operation-error', pendingBuilds: BUILDS }))
    // The names the browser sends approve nothing.
    expect(await f.act('approve', { pendingBuilds: ['unrelated@1.0.0'] })).toEqual(decision('enabled'))
    expect(f.manager.installBundle).toHaveBeenLastCalledWith(`${FEISHU}@${version}`, { ...install, approvedBuilds: BUILDS })
    expect(await f.act('approve')).toEqual({ status: 'refused', reason: 'unavailable' })
    expect(f.manager.installBundle).toHaveBeenCalledTimes(2)
  })

  it('offers no scripts for approval after an installation pnpm did not stop on them', async () => {
    const f = await connectorCard()
    // The profile still lists a script an earlier installation left undecided; this run failed to reach the registry.
    f.manager.installBundle.mockResolvedValueOnce(failedInstall('network', ['esbuild@0.25.0'], 'ERR_PNPM_META_FETCH_FAIL'))
    expect(await f.act('enable')).toEqual(decision('failed', { errorCode: 'operation-error' }))
    expect(await f.act('approve')).toEqual({ status: 'refused', reason: 'unavailable' })
    expect(f.manager.installBundle).toHaveBeenCalledOnce()
  })

  it('refuses approval unless the last decision recorded install scripts awaiting it', async () => {
    const f = await connectorCard()
    const refusal = { status: 'refused', reason: 'unavailable' }
    expect(await f.act('approve')).toEqual(refusal)
    for (const data of [undefined, { errorCode: 'operation-error' }]) {
      f.ctx.actionCards.record(f.agent, { cardId, action: ACTION, phase: 'failed', ...data === undefined ? {} : { data } })
      expect(await f.act('approve')).toEqual(refusal)
    }
    expect(f.manager.installBundle).not.toHaveBeenCalled()
    expect(f.manager.setBundleEnabled).not.toHaveBeenCalled()
  })

  it.each([
    ['enables', false, decision('enabled'), 1],
    ['settles', true, decision('already-enabled'), 0],
  ] as const)('%s a connector installed elsewhere since its installation stopped on install scripts, allowing none', async (
    _verb, enabled, recorded, selections,
  ) => {
    const f = await connectorCard()
    f.manager.installBundle.mockResolvedValueOnce(blocked)
    await f.act('enable')
    f.manager.listBundles.mockResolvedValue([{ ...feishu, enabled }])
    expect(await f.act('approve')).toEqual(recorded)
    expect(f.manager.installBundle).toHaveBeenCalledOnce()
    expect(f.manager.setBundleEnabled).toHaveBeenCalledTimes(selections)
  })

  it('enables a connector that another action installed while this installation waited', async () => {
    const f = await connectorCard()
    f.manager.installBundle.mockResolvedValueOnce(alreadyInstalled)
    f.manager.setBundleEnabled.mockResolvedValueOnce({ ...applied, application: 'restart-required' })
    expect(await f.act('enable')).toEqual(decision('enabled', { application: 'restart-required' }))
    expect(f.manager.setBundleEnabled).toHaveBeenCalledExactlyOnceWith(FEISHU, true)
  })

  it('starts no selection change while this plugin unloads after another action installed the connector', async () => {
    const f = await connectorCard()
    const entered = Promise.withResolvers<undefined>()
    const gate = Promise.withResolvers<ChangeResult>()
    onTestFinished(() => { gate.resolve(alreadyInstalled) })
    f.manager.installBundle.mockImplementationOnce(() => { entered.resolve(undefined); return gate.promise })
    const action = f.act('enable')
    await entered.promise
    // A second card's catalog read keeps the unload waiting, so the installation answers while this plugin still unloads.
    f.agent.session.append('turn/start', { turn: 2 })
    const second = f.propose('card-connector-2', { title: '飞书', brief: '读取飞书消息。', details: { name: FEISHU } })
    const reading = Promise.withResolvers<undefined>()
    const listing = Promise.withResolvers<BundleInfo[]>()
    onTestFinished(() => { listing.resolve([]) })
    f.manager.listBundles.mockImplementationOnce(() => { reading.resolve(undefined); return listing.promise })
    const other = f.ctx.actionCards.act(f.agent, second, 'enable')
    await reading.promise
    const disposal = f.fiber.dispose()
    expect(await action).toEqual({ status: 'unconfirmed', reason: 'closing' })
    gate.resolve(alreadyInstalled)
    await new Promise(resolve => setImmediate(resolve))
    listing.resolve([])
    await disposal
    expect(await other).toEqual({ status: 'refused', reason: 'closing' })
    expect(f.manager.setBundleEnabled).not.toHaveBeenCalled()
  })

  it('enables an installed connector that is off through its selection, and settles one that is on', async () => {
    const f = await connectorCard([feishu])
    expect(await f.act('enable')).toEqual(decision('enabled'))
    expect(f.manager.setBundleEnabled).toHaveBeenCalledExactlyOnceWith(FEISHU, true)
    f.agent.session.append('turn/start', { turn: 2 })
    const second = f.propose('card-connector-2', { title: '飞书', brief: '读取飞书消息。', details: { name: FEISHU } })
    f.manager.listBundles.mockResolvedValue([{ ...feishu, enabled: true }])
    expect(await f.ctx.actionCards.act(f.agent, second, 'enable')).toEqual({ status: 'settled',
      decision: { cardId: second, action: ACTION, phase: 'already-enabled' } })
    f.manager.listBundles.mockResolvedValue([{ ...feishu, error: { code: 'incompatible-version' } }])
    f.agent.session.append('turn/start', { turn: 3 })
    const broken = f.propose('card-connector-3', { title: '飞书', brief: '读取飞书日程。', details: { name: FEISHU } })
    expect(await f.ctx.actionCards.act(f.agent, broken, 'enable')).toEqual({ status: 'refused', reason: 'unavailable' })
    expect(f.manager.setBundleEnabled).toHaveBeenCalledOnce()
    expect(f.manager.installBundle).not.toHaveBeenCalled()
  })

  it.each([
    ['switches the Connectors tab on first', [tab], true],
    ['leaves a Connectors tab that is on', [{ ...tab, enabled: true }], false],
    ['leaves a Connectors tab it cannot change', [{ ...tab, error: { code: 'unsupported-platform' } }], false],
    ['installs without a Connectors tab', [], false],
  ] as const)('%s before installing a connector', async (_case, listed, switched) => {
    const f = await connectorCard([...listed])
    expect(await f.act('enable')).toEqual(decision('enabled'))
    expect(f.manager.setBundleEnabled.mock.calls).toEqual(switched ? [[CONNECTORS_TAB_BUNDLE, true]] : [])
    if (switched) {
      expect(f.manager.setBundleEnabled.mock.invocationCallOrder[0]).toBeLessThan(f.manager.installBundle.mock.invocationCallOrder[0]!)
    }
    expect(f.manager.installBundle).toHaveBeenCalledOnce()
  })

  it.each(['approve', 'enable'] as const)('switches the Connectors tab on before %s on a connector card', async (verb) => {
    const f = await connectorCard([tab, ...verb === 'enable' ? [feishu] : []])
    if (verb === 'approve') f.ctx.actionCards.record(f.agent, { cardId, action: ACTION, phase: 'failed', data: { pendingBuilds: BUILDS } })
    expect(await f.act(verb)).toEqual(decision('enabled'))
    expect(f.manager.setBundleEnabled.mock.calls[0]).toEqual([CONNECTORS_TAB_BUNDLE, true])
  })

  it.each([
    ['is rejected', (f: Awaited<ReturnType<typeof connectorCard>>) => { f.manager.setBundleEnabled.mockRejectedValueOnce(new Error('locked')) }],
    ['fails', (f: Awaited<ReturnType<typeof connectorCard>>) => {
      f.manager.setBundleEnabled.mockResolvedValueOnce({ ...applied, application: 'failed', target: CONNECTORS_TAB_BUNDLE, error: { code: 'operation-error' } })
    }],
  ] as const)('installs the connector when switching the Connectors tab on %s', async (_case, arrange) => {
    const f = await connectorCard([tab])
    arrange(f)
    expect(await f.act('enable')).toEqual(decision('enabled'))
    expect(f.manager.installBundle).toHaveBeenCalledOnce()
  })

  it('refuses the action without installing when this plugin unloads while the Connectors tab switches on', async () => {
    const f = await connectorCard([tab])
    const entered = Promise.withResolvers<undefined>()
    const gate = Promise.withResolvers<ChangeResult>()
    onTestFinished(() => { gate.resolve(applied) })
    f.manager.setBundleEnabled.mockImplementationOnce(() => { entered.resolve(undefined); return gate.promise })
    const action = f.act('enable')
    await entered.promise
    await f.fiber.dispose()
    expect(await action).toEqual({ status: 'refused', reason: 'closing' })
    expect(f.card()).toBeUndefined()
    expect(f.manager.installBundle).not.toHaveBeenCalled()
  })

  it('refuses the action without installing when its conversation closes while the Connectors tab switches on', async () => {
    const f = await connectorCard([tab])
    const entered = Promise.withResolvers<undefined>()
    const gate = Promise.withResolvers<ChangeResult>()
    onTestFinished(() => { gate.resolve(applied) })
    f.manager.setBundleEnabled.mockImplementationOnce(() => { entered.resolve(undefined); return gate.promise })
    const action = f.act('enable')
    await entered.promise
    await f.handle.dispose()
    gate.resolve({ ...applied, target: CONNECTORS_TAB_BUNDLE })
    expect(await action).toEqual({ status: 'refused', reason: 'not-live-root' })
    expect(f.card()).toBeUndefined()
    expect(f.manager.setBundleEnabled).toHaveBeenCalledExactlyOnceWith(CONNECTORS_TAB_BUNDLE, true)
    expect(f.manager.installBundle).not.toHaveBeenCalled()
  })

  it('records an installation an unload cut off as unconfirmed, then as enabled once the connector is on', async () => {
    const f = await connectorCard()
    const entered = Promise.withResolvers<undefined>()
    const gate = Promise.withResolvers<ChangeResult>()
    onTestFinished(() => { gate.resolve(applied) })
    f.manager.installBundle.mockImplementationOnce(() => { entered.resolve(undefined); return gate.promise })
    const action = f.act('enable')
    await entered.promise
    await f.fiber.dispose()
    expect(await action).toEqual({ status: 'unconfirmed', reason: 'closing' })
    expect(f.card()).toEqual({ cardId, action: ACTION, phase: 'unconfirmed' })
    gate.resolve(applied)
    await f.ctx.plugin(PluginRecommendations)
    f.manager.listBundles.mockResolvedValue([{ ...feishu, enabled: true }])
    expect(await f.act('dismiss')).toEqual(decision('enabled'))
    expect(f.manager.installBundle).toHaveBeenCalledOnce()
  })
})
