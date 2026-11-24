/** Each namespace names the plugin of its row and whether a layer after the profile patch decides the row's config. */
import { readFileSync, writeFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import { configurationFixture } from './configuration-fixture.ts'

const probe = (id: string, config: object) => ({ id, name: 'cordis:probe', config })

async function fixture(options: Parameters<typeof configurationFixture>[0] = {}) {
  const booted = await configurationFixture({ hmr: false, ...options })
  const view = (ns: string) => booted.ctx.settings.describe({ redactSecrets: true }).find(row => row.ns === ns)
  const managed = (): Record<string, boolean> => Object.fromEntries(booted.ctx.configEditor.configuration()
    .map(row => [row.entry.options.id, row.managed]))
  return { ...booted, view, managed }
}

it('names the plugin of the row behind each namespace and whether a home patch decides the row', async () => {
  const { view, managed } = await fixture({
    patch: [{ insert: [probe('mine', { ordinary: 'mine' })] }, { id: 'second', config: { ordinary: 'second', count: 4 } }],
    homePatch: [{ insert: [probe('deployed', { ordinary: 'home' })] }, { id: 'first', config: { ordinary: 'pinned' } }],
  })
  // A row that the profile patch adds or overrides, and a bundle row that no layer changes, are the profile's own.
  expect(view('mine')?.row).toEqual({ plugin: 'cordis:probe', managed: false })
  expect(view('second')?.row).toEqual({ plugin: 'cordis:probe', managed: false })
  expect(view('default-model')?.row).toEqual({ plugin: 'cordis:model', managed: false })
  // The home patch adds one row and replaces the config of another.
  expect(view('deployed')?.row).toEqual({ plugin: 'cordis:probe', managed: true })
  expect(view('first')?.row).toEqual({ plugin: 'cordis:probe', managed: true })
  expect(managed()).toMatchObject({ mine: false, second: false, 'default-model': false, deployed: true, first: true })
})

it('reports a row that a command-line overlay decides, and a profile override that the overlay replaces', async () => {
  const { view } = await fixture({
    patch: [{ id: 'second', config: { ordinary: 'second', count: 4 } }],
    overlay: JSON.stringify([
      { insert: [probe('overlaid', { ordinary: 'overlay' })] },
      { id: 'second', config: { ordinary: 'second', count: 9 } },
    ]),
  })
  expect(view('overlaid')?.row).toEqual({ plugin: 'cordis:probe', managed: true })
  expect(view('second')).toMatchObject({ value: { count: 9 }, row: { plugin: 'cordis:probe', managed: true } })
  expect(view('first')?.row).toEqual({ plugin: 'cordis:probe', managed: false })
})

it('does not report a later layer that sets the config the profile composes', async () => {
  const { view } = await fixture({
    patch: [{ id: 'second', config: { ordinary: 'second', count: 4 } }],
    homePatch: [
      { id: 'second', config: { ordinary: 'second', count: 4 } },
      { id: 'first', config: { ordinary: 'fixed', token: 'private' } },
    ],
  })
  expect(view('second')?.row?.managed).toBe(false)
  expect(view('first')?.row?.managed).toBe(false)
})

it('always reports a bundle row that its file gives no id', async () => {
  const { ctx } = await fixture({ rows: [{ name: 'cordis:probe', config: { ordinary: 'anonymous' } }] })
  const anonymous = ctx.configEditor.configuration().filter(row => !['config-editor', 'settings', 'default-model', 'first', 'second'].includes(row.entry.options.id))
  expect(anonymous.map(row => [row.entry.options.name, row.managed])).toEqual([['cordis:probe', true]])
})

it('refuses a write to the namespace of a row that the home patch adds or overrides', async () => {
  const { ctx, profile } = await fixture({
    homePatch: [{ insert: [probe('deployed', { ordinary: 'home' })] }, { id: 'first', config: { ordinary: 'pinned' } }],
  })
  const before = readFileSync(profile.patchPath, 'utf8')
  for (const ns of ['deployed', 'first']) {
    await expect(ctx.settings.mutate(ns, [{ op: 'set', path: ['count'], value: 9 }]))
      .rejects.toThrow(`Configuration for "${ns}" is overridden by a home patch or command-line overlay`)
  }
  expect(readFileSync(profile.patchPath, 'utf8')).toBe(before)
})

it('advances the revision when the layer that decides a row changes while the row keeps its config', async () => {
  const { ctx, view, profile } = await fixture({ patch: [{ insert: [probe('mine', { ordinary: 'mine' })] }] })
  const revision = view('mine')!.revision
  const updates = vi.fn<(ns: string, revision: number) => void>()
  ctx.on('settings/document-updated', updates)
  // The file is edited by hand and the Loader has not applied it: the row still runs with the previous config.
  writeFileSync(profile.patchPath, JSON.stringify([{ insert: [probe('mine', { ordinary: 'edited by hand' })] }]))
  expect(view('mine')).toMatchObject({ revision: revision + 1, row: { plugin: 'cordis:probe', managed: true } })
  expect(updates.mock.calls).toEqual([['mine', revision + 1]])
})
