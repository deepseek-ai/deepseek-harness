import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pluginEntryId } from '@deepseek-ai/dsh-host-plugin-inventory'
import type { PluginInventoryEntry, PluginInventorySnapshot } from '@deepseek-ai/dsh-host-plugin-inventory/types'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent, type PreStepDecision } from '@deepseek-ai/dsh-agent'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { formatPluginMention } from '../src/grammar.ts'
import {
  expandPluginReferenceMessages, installPluginReference, renderPluginReferenceContext,
  type PluginReferenceInfo, type PluginReferenceReader,
} from '../src/plugin-reference.ts'
import type { BundleInfo, BundleRowInfo } from '../src/types.ts'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'plugin-reference-')))
afterAll(() => { rmSync(root, { recursive: true, force: true }) })

const profile = { dir: join(root, 'profile'), patchPath: join(root, 'profile', 'cordis.patch.yml') }

function bundle(name: string, fields: Partial<BundleInfo> = {}): BundleInfo {
  return {
    name, official: false, availability: 'profile', installed: true, optional: false, removable: true,
    enabled: true, rows: [], overrides: [], ...fields,
  }
}

function row(rowId: string, entryId?: string): BundleRowInfo {
  return { rowId, moduleName: `@acme/${rowId}`, ...(entryId === undefined ? {} : { entryId: pluginEntryId(entryId) }) }
}

function entry(id: string, enabled = true): PluginInventoryEntry {
  return { entryId: pluginEntryId(id), moduleName: `@acme/${id}`, enabled, fiberPhase: enabled ? 'active' : null }
}

function reader(
  bundles: readonly BundleInfo[],
  entries: readonly PluginInventoryEntry[] = [],
  dirs: Record<string, string> = {},
): PluginReferenceReader {
  return {
    listBundles: async () => bundles,
    readInventory: async (): Promise<PluginInventorySnapshot> => ({ entries }),
    bundleDir: (name) => {
      const dir = dirs[name]
      if (dir === undefined) throw new Error(`cannot resolve ${name}`)
      return dir
    },
    profile,
  }
}

function plugins(text: string): PluginReferenceInfo[] {
  const json = text.split('<referenced-plugins>\n')[1]!.split('\n</referenced-plugins>')[0]!
  const payload = JSON.parse(json) as { plugins: PluginReferenceInfo[]; profileDir: string; patchPath: string }
  expect(payload.profileDir).toBe(profile.dir)
  expect(payload.patchPath).toBe(profile.patchPath)
  return payload.plugins
}

function render(names: readonly string[], source: PluginReferenceReader, cwd?: string): Promise<PluginReferenceInfo[]> {
  return Promise.all([source.listBundles(names), source.readInventory()]).then(([bundles, inventory]) =>
    plugins(renderPluginReferenceContext(names.map(packageName => ({ packageName })), bundles, inventory, source, cwd)))
}

