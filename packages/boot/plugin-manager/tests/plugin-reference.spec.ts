import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RuntimeResolution } from '@deepseek-ai/dsh-app-boot'
import { pluginEntryId } from '@deepseek-ai/dsh-host-plugin-inventory'
import type { PluginInventoryEntry, PluginInventorySnapshot } from '@deepseek-ai/dsh-host-plugin-inventory/types'
import type { PluginLocalizedMeta } from '@deepseek-ai/dsh-package-manifest'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { afterAll, describe, expect, it, vi } from 'vitest'
import {
  decodePluginReferenceUri, encodePluginReferenceUri, expandPluginReferenceMessages, formatPluginMention, installPluginReference,
  packageNameOfModule, parsePluginMentions, renderPluginReferenceContext, type PluginReferenceServices,
} from '../src/plugin-reference.ts'

function entry(moduleName: string, id: string, meta?: PluginLocalizedMeta): PluginInventoryEntry {
  return {
    entryId: pluginEntryId(id),
    moduleName,
    ...(meta === undefined ? {} : { meta }),
    enabled: true,
    fiberPhase: 'active',
  }
}

function snapshot(entries: readonly PluginInventoryEntry[]): PluginInventorySnapshot {
  return { entries }
}

function resolution(packageDir: string | undefined, version: string | undefined): RuntimeResolution {
  return {
    profilesDir: '/profiles',
    profileDir: '/profiles/web',
    localPackageNames: [],
    entries: packageDir === undefined ? [] : [{
      name: '@acme/plugin', packageDir, version, declarer: 'root', scope: 'profile',
    }],
    linkedRoots: [{ name: '@acme/plugin', realPath: '/src/acme-plugin' }],
  }
}

const services: PluginReferenceServices = {
  pluginPackages: { resolution: resolution('/pkg/acme', '1.2.3') },
  profileContext: { dir: '/profiles/web', patchPath: '/profiles/web/cordis.patch.yml' },
}

interface PayloadPlugin {
  packageName: string
  label: string
  title?: { en: string; zh?: string }
  version?: string
  scope?: string
  packageDir?: string
  manifestPath?: string
  readmePath?: string
  linkedRoot?: string
  insideWorkspace?: true
  entryCount: number
  entries: { entryId: string; moduleName: string; enabled: boolean; fiberPhase: string | null }[]
  entriesTruncated?: true
  error?: string
}

interface Payload {
  plugins: PayloadPlugin[]
  profileDir?: string
  patchPath?: string
}

function payload(text: string): Payload {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  return JSON.parse(text.slice(start, end + 1)) as Payload
}

const tempRoot = mkdtempSync(join(tmpdir(), 'plugin-reference-'))
afterAll(() => { rmSync(tempRoot, { recursive: true, force: true }) })

describe('plugin reference grammar', () => {
  it('round-trips a package and escaped label through canonical mentions', () => {
    const mention = formatPluginMention({ packageName: '@acme/plugin', label: 'Acme [plugin] \\ one' })
    expect(mention).toBe('@[Acme [plugin\\] \\\\ one](dsh-plugin:@acme/plugin)')
    expect(parsePluginMentions(`Use ${mention} now`)).toEqual({
      text: 'Use @Acme [plugin] \\ one now',
      references: [{ packageName: '@acme/plugin', label: 'Acme [plugin] \\ one' }],
    })
  })

  it('leaves malformed or unknown mentions as ordinary text', () => {
    const text = 'A @[bad](dsh-plugin:INVALID) and @[ok](dsh-plugin:@acme/plugin) and plain'
    expect(parsePluginMentions(text)).toEqual({
      text: 'A @[bad](dsh-plugin:INVALID) and @ok and plain',
      references: [{ packageName: '@acme/plugin', label: 'ok' }],
    })
  })

  it('rejects non-canonical package names and extracts bare package names', () => {
    expect(() => encodePluginReferenceUri('Bad Name')).toThrow('invalid plugin package name')
    expect(() => decodePluginReferenceUri('http://example.com')).toThrow('invalid plugin reference URI')
    expect(formatPluginMention({ packageName: '@acme/plugin' })).toBe('@[@acme/plugin](dsh-plugin:@acme/plugin)')
    expect(packageNameOfModule('@acme/plugin')).toBe('@acme/plugin')
    expect(packageNameOfModule('@acme/plugin/client')).toBe('@acme/plugin')
    expect(packageNameOfModule('dsh-tool/read')).toBe('dsh-tool')
    expect(packageNameOfModule('plain')).toBe('plain')
  })
})

