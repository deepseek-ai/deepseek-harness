/**
 * User patch-layer behavior of `dsh-app-boot`: the optional patch-list loader
 * (a profile's `cordis.patch.yml`) and `boot()` applying the user layer over
 * a real Loader tree with live file watching.
 */

import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, onTestFinished, vi } from 'vitest'
import { FSWatcher, type ChokidarOptions } from 'chokidar'
import { Context } from '@deepseek-ai/cordis'
import Hmr from '../src/index.ts'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import {
  boot,
  loadOptionalPatches,
  PROFILE_PATCH_FILENAME,
  reconcileProfilePatches,
} from '@deepseek-ai/dsh-app-boot'

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

describe('profile reconciliation', () => {
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
    const dispose = await ctx.hmr.watchConfig(filename, async () => {
      await reconcileProfilePatches(ctx, [...basePatches, ...loadOptionalPatches(NAME, filename) ?? []], NAME)
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
      const disposeDefault = await ctx.hmr.watchConfig(filename, async () => {
        await reconcileProfilePatches(ctx, loadOptionalPatches(NAME, filename) ?? [], NAME)
      })
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

})