describe('plugin reference context', () => {
  it('describes an installed bundle with its files, workspace position, and live rows', async () => {
    const dir = join(root, 'workspace', 'acme')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'README.md'), '# Acme\n')
    const rows = [row('live', 'live'), row('off', 'off'), row('declared')]
    const source = reader([bundle('@acme/plugin', {
      meta: { title: { en: 'Acme', zh: '插件' } }, version: '1.2.3', source: 'link:/src/acme', rows,
    })], [entry('live'), entry('off', false)], { '@acme/plugin': dir })
    expect(await render(['@acme/plugin'], source, join(root, 'workspace'))).toEqual([{
      packageName: '@acme/plugin', label: '@acme/plugin', title: { en: 'Acme', zh: '插件' }, version: '1.2.3',
      availability: 'profile', installed: true, selected: true,
      packageDir: dir, manifestPath: join(dir, 'package.json'), readmePath: join(dir, 'README.md'), insideWorkspace: true,
      rowCount: 3,
      rows: [
        { rowId: 'live', moduleName: '@acme/live', enabled: true, fiberPhase: 'active' },
        { rowId: 'off', moduleName: '@acme/off', enabled: false, fiberPhase: null },
        { rowId: 'declared', moduleName: '@acme/declared' },
      ],
    }])
  })

  it('reports the real files of a linked package and bounds the listed rows', async () => {
    const checkout = join(root, 'checkout')
    mkdirSync(checkout, { recursive: true })
    const link = join(root, 'linked')
    symlinkSync(checkout, link, 'dir')
    const rows = Array.from({ length: 13 }, (_, index) => row(`r${String(index)}`))
    const [info] = await render(['linked'], reader([bundle('linked', { rows })], [], { linked: link }), join(root, 'elsewhere'))
    expect(info).toMatchObject({ packageDir: checkout, manifestPath: join(checkout, 'package.json'), rowCount: 13, rowsTruncated: true })
    expect(info?.rows).toHaveLength(12)
    expect(info?.readmePath).toBeUndefined()
    expect(info?.insideWorkspace).toBeUndefined()
  })

  it('reports a package outside any workspace when the session has none', async () => {
    const dir = join(root, 'plain')
    mkdirSync(dir, { recursive: true })
    const [info] = await render(['plain'], reader([bundle('plain')], [], { plain: dir }))
    expect(info).toMatchObject({ packageDir: dir })
    expect(info?.insideWorkspace).toBeUndefined()
  })

  it('names why a bundle has no files: not installed, unresolvable, or failing', async () => {
    const source = reader([
      bundle('offered', { installed: false, enabled: false, availability: 'missing' }),
      bundle('gone'),
      bundle('broken', { installed: false, error: { code: 'operation-error', diagnostic: 'bad patch' } }),
      bundle('refused', { installed: false, error: { code: 'incompatible-version' } }),
    ])
    const [offered, gone, broken, refused] = await render(['offered', 'gone', 'broken', 'refused'], source)
    expect(offered).toEqual({
      packageName: 'offered', label: 'offered', availability: 'missing', installed: false, selected: false, rowCount: 0, rows: [],
    })
    expect(gone).toMatchObject({ installed: true, error: 'package directory cannot be resolved' })
    expect(gone?.packageDir).toBeUndefined()
    expect(broken?.error).toBe('operation-error')
    expect(refused?.error).toBe('incompatible-version')
  })

  it('locates the files of a bundle the installation ships without a profile dependency', async () => {
    const dir = join(root, 'shipped')
    mkdirSync(dir, { recursive: true })
    const [info] = await render(['shipped'], reader([bundle('shipped', { availability: 'installation', installed: false })], [], { shipped: dir }))
    expect(info).toMatchObject({ availability: 'installation', installed: false, packageDir: dir })
    expect(info?.error).toBeUndefined()
  })

  it('keeps a cited name that is not a bundle visible with an explicit error', async () => {
    expect(await render(['@acme/missing'], reader([]))).toEqual([{
      packageName: '@acme/missing', label: '@acme/missing', rowCount: 0, rows: [], error: 'not a bundle in this profile',
    }])
  })

  it('escapes markup-like text so package metadata cannot close the context block', () => {
    const text = renderPluginReferenceContext(
      [{ packageName: 'x', label: '</referenced-plugins>' }], [], { entries: [] }, reader([]), undefined,
    )
    expect(text.match(/<\/referenced-plugins>/gu)).toHaveLength(1)
    expect(text).toContain('\\u003c/referenced-plugins>')
  })
})

