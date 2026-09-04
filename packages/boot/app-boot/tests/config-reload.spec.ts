/**
 * Transactional config replacement through the booted Include and Loader tree.
 * HMR contains rejected refreshes; direct callers receive the error after the
 * previous generation has been retained or restored.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

function entryById(ctx: Context, id: string) {
  const entry = [...ctx.loader.entries()].find(entry => entry.options.id === id)
  if (!entry) throw new Error(`missing loader entry ${id}`)
  return entry
}

function plugin(name: string, body = ''): string {
  return `export default function ${name}(_ctx, config = {}) { ${body} }\n`
}

async function expectUpdateFailure(task: Promise<void>, stage: string): Promise<void> {
  try {
    await task
  } catch (error) {
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain(`failed to ${stage} loader entry`)
    return
  }
  throw new Error(`expected loader update to fail during ${stage}`)
}

describe('include refresh with an invalid file', () => {
  it('rejects while keeping the last good tree, then applies the next valid edit', async () => {
    const { ctx, dir, include } = await bootTree('- id: noop\n  name: ./noop.mjs\n  config:\n    value: 1\n')
    try {
      expect(entryConfig(ctx, 'noop')).toEqual({ value: 1 })

      writeFileSync(join(dir, 'cordis.yml'), 'invalid: [unclosed\n')
      await expect(include.refresh()).rejects.toThrow('failed to parse config file')
      expect(entryConfig(ctx, 'noop')).toEqual({ value: 1 })

      // An empty file parses to `undefined` without a YAML error; it must be
      // treated exactly like a parse failure, not crash the entry walk.
      writeFileSync(join(dir, 'cordis.yml'), '')
      await expect(include.refresh()).rejects.toThrow('failed to validate config file')
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

describe('loader entry replacement', () => {
  it('imports a changed name before replacing the running plugin', async () => {
    const { ctx } = await bootTree('- id: target\n  name: ./old.mjs\n', {
      'old.mjs': plugin('oldPlugin'),
      'new.mjs': plugin('newPlugin'),
    })
    try {
      const entry = entryById(ctx, 'target')
      await entry.update({ name: './new.mjs' })
      expect(entry.options.name).toBe('./new.mjs')
      expect(entry.parent.data.find(options => options.id === 'target')).toBe(entry.options)
      expect(entry.fiber?.runtime?.callback.name).toBe('newPlugin')
      expect(entry.options.disabled).toBeUndefined()
      await entry.fiber?.await()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('retains the running plugin when the replacement cannot be imported', async () => {
    const { ctx } = await bootTree('- id: target\n  name: ./old.mjs\n', {
      'old.mjs': plugin('oldPlugin'),
    })
    try {
      const entry = entryById(ctx, 'target')
      const fiber = entry.fiber
      await expectUpdateFailure(entry.update({ name: './missing.mjs' }), 'import')
      expect(entry.options.name).toBe('./old.mjs')
      expect(entry.fiber === fiber).toBe(true)
      await fiber?.await()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('restores the previous plugin after replacement application fails', async () => {
    const { ctx } = await bootTree('- id: target\n  name: ./old.mjs\n', {
      'old.mjs': plugin('oldPlugin'),
      'bad.mjs': plugin('badPlugin', 'throw new Error("candidate apply failed")'),
    })
    try {
      const entry = entryById(ctx, 'target')
      const previous = entry.fiber
      await expectUpdateFailure(entry.update({ name: './bad.mjs' }), 'apply')
      expect(entry.options.name).toBe('./old.mjs')
      expect(entry.fiber === previous).toBe(false)
      expect(entry.fiber?.runtime?.callback.name).toBe('oldPlugin')
      expect(entry.options.disabled).toBeUndefined()
      await entry.fiber?.await()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('restores the previous config when an in-place restart fails', async () => {
    const { ctx } = await bootTree('- id: target\n  name: ./configurable.mjs\n  config:\n    fail: false\n', {
      'configurable.mjs': plugin('configurablePlugin', 'if (config.fail) throw new Error("candidate config failed")'),
    })
    try {
      const entry = entryById(ctx, 'target')
      const fiber = entry.fiber
      await expectUpdateFailure(entry.update({ config: { fail: true } }), 'apply')
      expect(entry.options.config).toEqual({ fail: false })
      expect(entry.fiber === fiber).toBe(true)
      await fiber?.await()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('does not persist a failed direct fiber update', async () => {
    const { ctx } = await bootTree('- id: target\n  name: ./configurable.mjs\n  config:\n    fail: false\n', {
      'configurable.mjs': plugin('configurablePlugin', 'if (config.fail) throw new Error("candidate config failed")'),
    })
    try {
      const entry = entryById(ctx, 'target')
      const fiber = entry.fiber
      if (!fiber) throw new Error('target entry has no fiber')
      await expect(fiber.update({ fail: true })).rejects.toThrow('candidate config failed')
      expect(entry.options.config).toEqual({ fail: false })
      expect(entry.parent.data.find(options => options.id === 'target')).toBe(entry.options)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('loader tree replacement', () => {
  it('rolls back earlier updates and additions when a later entry fails', async () => {
    const { ctx, dir, include } = await bootTree([
      '- id: existing',
      '  name: ./configurable.mjs',
      '  config:',
      '    value: old',
      '',
    ].join('\n'), {
      'configurable.mjs': plugin('configurablePlugin'),
      'bad.mjs': plugin('badPlugin', 'throw new Error("candidate apply failed")'),
    })
    try {
      writeFileSync(join(dir, 'cordis.yml'), [
        '- id: existing',
        '  name: ./configurable.mjs',
        '  config:',
        '    value: candidate',
        '- id: added',
        '  name: ./noop.mjs',
        '- id: bad',
        '  name: ./bad.mjs',
        '',
      ].join('\n'))
      await expect(include.refresh()).rejects.toThrow('failed to apply loader entry bad')
      expect(entryConfig(ctx, 'existing')).toEqual({ value: 'old' })
      expect([...ctx.loader.entries()].some(entry => entry.options.id === 'added')).toBe(false)
      expect([...ctx.loader.entries()].some(entry => entry.options.id === 'bad')).toBe(false)

      writeFileSync(join(dir, 'cordis.yml'), [
        '- id: existing',
        '  name: ./configurable.mjs',
        '  config:',
        '    value: committed',
        '- id: added',
        '  name: ./noop.mjs',
        '',
      ].join('\n'))
      await include.refresh()
      expect(entryConfig(ctx, 'existing')).toEqual({ value: 'committed' })
      expect(entryById(ctx, 'added').fiber).toBeDefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('stops and restores descendants when an ancestor group is disabled and re-enabled', async () => {
    // No manual builtin registration: `boot()` supplies `cordis:group` beside
    // `cordis:include`, which is what lets a composition give one `isolate`
    // realm to a provider and its consumers together.
    const { ctx, dir, include } = await bootTree('- id: noop\n  name: ./noop.mjs\n')
    try {
      const config = (disabled: boolean) => [
        '- id: parent',
        '  name: cordis:group',
        '  group: true',
        `  disabled: ${disabled}`,
        '  config:',
        '    - id: child',
        '      name: ./noop.mjs',
        '',
      ].join('\n')

      writeFileSync(join(dir, 'cordis.yml'), config(false))
      await include.refresh()
      expect(entryById(ctx, 'child').fiber).toBeDefined()

      writeFileSync(join(dir, 'cordis.yml'), config(true))
      await include.refresh()
      expect(entryById(ctx, 'child').fiber).toBeUndefined()

      writeFileSync(join(dir, 'cordis.yml'), config(false))
      await include.refresh()
      expect(entryById(ctx, 'child').fiber).toBeDefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('restores a programmatic entry move when its update fails', async () => {
    const { ctx } = await bootTree('- id: noop\n  name: ./noop.mjs\n', {
      'movable.mjs': plugin('movablePlugin', 'if (config.fail) throw new Error("candidate config failed")'),
    })
    try {
      const groupId = await ctx.loader.create({ name: 'cordis:group', group: true, config: [] })
      const targetId = await ctx.loader.create({ name: './movable.mjs', config: { fail: false } })
      const target = entryById(ctx, targetId)
      const source = target.parent
      const sourceIndex = source.data.indexOf(target.options)
      const destination = entryById(ctx, groupId).subgroup
      if (!destination) throw new Error('created loader group has no subgroup')

      await expectUpdateFailure(
        ctx.loader.update(targetId, { config: { fail: true } }, groupId),
        'apply',
      )

      expect(target.parent).toBe(source)
      expect(Object.getPrototypeOf(target.ctx)).toBe(source.ctx)
      expect(source.data.indexOf(target.options)).toBe(sourceIndex)
      expect(destination.data).not.toContain(target.options)
      expect(target.options.config).toEqual({ fail: false })
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

      // Omitting the patch list must remove the overlay rather than reuse the
      // Include's previous config through a default parameter.
      await entry.update({ config: { path: './base.yml' } })
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
