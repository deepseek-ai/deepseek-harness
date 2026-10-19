// @vitest-environment jsdom
import type { ClientSessionContext, InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { Context } from '@deepseek-ai/cordis'
import type { BundleInfo, RemoteFailure } from '@deepseek-ai/dsh-api-remotes/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { RemoteError, TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { cleanup, render } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PluginReference } from '../src/client/PluginReference.tsx'
import { formatPluginMention } from '@deepseek-ai/dsh-plugin-manager/grammar'
import { createPluginReferenceSource, installPluginReference, pluginReferenceRule } from '../src/client/plugin-reference.ts'
import { en, type PluginManagerLocaleKey } from '../src/client/locales.ts'

afterEach(cleanup)

const t = ((key: PluginManagerLocaleKey): string => en[key]) as Parameters<typeof createPluginReferenceSource>[0]['t']

function bundle(name: string, title?: { en: string; zh?: string }, description?: { en: string; zh?: string }): BundleInfo {
  return {
    name,
    official: false,
    availability: 'profile',
    installed: true,
    optional: false,
    removable: true,
    enabled: true,
    rows: [],
    overrides: [],
    ...(title === undefined ? {} : { meta: { title, ...(description === undefined ? {} : { description }) } }),
  }
}

function deps(bundles: readonly BundleInfo[] = [
  bundle('@acme/plugin', { en: 'Acme', zh: '插件' }, { en: 'Acme plugin', zh: '插件说明' }),
  bundle('@acme/tool', { en: 'Tool' }),
]) {
  const openBundle = vi.fn(() => true)
  return {
    openBundle,
    source: createPluginReferenceSource({
      listBundles: async () => bundles,
      resolveText: text => typeof text === 'string' ? text : text.en,
      openBundle,
      t,
    }),
  }
}

const session: ClientSessionContext = { sessionId: 'session' as ClientSessionContext['sessionId'] }
const signal = new AbortController().signal
const request = { query: '', position: 'inline' as const, drilled: false, signal }

describe('plugin reference transcript rule', () => {
  it('turns a whole canonical mention into a plugin node', () => {
    const text = 'see @[Acme](dsh-plugin:@acme/plugin)'
    expect(pluginReferenceRule.match(text, 0, { read: () => undefined })).toEqual({
      id: 'plugin', start: 4, end: text.length, data: { packageName: '@acme/plugin', label: 'Acme' },
    })
    expect(pluginReferenceRule.match('no mention', 0, { read: () => undefined })).toBeUndefined()
  })
})

describe('plugin reference source', () => {
  it('lists packages once, searches every language, and inserts canonical mentions', async () => {
    const { source } = deps()
    const all = await source.candidates(session, request)
    expect(all.map(candidate => candidate.name)).toEqual(['@acme/plugin', '@acme/tool'])
    expect(all[0]).toMatchObject({
      label: 'Acme',
      description: 'Acme plugin',
      section: 'Plugins',
      value: '@[Acme](dsh-plugin:@acme/plugin)',
    })
    const chinese = await source.candidates(session, { ...request, query: '插件' })
    expect(chinese.map(candidate => candidate.name)).toEqual(['@acme/plugin'])
    const abbreviation = await source.candidates(session, { ...request, query: 'TOOL' })
    expect(abbreviation.map(candidate => candidate.name)).toEqual(['@acme/tool'])
    const pick = source.onPick({
      candidate: all[0]!, session, position: 'inline', via: 'menu', action: 'pick',
      span: { start: 0, end: 1, draftRev: 1 },
    })
    expect(pick).toEqual({
      insert: {
        source: 'plugin',
        ref: '@[Acme](dsh-plugin:@acme/plugin)',
        label: 'Acme',
        clipboardText: '@[Acme](dsh-plugin:@acme/plugin)',
      },
    })
    await expect(source.codec?.serialize('@[Acme](dsh-plugin:@acme/plugin)', signal))
      .resolves.toBe('@[Acme](dsh-plugin:@acme/plugin)')
    expect(source.codec?.clipboardText('ref')).toBe('ref')
  })

  it('falls back for metadata-less text, skips names a mention cannot carry, and handles missing pick values', async () => {
    const { source } = deps([
      bundle('@acme/plain'),
      bundle('@acme/empty', { en: '' }, { en: '' }),
      bundle('@acme/late', { en: 'Late' }),
    ])
    const rows = await source.candidates(session, request)
    expect(rows.find(row => row.name === '@acme/plain')).toMatchObject({ label: '@acme/plain' })
    expect(rows.find(row => row.name === '@acme/empty')).toMatchObject({ label: '@acme/empty' })
    expect(rows.find(row => row.name === '@acme/plain')?.description).toBeUndefined()
    expect(rows.find(row => row.name === '@acme/late')).toMatchObject({ label: 'Late' })
    const odd = await deps([bundle('Legacy_Name'), bundle('@acme/ok')]).source.candidates(session, request)
    expect(odd.map(row => row.name)).toEqual(['@acme/ok'])
    const pick = (candidate: Parameters<NonNullable<typeof source.onPick>>[0]['candidate']) => source.onPick({
      candidate, session, position: 'inline', via: 'menu', action: 'pick', span: { start: 0, end: 1, draftRev: 1 },
    })
    expect(pick({ name: 'none' })).toBeUndefined()
    expect(pick({ name: 'fallback', value: 'm' })).toMatchObject({ insert: { label: 'fallback' } })
  })

  it('opens the plugin panel from a reference and rejects unknown spellings', () => {
    const { source, openBundle } = deps()
    expect(source.openReference?.(session, { ref: '@[Acme](dsh-plugin:@acme/plugin)' })).toBe(true)
    expect(openBundle).toHaveBeenCalledWith('@acme/plugin')
    expect(source.openReference?.(session, { ref: 'not a plugin' })).toBe(false)
  })

  it('returns no candidates for an aborted request', async () => {
    const { source } = deps()
    const aborted = new AbortController()
    aborted.abort()
    await expect(source.candidates(session, { ...request, signal: aborted.signal })).resolves.toEqual([])
  })
})

describe('plugin reference installation', () => {
  async function bench(
    list: () => Promise<ListResult> = async () => ({ ok: true, value: depsBundles() }),
    navigation = true,
  ) {
    const listMock = vi.fn(list)
    const ctx = new Context()
    const locale = new LocaleRuntime(ctx)
    ctx.provide('locale', locale)
    const remote = new TestRemote(ctx, {
      pluginManager: {
        listBundles: listMock,
        listPlugins: vi.fn(async () => ({ ok: true, value: [] })),
        registries: vi.fn(async () => ({ ok: true, value: { registry: null, fallbackRegistries: [], resolved: null } })),
      },
    })
    const sources: InputTriggerSource[] = []
    ctx.provide('inputTriggers', {
      registerSource: (source: InputTriggerSource) => { sources.push(source); return () => {} },
    })
    const registerRule = vi.fn(() => () => {})
    ctx.provide('uiConversation', { userText: { register: registerRule } })
    const registerNode = vi.fn(() => () => {})
    ctx.provide('slots', {
      inject: (_name: string, callback: () => void) => { callback(); return () => {} },
      register: registerNode,
    })
    const openBundle = vi.fn()
    if (navigation) ctx.provide('pluginNavigation', { openBundle })
    const fiber = ctx.plugin({ apply: (scope) => { installPluginReference(scope, t) } })
    await fiber.await()
    return { ctx, fiber, remote, sources, registerRule, registerNode, openBundle, list: listMock }
  }

  it('registers the source, rule, and node and reuses one inventory read', async () => {
    const b = await bench()
    expect(b.sources).toHaveLength(1)
    expect(b.registerRule).toHaveBeenCalledWith(pluginReferenceRule)
    expect(b.registerNode).toHaveBeenCalledWith(
      { name: 'conversation.user.text.node', key: 'plugin', priority: 100 },
      PluginReference,
    )
    const source = b.sources[0]!
    const candidates = await source.candidates(session, request)
    expect(candidates).toHaveLength(1)
    await source.candidates(session, request)
    expect(b.list).toHaveBeenCalledTimes(1)
    b.ctx.emit('connection/reset')
    await source.candidates(session, request)
    expect(b.list).toHaveBeenCalledTimes(2)
    await b.fiber.dispose()
  })

  it('opens the bundle page when navigation exists and reports its absence', async () => {
    const withNav = await bench()
    const ref = formatPluginMention({ packageName: '@acme/plugin', label: 'Acme' })
    expect(withNav.sources[0]?.openReference?.(session, { ref })).toBe(true)
    expect(withNav.openBundle).toHaveBeenCalledWith('@acme/plugin')
    await withNav.fiber.dispose()
    const without = await bench(undefined, false)
    expect(without.sources[0]?.openReference?.(session, { ref })).toBe(false)
    await without.fiber.dispose()
  })

  it('fails the menu read when the inventory Remote fails', async () => {
    const list = vi.fn(async (): Promise<ListResult> => ({ ok: false, error: new RemoteError('gateway/internal', 'offline', {}) }))
    const b = await bench(list)
    const source = b.sources[0]!
    await expect(source.candidates(session, request)).rejects.toThrow('pluginManager.listBundles failed')
    await b.fiber.dispose()
  })
})

type ListResult = { readonly ok: true; readonly value: readonly BundleInfo[] } | { readonly ok: false; readonly error: RemoteFailure }

function depsBundles() {
  return [bundle('@acme/plugin', { en: 'Acme' })]
}

describe('PluginReference', () => {
  it('renders the label and raw mention as a read-only chip', () => {
    type Props = ComponentProps<typeof PluginReference>
    const props = {
      node: { id: 'plugin', start: 0, end: 1, data: { packageName: '@acme/plugin', label: 'Acme' } },
      raw: '@[Acme](dsh-plugin:@acme/plugin)',
      interactive: false,
    } as Props
    const view = render(<PluginReference {...props} />)
    expect(view.getByText('Acme').closest('[title]')?.getAttribute('title')).toBe('@[Acme](dsh-plugin:@acme/plugin)')
    expect(view.container.querySelector('svg')).not.toBeNull()
  })
})