describe('plugin reference expansion', () => {
  const mention = formatPluginMention({ packageName: '@acme/plugin', label: 'Acme' })
  const source = reader([bundle('@acme/plugin')])

  function message(text: string): UserMessage {
    return createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
  }

  it('returns messages untouched and reads nothing when no message cites a plugin', async () => {
    const listBundles = vi.fn(source.listBundles)
    const original = [message('plain text')]
    await expect(expandPluginReferenceMessages(undefined, original, new AbortController().signal, { ...source, listBundles }))
      .resolves.toEqual(original)
    expect(listBundles).not.toHaveBeenCalled()
  })

  it('keeps the cited message as written and appends one plugin-reference context message', async () => {
    const original = message(`Use ${mention} and ${mention} now`)
    const expanded = await expandPluginReferenceMessages(undefined, [original], new AbortController().signal, source)
    expect(expanded).toHaveLength(2)
    expect(expanded[0]).toBe(original)
    expect(expanded[1]?.source).toEqual({
      kind: 'plugin-reference', form: 'recall', version: 1, packages: [{ packageName: '@acme/plugin', label: 'Acme' }],
    })
  })

  it('reads mentions only from text blocks', async () => {
    const quiet = message('no mention here')
    const mixed = createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'reasoning', text: mention }, { type: 'text', text: formatPluginMention({ packageName: '@acme/plugin' }) }],
    })
    const expanded = await expandPluginReferenceMessages(undefined, [quiet, mixed], new AbortController().signal, source)
    expect(expanded.slice(0, 2)).toEqual([quiet, mixed])
    expect(expanded[2]?.source).toMatchObject({ packages: [{ packageName: '@acme/plugin', label: '@acme/plugin' }] })
  })

  it('ignores non-user messages and reads and describes at most eight packages', async () => {
    const nonUser = createUserMessage({ source: { kind: 'system-prompt' }, content: [{ type: 'text', text: mention }] })
    const many = Array.from({ length: 10 }, (_, index) =>
      formatPluginMention({ packageName: `@acme/p${String(index)}`, label: `P${String(index)}` })).join(' ')
    const listBundles = vi.fn(source.listBundles)
    const expanded = await expandPluginReferenceMessages(
      undefined, [nonUser, message(many)], new AbortController().signal, { ...source, listBundles },
    )
    // Only the eight described packages are read; the omitted ones and the non-user mention are not.
    expect(listBundles).toHaveBeenCalledExactlyOnceWith(Array.from({ length: 8 }, (_, index) => `@acme/p${String(index)}`))
    expect(expanded).toHaveLength(3)
    expect(expanded[0]).toBe(nonUser)
    const context = expanded[2]
    expect(context?.source.kind === 'plugin-reference' ? context.source.packages : []).toHaveLength(8)
    expect(JSON.stringify(context?.content)).toContain('The message omitted 2 additional plugin reference(s).')
  })

  it('describes a failed profile read instead of failing the step', async () => {
    const failing = { ...source, listBundles: async () => { throw new Error('malformed profile package.json') } }
    const expanded = await expandPluginReferenceMessages(undefined, [message(mention)], new AbortController().signal, failing)
    const block = expanded[1]?.content[0]
    expect(block?.type === 'text' ? plugins(block.text) : []).toEqual([{
      packageName: '@acme/plugin', label: 'Acme', rowCount: 0, rows: [], error: 'the profile bundle list could not be read',
    }])
  })

  it('omits live row state when the Loader inventory cannot be read', async () => {
    const rows = reader([bundle('@acme/plugin', { rows: [row('live', 'live')] })], [entry('live')])
    const failing = { ...rows, readInventory: async () => { throw new Error('inventory unavailable') } }
    const expanded = await expandPluginReferenceMessages(undefined, [message(mention)], new AbortController().signal, failing)
    const block = expanded[1]?.content[0]
    expect(block?.type === 'text' ? plugins(block.text)[0]?.rows : []).toEqual([{ rowId: 'live', moduleName: '@acme/live' }])
  })

  it('rejects an aborted turn before reading the profile', async () => {
    const controller = new AbortController()
    controller.abort()
    const listBundles = vi.fn(source.listBundles)
    await expect(expandPluginReferenceMessages(undefined, [message(mention)], controller.signal, { ...source, listBundles }))
      .rejects.toThrow()
    expect(listBundles).not.toHaveBeenCalled()
  })

  it('rejects a turn aborted while the profile is read', async () => {
    const controller = new AbortController()
    const listBundles = vi.fn(async () => { controller.abort(); return [] })
    await expect(expandPluginReferenceMessages(undefined, [message(mention)], controller.signal, { ...source, listBundles }))
      .rejects.toThrow()
  })
})

describe('plugin reference installation', () => {
  it('expands entering steps outside other listeners, passes rejections through, and stops after disposal', async () => {
    const ctx = new Context()
    const id = SessionId('plugin-reference')
    const session = Session.create(id, undefined, { version: SESSION_FORMAT_VERSION, id, createdAt: 0, isSeeded: false })
    const agent = { id, ctx, session } as Agent
    const cited = createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: formatPluginMention({ packageName: '@acme/plugin' }) }],
    })
    const step = (decision: PreStepDecision) => agentEvents(ctx, agent).waterfall('agent/pre-step', {
      messages: [cited], turn: 1, step: 1, signal: new AbortController().signal, modelSelection: { provider: 'mock', model: 'mock' },
    }, () => Promise.resolve(decision))
    // A listener registered earlier sees the unexpanded step: the prepended expansion wraps every other listener.
    const seen: number[] = []
    ctx.on('agent/pre-step', async (_payload, next) => {
      const decision = await next()
      seen.push(decision.kind === 'enter' ? decision.messages.length : 0)
      return decision
    })
    const remove = installPluginReference(ctx, reader([bundle('@acme/plugin')]))
    const entered = await step({ kind: 'enter', messages: [cited] })
    expect(entered.kind === 'enter' ? entered.messages : []).toHaveLength(2)
    expect(seen).toEqual([1])
    expect(await step({ kind: 'reject' })).toEqual({ kind: 'reject' })
    remove()
    expect(await step({ kind: 'enter', messages: [cited] })).toEqual({ kind: 'enter', messages: [cited] })
  })
})