describe('plugin reference context', () => {
  it('describes a package with live entries, links, and profile paths', () => {
    const acmeDir = join(tempRoot, 'acme')
    mkdtempSync(acmeDir)
    const entries = Array.from({ length: 13 }, (_, index) => entry(
      index === 0 ? '@acme/plugin' : `@acme/plugin/sub${String(index)}`,
      `entry-${String(index)}`,
      index === 0 ? { title: { en: 'Acme', zh: '插件' } } : undefined,
    ))
    const text = renderPluginReferenceContext(
      [{ packageName: '@acme/plugin', label: 'Acme' }],
      snapshot(entries),
      { ...services, pluginPackages: { resolution: resolution(acmeDir, '1.2.3') } },
      undefined,
    )
    expect(text).toContain('## Referenced plugins')
    const data = payload(text)
    expect(data.profileDir).toBe('/profiles/web')
    expect(data.patchPath).toBe('/profiles/web/cordis.patch.yml')
    expect(data.plugins).toHaveLength(1)
    expect(data.plugins[0]).toMatchObject({
      packageName: '@acme/plugin',
      label: 'Acme',
      title: { en: 'Acme', zh: '插件' },
      version: '1.2.3',
      scope: 'profile',
      packageDir: acmeDir,
      manifestPath: join(acmeDir, 'package.json'),
      linkedRoot: '/src/acme-plugin',
      entryCount: 13,
      entriesTruncated: true,
    })
    expect(data.plugins[0]?.readmePath).toBeUndefined()
    expect(data.plugins[0]?.entries).toHaveLength(12)
    expect(data.plugins[0]?.insideWorkspace).toBeUndefined()
  })

  it('probes an existing README and marks a package inside the workspace', () => {
    const pkgDir = mkdtempSync(join(tempRoot, 'inside-'))
    writeFileSync(join(pkgDir, 'README.md'), '# Inside\n')
    const data = payload(renderPluginReferenceContext(
      [{ packageName: '@acme/plugin' }],
      snapshot([entry('@acme/plugin', 'short', { title: { en: 'Acme' } })]),
      { ...services, pluginPackages: { resolution: resolution(pkgDir, undefined) } },
      tempRoot,
    ))
    expect(data.plugins[0]).toMatchObject({
      label: '@acme/plugin',
      title: { en: 'Acme' },
      packageDir: pkgDir,
      readmePath: join(pkgDir, 'README.md'),
      insideWorkspace: true,
    })
    expect(data.plugins[0]?.version).toBeUndefined()
  })

  it('keeps an unresolved package visible with an explicit error', () => {
    const data = payload(renderPluginReferenceContext(
      [{ packageName: '@acme/missing', label: 'Missing' }],
      snapshot([]),
      { pluginPackages: { resolution: resolution(undefined, undefined) } },
      undefined,
    ))
    expect(data.profileDir).toBeUndefined()
    expect(data.patchPath).toBeUndefined()
    expect(data.plugins[0]).toMatchObject({ packageName: '@acme/missing', label: 'Missing', entryCount: 0, error: 'not installed in this profile' })
    expect(data.plugins[0]?.entries).toEqual([])
  })
})

