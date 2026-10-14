/** Shared profile composition preserves per-entry inheritance and detached results.
 * Work-count spies require Vite-transformed source exports; native ESM namespaces are immutable.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import * as appBoot from '@deepseek-ai/dsh-app-boot'
import { configurationFixture } from './configuration-fixture.ts'

it('shares composition for entries without config overrides while retaining group and insert inheritance', async () => {
  const { ctx, profile, start } = await configurationFixture({ hmr: false })
  await ctx.fiber.dispose()
  writeFileSync(profile.patchPath, JSON.stringify([
    { id: 'first', config: { ordinary: 'fixed', count: 8 } },
    { id: 'first', config: { ordinary: 'fixed', count: 9 } },
    { id: 'second', disabled: false },
    { insert: [
      { id: 'inserted', name: 'cordis:probe', config: { ordinary: 'inserted', count: 3 } },
      { id: 'group', name: 'cordis:group', group: true, config: [
        { id: 'nested', name: 'cordis:probe', config: { ordinary: 'original', count: 4 } },
      ] },
    ] },
    { id: 'inserted', config: { ordinary: 'inserted', count: 7 } },
    { id: 'group', config: [
      { id: 'nested', name: 'cordis:probe', config: { ordinary: 'replacement', count: 6 } },
    ] },
  ]))
  const restored = await start()
  const compose = vi.spyOn(appBoot, 'composeEntries')
  try {
    const rows = restored.configEditor.configuration()
    const inherited = Object.fromEntries(rows.map(row => [row.entry.options.id, row.inherited]))
    expect(inherited).toMatchObject({
      first: { ordinary: 'fixed', token: 'private' },
      second: { ordinary: 'second' },
      inserted: { ordinary: 'inserted', count: 3 },
      nested: { ordinary: 'replacement', count: 6 },
      group: [{ id: 'nested', name: 'cordis:probe', config: { ordinary: 'original', count: 4 } }],
    })
    expect(inherited['first']).not.toHaveProperty('count')
    expect(compose).toHaveBeenCalledTimes(4)
    const nested = rows.find(row => row.entry.options.id === 'nested')!
    nested.inherited['ordinary'] = 'mutated'
    expect(nested.entry.options.config).toMatchObject({ ordinary: 'replacement' })
    expect(restored.configEditor.configuration().find(row => row.entry.options.id === 'nested')!.inherited)
      .toEqual({ ordinary: 'replacement', count: 6 })
  } finally {
    compose.mockRestore()
  }
})

it('recomposes unoverridden entries after bundle changes and returns empty configs when absent', async () => {
  const { ctx, profile } = await configurationFixture({ hmr: false })
  const read = () => ctx.configEditor.configuration()
  const before = read()
  expect(before.find(row => row.entry.options.id === 'config-editor')!.inherited).toEqual({})
  const bundlePath = join(profile.dir, 'node_modules', 'test-bundle', 'cordis.patch.yml')
  const patches = JSON.parse(readFileSync(bundlePath, 'utf8')) as Array<{ insert: Array<{ id: string; config?: object }> }>
  patches[0]!.insert.find(row => row.id === 'second')!.config = { ordinary: 'new bundle value' }
  writeFileSync(bundlePath, JSON.stringify(patches))
  expect(read().find(row => row.entry.options.id === 'second')!.inherited).toEqual({ ordinary: 'new bundle value' })
  expect(before.find(row => row.entry.options.id === 'second')!.inherited).toEqual({ ordinary: 'second' })
  patches[0]!.insert.push({ id: 'second', config: { ordinary: 'duplicate' } })
  writeFileSync(bundlePath, JSON.stringify(patches))
  expect(read().find(row => row.entry.options.id === 'second')!.inherited).toEqual({ ordinary: 'new bundle value' })
})

it.each([0, 13, 190])('bounds composition work for 190 entries with %i config overrides', async (overrideCount) => {
  const { ctx, profile, start } = await configurationFixture({ hmr: false })
  await ctx.fiber.dispose()
  const bundlePath = join(profile.dir, 'node_modules', 'test-bundle', 'cordis.patch.yml')
  const patches = JSON.parse(readFileSync(bundlePath, 'utf8')) as Array<{ insert: Array<{ id: string; config?: object }> }>
  const entries = Array.from({ length: 185 }, (_, index) => ({
    id: `generated-${index}`, name: 'cordis:probe', config: { ordinary: `value-${index}` },
  }))
  patches[0]!.insert.push(...entries)
  writeFileSync(bundlePath, JSON.stringify(patches))
  writeFileSync(profile.patchPath, JSON.stringify(patches[0]!.insert.slice(0, overrideCount).map(entry => ({
    id: entry.id, config: entry.config ?? {},
  }))))
  const restored = await start()
  const compose = vi.spyOn(appBoot, 'composeEntries')
  try {
    const rows = restored.configEditor.configuration()
    expect(rows).toHaveLength(190)
    expect(rows.find(row => row.entry.options.id === 'generated-0')!.inherited).toEqual({ ordinary: 'value-0' })
    expect(compose).toHaveBeenCalledTimes(overrideCount + Number(overrideCount < rows.length))
  } finally {
    compose.mockRestore()
  }
})
