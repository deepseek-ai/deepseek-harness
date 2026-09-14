/** File reload and overlay behavior through the booted Include tree. */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Include } from '@deepseek-ai/cordis-plugin-include'
import { boot } from '../src/index.ts'

const NAME = 'dsh-test-bin'

const NOOP_PLUGIN = 'export const name = "noop"\nexport function apply() {}\n'

const tempRoots: string[] = []
afterAll(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface TreeFixture {
  ctx: Context
  dir: string
  include: Include
}

async function bootTree(configBody: string, files: Record<string, string> = {}): Promise<TreeFixture> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-config-reload-'))
  tempRoots.push(dir)
  writeFileSync(join(dir, 'noop.mjs'), NOOP_PLUGIN)
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content)
  writeFileSync(join(dir, 'cordis.yml'), configBody)
  const ctx = await boot(NAME, join(dir, 'cordis.yml'))
  const entry = [...ctx.loader.entries()].find(candidate => candidate.subtree !== undefined)
  if (entry?.subtree === undefined) throw new Error('booted tree has no include entry')
  return { ctx, dir, include: entry.subtree as Include }
}

function entryConfig(ctx: Context, id: string): unknown {
  return [...ctx.loader.entries()].find(entry => entry.options.id === id)?.options.config
}

describe('include refresh with an invalid file', () => {
  it('writes and activates initial entries when an included file is missing', async () => {
    const { ctx, dir } = await bootTree([
      '- id: initialized',
      "  name: 'cordis:include'",
      '  config:',
      '    path: ./created.yml',
      '    initial:',
      '      - id: noop',
      '        name: ./noop.mjs',
      '        config: { value: initial }',
      '',
    ].join('\n'))
    try {
      expect(entryConfig(ctx, 'noop')).toEqual({ value: 'initial' })
      expect(readFileSync(join(dir, 'created.yml'), 'utf8')).toContain('id: noop')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps the last good tree instead of throwing, then applies the next valid edit', async () => {
    const { ctx, dir, include } = await bootTree('- id: noop\n  name: ./noop.mjs\n  config:\n    value: 1\n')
    try {
      expect(entryConfig(ctx, 'noop')).toEqual({ value: 1 })

      writeFileSync(join(dir, 'cordis.yml'), 'invalid: [unclosed\n')
      await expect(include.refresh()).resolves.toBeUndefined()
      expect(entryConfig(ctx, 'noop')).toEqual({ value: 1 })

      // An empty file parses to `undefined` without a YAML error; it must be
      // treated exactly like a parse failure, not crash the entry walk.
      writeFileSync(join(dir, 'cordis.yml'), '')
      await expect(include.refresh()).resolves.toBeUndefined()
      expect(entryConfig(ctx, 'noop')).toEqual({ value: 1 })

      writeFileSync(join(dir, 'cordis.yml'), '- id: noop\n  name: ./noop.mjs\n  config:\n    value: 2\n')
      await include.refresh()
      await ctx.loader.await()
      expect(entryConfig(ctx, 'noop')).toEqual({ value: 2 })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('include refresh with overlay patches', () => {
  it('re-applies entry patches and inserted entries on every re-read (parity with initial load)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-config-reload-overlay-'))
    tempRoots.push(dir)
    writeFileSync(join(dir, 'noop.mjs'), NOOP_PLUGIN)
    writeFileSync(join(dir, 'base.yml'), '- id: noop\n  name: ./noop.mjs\n  config:\n    value: base\n')
    writeFileSync(join(dir, 'cordis.yml'), [
      '- id: base',
      "  name: 'cordis:include'",
      '  config:',
      '    path: ./base.yml',
      '    patches:',
      '      - id: noop',
      '        name: ./noop.mjs',
      '        config:',
      '          value: patched',
      '      - insert:',
      '          - id: extra',
      '            name: ./noop.mjs',
      '',
    ].join('\n'))
    const ctx = await boot(NAME, join(dir, 'cordis.yml'))
    try {
      const entry = [...ctx.loader.entries()].find(candidate => candidate.options.id === 'base')
      if (entry?.subtree === undefined) throw new Error('overlay tree has no base include entry')
      const include = entry.subtree as Include
      expect(entryConfig(ctx, 'noop')).toEqual({ value: 'patched' })
      expect(entryConfig(ctx, 'extra')).toBeUndefined()
      expect([...ctx.loader.entries()].some(candidate => candidate.options.id === 'extra')).toBe(true)

      writeFileSync(join(dir, 'base.yml'), '- id: noop\n  name: ./noop.mjs\n  config:\n    value: edited\n')
      await include.refresh()
      await ctx.loader.await()
      expect(entryConfig(ctx, 'noop')).toEqual({ value: 'patched' })
      expect([...ctx.loader.entries()].some(candidate => candidate.options.id === 'extra')).toBe(true)

      // Hot-update of the include entry's own config (the `internal/update`
      // path): the new patches must apply now AND stick for later re-reads —
      // the listener vetoes the fiber restart, so it must persist the new
      // config itself or the next refresh() re-applies the old overlay.
      await entry.update({ config: { path: './base.yml', patches: [{ id: 'noop', name: './noop.mjs', config: { value: 'patched-v2' } }] } })
      await ctx.loader.await()
      expect(entryConfig(ctx, 'noop')).toEqual({ value: 'patched-v2' })
      expect([...ctx.loader.entries()].some(candidate => candidate.options.id === 'extra')).toBe(false)

      writeFileSync(join(dir, 'base.yml'), '- id: noop\n  name: ./noop.mjs\n  config:\n    value: edited-2\n')
      await include.refresh()
      await ctx.loader.await()
      expect(entryConfig(ctx, 'noop')).toEqual({ value: 'patched-v2' })

      // Removing every patch must revert to the file's own values: patching
      // may not bake earlier patch results into the cached parse.
      await entry.update({ config: { path: './base.yml', patches: [] } })
      await ctx.loader.await()
      expect(entryConfig(ctx, 'noop')).toEqual({ value: 'edited-2' })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('include patches layered over one base', () => {
  it('lets a later patch configure or disable a row an earlier patch inserted', async () => {
    // The bundle/user-layer/`--patch` composition: `dsh` includes one root
    // and applies each source as its own patch list at the SAME include
    // level, because patches never cross an include boundary. A later layer
    // must therefore be able to reach a row an earlier layer inserted, or
    // bundle-only rows would be invisible to the user's patch layer.
    const dir = mkdtempSync(join(tmpdir(), 'dsh-config-layered-'))
    tempRoots.push(dir)
    writeFileSync(join(dir, 'noop.mjs'), NOOP_PLUGIN)
    writeFileSync(join(dir, 'base.yml'), '- id: shared\n  name: ./noop.mjs\n  config:\n    value: base\n')
    writeFileSync(join(dir, 'cordis.yml'), [
      '- id: base',
      "  name: 'cordis:include'",
      '  config:',
      '    path: ./base.yml',
      '    patches:',
      // Layer 1 (a bundle layer): patch a base row and add two of its own.
      '      - id: shared',
      '        config:',
      '          value: bundle',
      '      - insert:',
      '          - id: bundle-kept',
      '            name: ./noop.mjs',
      '            config:',
      '              value: bundle-default',
      '          - id: bundle-dropped',
      '            name: ./noop.mjs',
      // Layer 2 (the user): reconfigure one inserted row and disable the other.
      '      - id: bundle-kept',
      '        config:',
      '          value: user',
      '      - id: bundle-dropped',
      '        disabled: true',
      '',
    ].join('\n'))
    const ctx = await boot(NAME, join(dir, 'cordis.yml'))
    try {
      expect(entryConfig(ctx, 'shared')).toEqual({ value: 'bundle' })
      expect(entryConfig(ctx, 'bundle-kept')).toEqual({ value: 'user' })
      const dropped = [...ctx.loader.entries()].find(entry => entry.options.id === 'bundle-dropped')
      expect(dropped?.options.disabled).toBe(true)
      expect(dropped?.fiber).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('best-effort config failure recovery', () => {
  it.each([
    ['import', undefined, undefined],
    ['sync apply', 'export function apply(_ctx, config) { if (config.fail) throw new Error("reload sync failure") }\n', 3],
    ['async apply', 'export async function apply(_ctx, config) { await Promise.resolve(); if (config.fail) throw new Error("reload async failure") }\n', 3],
    ['dependency', 'export const inject = ["reloadMissing"]\nexport function apply() {}\n', 0],
  ] as const)('keeps siblings after a required-id %s failure during HMR', async (_kind, source, state) => {
    const base = '- id: good\n  name: ./noop.mjs\n'
    const { ctx, dir, include } = await bootTree(base, {
      ...source === undefined ? {} : { 'failure.mjs': source },
      'provider.mjs': 'export function apply(ctx) { ctx.provide("reloadMissing", true) }\n',
    })
    try {
      const good = [...ctx.loader.entries()].find(entry => entry.options.id === 'good')!.fiber
      writeFileSync(join(dir, 'cordis.yml'), base + '- id: webserver\n  name: ./failure.mjs\n  config: { fail: true }\n')
      await include.refresh()
      await ctx.loader.await()
      const failed = [...ctx.loader.entries()].find(entry => entry.options.id === 'webserver')!
      expect(failed.fiber?.state).toBe(state)
      expect(good?.state).toBe(2)
      expect(ctx.fiber.state).toBe(2)

      const recovery = `- id: webserver\n  name: ./${source === undefined ? 'noop' : 'failure'}.mjs\n  config: { fail: false }\n`
      const provider = state === 0 ? '- id: provider\n  name: ./provider.mjs\n' : ''
      writeFileSync(join(dir, 'cordis.yml'), base + recovery + provider)
      await include.refresh()
      await ctx.loader.await()
      expect([...ctx.loader.entries()].find(entry => entry.options.id === 'webserver')?.fiber?.state).toBe(2)
      expect([...ctx.loader.entries()].find(entry => entry.options.id === 'good')?.fiber).toBe(good)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps the previous fiber config after schema rejection and retries a valid edit', async () => {
    const config = (value: number | string): string => `- id: webserver\n  name: ./schema.mjs\n  config: { value: ${JSON.stringify(value)} }\n`
    const { ctx, dir, include } = await bootTree(config(1), {
      'schema.mjs': [
        'export const Config = { "~standard": { version: 1, vendor: "app-boot-test", validate(config) {',
        '  return typeof config.value === "number" ? { value: config } : { issues: [{ message: "expected number" }] }',
        '} } }',
        'export function apply(ctx, config) { ctx.provide("validatedValue", config.value) }',
        '',
      ].join('\n'),
    })
    try {
      writeFileSync(join(dir, 'cordis.yml'), config('invalid'))
      await include.refresh()
      await ctx.loader.await()
      const entry = [...ctx.loader.entries()].find(candidate => candidate.options.id === 'webserver')!
      expect(entry.options.config).toEqual({ value: 'invalid' })
      expect(entry.fiber?.config).toEqual({ value: 1 })
      expect(ctx.get('validatedValue')).toBe(1)

      writeFileSync(join(dir, 'cordis.yml'), config(2))
      await include.refresh()
      await ctx.loader.await()
      expect(entry.fiber?.config).toEqual({ value: 2 })
      expect(ctx.get('validatedValue')).toBe(2)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('shipped builtins', () => {
  it('lets a booted composition share one isolate realm across a group of rows', async () => {
    // The reason `boot()` registers `cordis:group`: a composition — notably an
    // agent preset living outside this workspace, which cannot resolve
    // `@deepseek-ai/cordis-plugin-group` by name — gives a provider and its consumer one
    // named realm so the service stays out of the root realm while remaining
    // visible to the rows that need it.
    const { ctx } = await bootTree([
      '- id: realm',
      '  name: cordis:group',
      '  isolate:',
      '    demoRealmSvc: true',
      '  config:',
      '    - id: provider',
      '      name: ./provider.mjs',
      '    - id: consumer',
      '      name: ./consumer.mjs',
      '',
    ].join('\n'), {
      'provider.mjs': 'export const name = "provider"\n'
        + 'export function apply(ctx) { ctx.effect(() => ctx.reflect.provide("demoRealmSvc", { tag: "realm" })) }\n',
      'consumer.mjs': 'export const name = "consumer"\n'
        + 'export const inject = ["demoRealmSvc"]\n'
        + 'export function apply(ctx) { globalThis.__REALM_SEEN__ = ctx.get("demoRealmSvc").tag }\n',
    })
    try {
      expect((globalThis as { __REALM_SEEN__?: string }).__REALM_SEEN__).toBe('realm')
      // `provide` mints the root symbol unconditionally (cordis `reflect.ts`),
      // so the name IS in the root realm — pinned here because it is the half
      // that looks like the claim and is not. The claim is the other half: no
      // implementation is stored under that symbol, so the root realm cannot
      // resolve the service and a second composition mounting the same rows
      // cannot collide with this one.
      const rootKey = ctx.root[Context.isolate].demoRealmSvc
      expect(rootKey).toBeDefined()
      expect(ctx.reflect.store[rootKey!]).toBeUndefined()
    } finally {
      delete (globalThis as { __REALM_SEEN__?: string }).__REALM_SEEN__
      await ctx.fiber.dispose()
    }
  })
})