describe('plugin reference expansion', () => {
  const pkgDir = join(tempRoot, 'expand')
  mkdtempSync(pkgDir)
  const mention = formatPluginMention({ packageName: '@acme/plugin', label: 'Acme' })
  const inventory = snapshot([entry('@acme/plugin', 'entry', { title: { en: 'Acme' } })])

  function message(text: string): UserMessage {
    return createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
  }

  it('returns messages untouched when nothing cites a plugin', async () => {
    const original = [message('plain text')]
    await expect(expandPluginReferenceMessages(undefined, original, new AbortController().signal, async () => inventory, {}))
      .resolves.toEqual(original)
  })

  it('replaces the mention and appends one untrusted context message', async () => {
    const original = message(`Use ${mention} and ${mention} now`)
    const expanded = await expandPluginReferenceMessages(
      undefined,
      [original],
      new AbortController().signal,
      async () => inventory,
      { pluginPackages: { resolution: resolution(undefined, undefined) } },
    )
    expect(expanded).toHaveLength(2)
    expect(expanded[0]?.content).toEqual([{ type: 'text', text: 'Use @Acme and @Acme now' }])
    expect(expanded[1]?.source).toEqual({
      kind: 'plugin-reference',
      form: 'recall',
      version: 1,
      packages: [{ packageName: '@acme/plugin', label: 'Acme' }],
    })
    expect(expanded[1]?.content[0]).toMatchObject({ type: 'text' })
    expect(expanded[0]?.id).toBe(original.id)
  })

  it('handles non-text blocks and unlabeled references', async () => {
    const mentionWithoutLabel = formatPluginMention({ packageName: '@acme/plugin' })
    const mixed = createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: mentionWithoutLabel }, { type: 'reasoning', text: 'thinking' }],
    })
    const expanded = await expandPluginReferenceMessages(
      undefined,
      [mixed],
      new AbortController().signal,
      async () => inventory,
      {},
    )
    expect(expanded[0]?.content).toEqual([{ type: 'text', text: '@@acme/plugin' }, { type: 'reasoning', text: 'thinking' }])
    expect(expanded[1]?.source).toMatchObject({ packages: [{ packageName: '@acme/plugin', label: '@acme/plugin' }] })
  })

  it('skips non-user messages and omits references beyond the bound', async () => {
    const nonUser = createUserMessage({
      source: { kind: 'system-prompt' },
      content: [{ type: 'text', text: mention }],
    })
    const many = Array.from({ length: 10 }, (_, index) => formatPluginMention({
      packageName: `@acme/plugin${String(index)}`,
      label: `Plugin ${String(index)}`,
    })).join(' ')
    const expanded = await expandPluginReferenceMessages(
      undefined,
      [nonUser, message(many)],
      new AbortController().signal,
      async () => inventory,
      {},
    )
    expect(expanded).toHaveLength(3)
    expect(expanded[0]).toBe(nonUser)
    expect(expanded[1]?.content).toEqual([{ type: 'text', text: Array.from({ length: 10 }, (_, index) => `@Plugin ${String(index)}`).join(' ') }])
    const source = expanded[2]?.source
    expect(source?.kind).toBe('plugin-reference')
    expect(source?.kind === 'plugin-reference' ? source.packages : []).toHaveLength(8)
    expect(expanded[2]?.content[0]).toMatchObject({ type: 'text' })
    expect(JSON.stringify(expanded[2]?.content)).toContain('omitted 2 additional plugin reference(s)')
  })

  it('rejects an already-aborted turn before reading inventory', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(expandPluginReferenceMessages(undefined, [message(mention)], controller.signal, async () => inventory, {}))
      .rejects.toThrow()
  })
})

describe('plugin reference installation', () => {
  it('registers a prepend listener and expands accepted messages', async () => {
    const dispose = vi.fn()
    let listener: Parameters<Parameters<typeof installPluginReference>[0]['on']>[1] | undefined
    const options: unknown[] = []
    const remove = installPluginReference({
      on: (event, registered, settings) => {
        expect(event).toBe('agent/pre-step')
        listener = registered
        options.push(settings)
        return dispose
      },
    }, async () => snapshot([entry('@acme/plugin', 'entry')]), {})
    expect(remove).toBe(dispose)
    expect(options).toEqual([{ prepend: true }])
    const message = createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: formatPluginMention({ packageName: '@acme/plugin' }) }],
    })
    const result = await listener?.(
      { agent: { session: { header: { cwd: undefined } } }, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [message] }),
    )
    expect(result?.kind).toBe('enter')
    expect(result?.kind === 'enter' ? result.messages : []).toHaveLength(2)
    const rejected = await listener?.(
      { agent: { session: { header: { cwd: undefined } } }, signal: new AbortController().signal },
      async () => ({ kind: 'reject' }),
    )
    expect(rejected).toEqual({ kind: 'reject' })
  })
})
