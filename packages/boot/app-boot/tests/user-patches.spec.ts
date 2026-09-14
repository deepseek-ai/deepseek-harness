/**
 * User patch-layer behavior of `dsh-app-boot`: the optional patch-list loader
 * (a profile's `cordis.patch.yml`) and `boot()` applying the user layer over
 * a real Loader tree with live file watching.
 */

import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { FSWatcher, type ChokidarOptions } from 'chokidar'
import { Context } from '@deepseek-ai/cordis'
import Hmr from '@deepseek-ai/cordis-plugin-hmr'
import Include, { type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import {
  boot,
  loadOptionalPatches,
  loadOverlayPatches,
  PROFILE_PATCH_FILENAME,
  watchUserPatches,
} from '../src/index.ts'

const NAME = 'dsh-test-bin'

const configWatch = vi.hoisted(() => ({
  create: undefined as ((options?: ChokidarOptions) => FSWatcher) | undefined,
}))

vi.mock('chokidar', async (importOriginal) => {
  const native = await importOriginal<typeof import('chokidar')>()
  return {
    ...native,
    watch: (paths: string | string[], options?: ChokidarOptions) => configWatch.create === undefined
      ? native.watch(paths, options)
      : configWatch.create(options),
  }
})

const tempRoots: string[] = []
afterAll(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-user-patches-'))
  tempRoots.push(dir)
  return dir
}

async function eventually(test: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!test()) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

describe('loadOptionalPatches', () => {
  afterEach(() => {
    delete process.env.DSH_HOME
  })

  it('returns undefined when no user patch file exists', () => {
    expect(loadOptionalPatches(NAME, join(tmp(), PROFILE_PATCH_FILENAME))).toBeUndefined()
  })

  it('parses a patch list and preserves !!js expressions as loader expression nodes', () => {
    const dir = tmp()
    writeFileSync(join(dir, PROFILE_PATCH_FILENAME), [
      '- id: agent-loop',
      "  name: '@deepseek-ai/dsh-agent-loop'",
      '  config:',
      '    model: !!js process.env.DSH_SPEC_MODEL',
      '- insert:',
      '    - id: llm',
      "      name: '@deepseek-ai/dsh-llm-pi-ai'",
      '',
    ].join('\n'))
    const patches = loadOptionalPatches(NAME, join(dir, PROFILE_PATCH_FILENAME))
    expect(patches).toHaveLength(2)
    expect(patches?.[0]).toMatchObject({
      id: 'agent-loop',
      config: { model: { __jsExpr: 'process.env.DSH_SPEC_MODEL' } },
    })
    expect(patches?.[1]?.insert).toHaveLength(1)
  })

  it.each([
    { label: 'optional', load: loadOptionalPatches },
    { label: 'overlay', load: loadOverlayPatches },
  ])('loads absolute plugin paths from patch files as file URLs ($label)', async ({ load }) => {
    const dir = tmp()
    const pluginPath = join(dir, 'absolute #100%.mjs')
    const pluginUrl = pathToFileURL(pluginPath).href
    writeFileSync(pluginPath, 'export function apply(ctx) { ctx.provide("absolutePatchLoaded", true) }\n')
    const patchPath = join(dir, PROFILE_PATCH_FILENAME)
    writeFileSync(patchPath, JSON.stringify([
      { id: 'existing', name: pluginPath },
      { insert: [
        { id: 'absolute', name: pluginPath },
        { id: 'url', name: pluginUrl },
        { id: 'bare', name: '@deepseek-ai/dsh-system-prompt' },
        { id: 'nested', name: 'cordis:group', group: true, config: [
          { id: 'child', name: pluginPath },
        ] },
      ] },
    ]))
    const patches = load(NAME, patchPath)!
    expect(patches[0]?.name).toBe(pluginPath)
    expect(patches[1]?.insert?.map(entry => entry.name)).toEqual([
      pluginUrl, pluginUrl, '@deepseek-ai/dsh-system-prompt', 'cordis:group',
    ])
    expect((patches[1]?.insert?.[3]?.config as { name: string }[])[0]?.name).toBe(pluginUrl)

    const configPath = join(dir, 'cordis.yml')
    writeFileSync(configPath, '[]\n')
    const ctx = await boot(NAME, configPath, [{ insert: [patches[1]!.insert![0]!] }])
    try {
      expect(ctx.get('absolutePatchLoaded')).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('anchors inserted relative plugins to the patch file and keeps assertion names literal', () => {
    const dir = tmp()
    const patchPath = join(dir, PROFILE_PATCH_FILENAME)
    writeFileSync(patchPath, [
      '- id: existing',
      '  name: ./assertion.mjs',
      '- insert:',
      '    - id: rule',
      '      name: ./rule.mjs',
      '    - id: nested',
      '      name: cordis:group',
      '      group: true',
      '      config:',
      '        - id: child',
      '          name: ../child.mjs',
      '',
    ].join('\n'))

    const patches = loadOptionalPatches(NAME, patchPath)
    expect(patches?.[0]?.name).toBe('./assertion.mjs')
    expect(patches?.[1]?.insert?.[0]?.name).toBe(pathToFileURL(join(dir, 'rule.mjs')).href)
    expect((patches?.[1]?.insert?.[1]?.config as { name: string }[])[0]?.name)
      .toBe(pathToFileURL(join(dir, '..', 'child.mjs')).href)
  })

  it('fails loud on an unreadable file (a present user patch layer is never skipped)', () => {
    const dir = tmp()
    mkdirSync(join(dir, PROFILE_PATCH_FILENAME)) // a directory: present, unreadable as a file
    expect(() => loadOptionalPatches(NAME, join(dir, PROFILE_PATCH_FILENAME)))
      .toThrow(new RegExp(`^${NAME}: failed to read patches `))
  })

  it('fails loud on unparsable YAML and on a !!js tag with no expression body', () => {
    const dir = tmp()
    writeFileSync(join(dir, PROFILE_PATCH_FILENAME), 'invalid: [unclosed\n')
    expect(() => loadOptionalPatches(NAME, join(dir, PROFILE_PATCH_FILENAME)))
      .toThrow(new RegExp(`^${NAME}: failed to parse patches `))
    writeFileSync(join(dir, PROFILE_PATCH_FILENAME), '- id: x\n  config:\n    a: !!js\n')
    expect(() => loadOptionalPatches(NAME, join(dir, PROFILE_PATCH_FILENAME)))
      .toThrow(new RegExp(`^${NAME}: failed to parse patches `))
  })

  it('fails loud when the file is not a top-level array or an entry is not an object', () => {
    const dir = tmp()
    writeFileSync(join(dir, PROFILE_PATCH_FILENAME), 'id: not-a-list\n')
    expect(() => loadOptionalPatches(NAME, join(dir, PROFILE_PATCH_FILENAME)))
      .toThrow('must be a top-level YAML array of loader patch entries')
    writeFileSync(join(dir, PROFILE_PATCH_FILENAME), '- just-a-string\n')
    expect(() => loadOptionalPatches(NAME, join(dir, PROFILE_PATCH_FILENAME)))
      .toThrow(`${NAME}: patches entry 1 in`)
  })
})

function writeTree(dir: string, id = 'noop', asyncApply = false): string {
  writeFileSync(join(dir, 'noop.mjs'), [
    'export const name = "noop"',
    `export ${asyncApply ? 'async ' : ''}function apply(_ctx, config = {}) {`,
    '  if (config.fail) throw new Error("candidate config failed")',
    '}',
    '',
  ].join('\n'))
  writeFileSync(join(dir, 'cordis.yml'), `- id: ${id}\n  name: ./noop.mjs\n  config:\n    value: base\n`)
  return join(dir, 'cordis.yml')
}

function entryConfig(ctx: Context, id: string): unknown {
  return [...ctx.loader.entries()].find(entry => entry.options.id === id)?.options.config
}

describe('Loader config interpolation', () => {
  it("keeps Include's config literal — a nested row's !!js belongs to that row's fiber", async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'reader.mjs'), [
      'export const name = "reader"',
      'export function apply(ctx, config) { ctx.provide("observedValue", config.value) }',
      '',
    ].join('\n'))
    writeFileSync(join(dir, 'cordis.yml'), '- id: reader\n  name: ./reader.mjs\n')
    const ctx = new Context()
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    ctx.provide('answer', 42)
    try {
      // The include is a tree carrier: its own config (path, patches) stays
      // literal, and the expression nested inside the patched row's config
      // resolves against the row's fiber, not the include's.
      await ctx.loader.create({
        name: 'cordis:include',
        config: {
          path: pathToFileURL(join(dir, 'cordis.yml')).href,
          patches: [{ id: 'reader', name: './reader.mjs', config: { value: { __jsExpr: "ctx.get('answer')" } } }],
        },
      })
      await ctx.loader.await()
      const reader = [...ctx.loader.entries()].find(entry => entry.options.id === 'reader')
      expect(reader?.options.config).toEqual({ value: { __jsExpr: "ctx.get('answer')" } })
      expect(ctx.get('observedValue')).toBe(42)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('waits for row injections before resolving !!js and resolves again after provider replacement', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'provider.mjs'), [
      'export const name = "provider"',
      'export function apply(ctx, config) { ctx.provide("phaseOne", config) }',
      '',
    ].join('\n'))
    writeFileSync(join(dir, 'reader.mjs'), [
      'export const name = "reader"',
      'export const inject = ["phaseOne"]',
      'export function apply(ctx, config) { ctx.provide("readerResult", config) }',
      '',
    ].join('\n'))
    writeFileSync(join(dir, 'cordis.yml'), '[]\n')
    const composition: PatchOptions[] = [{
      insert: [
        {
          // Consumer-first order proves interpolation follows injection
          // readiness rather than YAML position.
          id: 'reader',
          name: './reader.mjs',
          inject: ['phaseOne'],
          config: { value: { __jsExpr: 'ctx.phaseOne.fail ? (() => { throw new Error("rejected provider") })() : ctx.phaseOne.value' } },
        },
        { id: 'provider', name: './provider.mjs', config: { value: 'first' } },
      ],
    }]
    const ctx = await boot(NAME, join(dir, 'cordis.yml'), composition)
    try {
      expect(ctx.get('readerResult')).toEqual({ value: 'first' })
      const provider = [...ctx.loader.entries()].find(entry => entry.options.id === 'provider')
      expect(provider).toBeDefined()
      await provider?.update({ disabled: true })
      await ctx.loader.await()
      expect(ctx.get('readerResult')).toBeUndefined()
      await provider?.update({ config: { value: 'second' } })
      await provider?.update({ disabled: false })
      await ctx.loader.await()
      expect(ctx.get('readerResult')).toEqual({ value: 'second' })

      await provider?.update({ disabled: true })
      await provider?.update({ config: { fail: true } })
      await provider?.update({ disabled: false })
      await ctx.loader.await()
      const reader = [...ctx.loader.entries()].find(entry => entry.options.id === 'reader')
      await expect(reader?.fiber?.await()).rejects.toThrow('rejected provider')
      expect(ctx.get('readerResult')).toBeUndefined()

      await provider?.update({ disabled: true })
      await provider?.update({ config: { value: 'recovered' } })
      await provider?.update({ disabled: false })
      await ctx.loader.await()
      expect(ctx.get('readerResult')).toEqual({ value: 'recovered' })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('Loader entry disabled interpolation', () => {
  it('evaluates a !!js disabled expression against the loader context', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'noop.mjs'), 'export function apply() {}\n')
    writeFileSync(join(dir, 'cordis.yml'), [
      '- id: expr-off',
      '  name: ./noop.mjs',
      '  disabled: !!js process.version.length > 0',
      '- id: expr-on',
      '  name: ./noop.mjs',
      '  disabled: !!js process.version.length === 0',
      '',
    ].join('\n'))
    const ctx = await boot(NAME, join(dir, 'cordis.yml'))
    try {
      const off = [...ctx.loader.entries()].find(entry => entry.options.id === 'expr-off')
      const on = [...ctx.loader.entries()].find(entry => entry.options.id === 'expr-on')
      expect(off?.disabled).toBe(true)
      expect(off?.fiber).toBeUndefined()
      expect(on?.disabled).toBe(false)
      expect(on?.fiber).toBeDefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps the raw expression in the options so write-back preserves the !!js form', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'noop.mjs'), 'export function apply() {}\n')
    writeFileSync(join(dir, 'cordis.yml'), '- id: expr\n  name: ./noop.mjs\n  disabled: !!js process.platform === "win32"\n')
    const ctx = await boot(NAME, join(dir, 'cordis.yml'))
    try {
      const entry = [...ctx.loader.entries()].find(item => item.options.id === 'expr')
      // The evaluated boolean drives the mount decision; the serialized
      // expression node stays in the options for the file-backed tree.
      expect(entry?.options.disabled).toEqual({ __jsExpr: 'process.platform === "win32"' })
      expect(entry?.disabled).toBe(process.platform === 'win32')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('re-evaluates when update() replaces the expression, mounting and unmounting', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'noop.mjs'), 'export function apply() {}\n')
    writeFileSync(join(dir, 'cordis.yml'), '- id: expr\n  name: ./noop.mjs\n  disabled: !!js process.version.length === 0\n')
    const ctx = await boot(NAME, join(dir, 'cordis.yml'))
    try {
      const entry = [...ctx.loader.entries()].find(item => item.options.id === 'expr')
      expect(entry?.disabled).toBe(false)
      expect(entry?.fiber).toBeDefined()
      // The expression form is the file dialect; the typed programmatic API
      // carries booleans. Include reapplication feeds the raw node through
      // the untyped file path — simulated here with the serialized shape.
      const disabledTrue = { __jsExpr: 'process.version.length > 0' } as unknown as boolean
      const disabledFalse = { __jsExpr: 'process.version.length === 0' } as unknown as boolean
      await entry?.update({ disabled: disabledTrue })
      expect(entry?.disabled).toBe(true)
      await ctx.loader.await()
      expect(entry?.fiber?.uid).toBeNull()
      await entry?.update({ disabled: disabledFalse })
      expect(entry?.disabled).toBe(false)
      expect(entry?.fiber).toBeDefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('boot with user patches', () => {
  it('applies id-targeted overrides, inserts, and interpolates !!js from the environment', async () => {
    const dir = tmp()
    const userDir = tmp()
    writeFileSync(join(userDir, 'noop.mjs'), [
      'export function apply(_ctx, config = {}) {',
      '  if (config.fail) throw new Error("candidate config failed")',
      '}',
      '',
    ].join('\n'))
    writeFileSync(join(userDir, PROFILE_PATCH_FILENAME), [
      '- id: noop',
      '  name: ./noop.mjs',
      '  config:',
      '    value: !!js process.env.DSH_APP_BOOT_USER_SPEC',
      '- insert:',
      '    - id: user-extra',
      '      name: ./noop.mjs',
      '',
    ].join('\n'))
    process.env['DSH_APP_BOOT_USER_SPEC'] = 'user-value'
    const ctx = await boot(NAME, writeTree(dir), loadOptionalPatches(NAME, join(userDir, PROFILE_PATCH_FILENAME)))
    try {
      const noop = [...ctx.loader.entries()].find(entry => entry.options.id === 'noop')
      // The mounted plugin received the interpolated environment value.
      expect(noop?.fiber?.config).toEqual({ value: 'user-value' })
      expect([...ctx.loader.entries()].some(entry => entry.options.id === 'user-extra')).toBe(true)
    } finally {
      await ctx.fiber.dispose()
      delete process.env['DSH_APP_BOOT_USER_SPEC']
    }
  })

  it('mounts no patch layer for an absent or empty user layer', async () => {
    const dir = tmp()
    const ctx = await boot(NAME, writeTree(dir), loadOptionalPatches(NAME, join(tmp(), PROFILE_PATCH_FILENAME)))
    try {
      expect(entryConfig(ctx, 'noop')).toEqual({ value: 'base' })
    } finally {
      await ctx.fiber.dispose()
    }
    const empty = tmp()
    writeFileSync(join(empty, PROFILE_PATCH_FILENAME), '[]\n')
    const ctxEmpty = await boot(NAME, writeTree(tmp()), loadOptionalPatches(NAME, join(empty, PROFILE_PATCH_FILENAME)))
    try {
      expect(entryConfig(ctxEmpty, 'noop')).toEqual({ value: 'base' })
    } finally {
      await ctxEmpty.fiber.dispose()
    }
  })

  it.each([
    { id: 'noop', asyncApply: false },
    { id: 'webserver', asyncApply: false },
    { id: 'webserver', asyncApply: true },
  ])('keeps HMR best effort and recovers ($id, async apply: $asyncApply)', { timeout: 20_000 }, async ({ id, asyncApply }) => {
    const dir = tmp()
    const userDir = tmp()
    const filename = join(userDir, PROFILE_PATCH_FILENAME)
    const basePatches = [{ id, config: { value: 'generated' } }]
    const ctx = await boot(NAME, writeTree(dir, id, asyncApply), basePatches)
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(Timer)
    await ctx.plugin(Hmr, { root: [], ignored: [], debounce: 0 })
    // Native notifications belong to watch-config.spec.ts; this case owns
    // Include recomposition after each explicitly delivered filesystem event.
    const watchers: FSWatcher[] = []
    const previousFactory = configWatch.create
    onTestFinished(() => { configWatch.create = previousFactory })
    configWatch.create = (options) => {
      const watcher = new FSWatcher(options)
      watchers.push(watcher)
      queueMicrotask(() => { watcher.emit('ready') })
      return watcher
    }
    const failures: Error[] = []
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation((value: unknown) => {
      if (value instanceof Error) failures.push(value)
    })
    onTestFinished(() => { warn.mockRestore() })
    const dispose = await watchUserPatches(ctx, {
      binName: NAME,
      filename,
      compose: userPatches => [...basePatches, ...userPatches],
    })
    expect(watchers).toHaveLength(1)
    const watcher = watchers[0]!
    try {
      writeFileSync(filename, `- id: ${id}\n  config:\n    value: live\n`)
      watcher.emit('add', filename)
      await eventually(() => (entryConfig(ctx, id) as { value?: string }).value === 'live', 'user patch addition was not applied')

      writeFileSync(filename, `- id: ${id}\n  config:\n    fail: true\n`)
      watcher.emit('change', filename)
      await eventually(() => failures.length === 1, 'failed candidate was not reported')
      expect(failures[0]).toBeInstanceOf(Error)
      expect(entryConfig(ctx, id)).toMatchObject({ fail: true })

      writeFileSync(filename, `- id: ${id}\n  disabled: !!js "JSON.parse('invalid')"\n`)
      watcher.emit('change', filename)
      await eventually(() => failures.length === 2, 'disabled expression failure was not reported')
      expect(failures[1]?.message).toContain(`${id} (./noop.mjs): disabled expression failed: SyntaxError`)
      expect([...ctx.loader.entries()].find(entry => entry.options.id === id)?.options.disabled)
        .toEqual({ __jsExpr: "JSON.parse('invalid')" })

      writeFileSync(filename, 'invalid: [unclosed\n')
      watcher.emit('change', filename)
      await eventually(() => failures.length === 3, 'parse failure was not reported')
      expect(failures[2]).toBeInstanceOf(Error)
      expect([...ctx.loader.entries()].find(entry => entry.options.id === id)?.options.disabled)
        .toEqual({ __jsExpr: "JSON.parse('invalid')" })

      writeFileSync(filename, `- id: ${id}\n  config:\n    value: recovered\n`)
      watcher.emit('change', filename)
      await eventually(() => (entryConfig(ctx, id) as { value?: string }).value === 'recovered', 'valid recovery was not applied')
      await ctx.loader.await()
      expect([...ctx.loader.entries()].find(entry => entry.options.id === id)?.fiber?.state).toBe(2)

      unlinkSync(filename)
      watcher.emit('unlink', filename)
      await eventually(() => (entryConfig(ctx, id) as { value?: string }).value === 'generated', 'user patch removal did not restore the app-owned patch')
      expect(failures).toHaveLength(3)

      // Default compose: the user layer IS the whole patch list, so a
      // fresh generation replaces the app-owned layer instead of stacking on it.
      await dispose()
      const disposeDefault = await watchUserPatches(ctx, { binName: NAME, filename })
      expect(watchers).toHaveLength(2)
      try {
        writeFileSync(filename, `- id: ${id}\n  config:\n    value: identity\n`)
        watchers[1]!.emit('add', filename)
        await eventually(() => (entryConfig(ctx, id) as { value?: string }).value === 'identity', 'default-compose user patch was not applied')
      } finally {
        await disposeDefault()
      }
    } finally {
      await dispose()
    }
  })

  it('fails loud when the exact watcher lacks HMR or a root Include', async () => {
    const dir = tmp()
    const withoutHmr = await boot(NAME, writeTree(dir))
    await expect(watchUserPatches(withoutHmr, { binName: NAME, filename: join(tmp(), PROFILE_PATCH_FILENAME) })).rejects.toThrow('requires the Cordis HMR service')
    await withoutHmr.fiber.dispose()

    const withoutInclude = new Context()
    withoutInclude.baseUrl = pathToFileURL(`${tmp()}/`).href
    await withoutInclude.plugin(Loader)
    await withoutInclude.plugin(Timer)
    await withoutInclude.plugin(Hmr, { root: [], ignored: [], debounce: 0 })
    await expect(watchUserPatches(withoutInclude, { binName: NAME, filename: join(tmp(), PROFILE_PATCH_FILENAME) })).rejects.toThrow('requires the root Include entry')
    await withoutInclude.fiber.dispose()
  })

  it('returns a no-op disposer when the tree is disposed while the watcher opens', async () => {
    const dir = tmp()
    const ctx = await boot(NAME, writeTree(dir))
    await ctx.plugin(Timer)
    await ctx.plugin(Hmr, { root: [], ignored: [], debounce: 0 })
    const previousFactory = configWatch.create
    onTestFinished(() => { configWatch.create = previousFactory })
    const release = Promise.withResolvers<undefined>()
    ctx.effect(() => () => release.promise)
    let disposal: Promise<void> | undefined
    onTestFinished(async () => { release.resolve(undefined); await disposal })
    configWatch.create = (options) => {
      const watcher = new FSWatcher(options)
      disposal = ctx.fiber.dispose()
      queueMicrotask(() => { watcher.emit('ready') })
      return watcher
    }
    const dispose = await watchUserPatches(ctx, { binName: NAME, filename: join(tmp(), PROFILE_PATCH_FILENAME) })
    await expect(dispose()).resolves.toBeUndefined()
  })

  it('propagates registration failures other than mid-teardown', async () => {
    const dir = tmp()
    const filename = join(tmp(), PROFILE_PATCH_FILENAME)
    const ctx = await boot(NAME, writeTree(dir))
    try {
      await ctx.plugin(Timer)
      await ctx.plugin(Hmr, { root: [], ignored: [], debounce: 0 })
      const dispose = await watchUserPatches(ctx, { binName: NAME, filename })
      // Same user-layer path registered twice: the watcher refuses; not a teardown race.
      await expect(watchUserPatches(ctx, { binName: NAME, filename })).rejects.toThrow('already registered')
      await dispose()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
