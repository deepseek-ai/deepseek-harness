/** Real profile patch behavior and reference lifetime. */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import z from '@deepseek-ai/schemastery'
import { configurationFixture as fixture } from './configuration-fixture.ts'

it('persists a model edit, updates the real consumer without remounting, and restores it at restart', async () => {
  const { ctx, profile, start } = await fixture()
  const consumer = ctx.agentDefaultModel
  const fiber = [...ctx.loader.entries()].find(entry => entry.options.id === 'default-model')!.fiber
  await ctx.settings.mutate('default-model', [{ op: 'set', path: ['model'], value: 'changed' }])
  expect([...ctx.loader.entries()].find(entry => entry.options.id === 'default-model')!.fiber === fiber).toBe(true)
  expect(consumer.currentSelection()).toEqual({ provider: 'test', model: 'changed' })
  expect(parse(readFileSync(profile.patchPath, 'utf8'))).toContainEqual({ id: 'default-model', name: 'cordis:model', config: { provider: 'test', model: 'changed' } })
  await ctx.fiber.dispose()
  const restored = await start()
  expect(restored.agentDefaultModel.currentSelection()).toEqual({ provider: 'test', model: 'changed' })
})

it('isolates instances, hides ordinary fields, rejects invalid edits, and redacts secrets', async () => {
  const { ctx, profile } = await fixture()
  const before = readFileSync(profile.patchPath, 'utf8')
  const first = ctx.settings.describe({ redactSecrets: true }).find(row => row.ns === 'first')!
  expect(first.value).toEqual({ count: 2, list: [] })
  expect(first.secrets).toContainEqual({ path: ['token'], set: true })
  expect(JSON.stringify(first)).not.toContain('private')
  await expect(ctx.settings.update('first', { count: 0 })).rejects.toThrow()
  await expect(ctx.settings.update('first', { ordinary: 'changed' })).rejects.toThrow('not volatile')
  expect(readFileSync(profile.patchPath, 'utf8')).toBe(before)
  await ctx.settings.update('first', { count: 5 })
  expect(ctx.settings.describe({ redactSecrets: true }).find(row => row.ns === 'first')!.value).toEqual({ count: 5, list: [] })
  expect(ctx.settings.describe({ redactSecrets: true }).find(row => row.ns === 'second')!.value).toEqual({ count: 2, list: [] })
  await ctx.settings.mutate('first', [{ op: 'unset', path: ['count'] }])
  expect(ctx.settings.describe({ redactSecrets: true }).find(row => row.ns === 'first')!.value).toEqual({ count: 2, list: [] })
})

it('refuses an edit shadowed by a higher home layer', async () => {
  const { ctx, home, profile } = await fixture()
  writeFileSync(join(home, 'cordis.patch.yml'), JSON.stringify([{ id: 'default-model', config: { provider: 'test', model: 'home' } }]))
  const before = readFileSync(profile.patchPath, 'utf8')
  await expect(ctx.settings.update('default-model', { model: 'profile' })).rejects.toThrow('overridden')
  expect(readFileSync(profile.patchPath, 'utf8')).toBe(before)
  expect(ctx.agentDefaultModel.currentSelection().model).toBe('home')
}, 15_000)

it('serializes concurrent writes and refuses stale revisions after external changes', async () => {
  const { ctx, profile } = await fixture()
  const revision = ctx.settings.describe().find(row => row.ns === 'first')!.revision
  const writes = await Promise.allSettled([
    ctx.settings.update('first', { count: 7 }, revision),
    ctx.settings.update('first', { count: 8 }, revision),
  ])
  expect(writes.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  expect(writes.filter(result => result.status === 'rejected')).toHaveLength(1)
  const before = ctx.settings.describe().find(row => row.ns === 'first')!.revision
  writeFileSync(profile.patchPath, JSON.stringify([{ id: 'first', config: { ordinary: 'fixed', count: 9 } }]))
  await expect(ctx.settings.update('first', { count: 10 }, before)).rejects.toThrow('changed since it was read')
  expect(ctx.settings.describe().find(row => row.ns === 'first')!.value).toEqual({ count: 9, list: [] })
})

it('preserves configuration expressions while editing a different live field', async () => {
  const { ctx, profile, start } = await fixture()
  writeFileSync(profile.patchPath, '- id: first\n  config:\n    ordinary: !!js "\'expression-value\'"\n    count: 3\n- id: second\n  config:\n    ordinary: !!js "\'untouched-expression\'"\n')
  await ctx.settings.update('first', { count: 4 })
  const saved = readFileSync(profile.patchPath, 'utf8')
  expect(saved).toContain('!!js')
  expect(saved).toContain('expression-value')
  await ctx.fiber.dispose()
  const restored = await start()
  const entry = [...restored.loader.entries()].find(row => row.options.id === 'first')!
  expect((entry.fiber!.config as { ordinary: string }).ordinary).toBe('expression-value')
  const second = [...restored.loader.entries()].find(entry => entry.options.id === 'second')!
  expect((second.fiber!.config as { ordinary: string }).ordinary).toBe('untouched-expression')
  expect(restored.settings.describe().find(row => row.ns === 'first')!.value).toEqual({ count: 4, list: [] })
})

it('edits array elements and appends without replacing redacted secrets', async () => {
  const { ctx } = await fixture()
  await ctx.settings.update('first', { list: [{ name: 'first', token: 'hidden' }] })
  await ctx.settings.mutate('first', [
    { op: 'set', path: ['list', '0', 'name'], value: 'renamed' },
    { op: 'set', path: ['list', '1'], value: { name: 'second' } },
  ])
  expect(ctx.settings.describe().find(row => row.ns === 'first')!.value).toMatchObject({ list: [{ name: 'renamed', token: 'hidden' }, { name: 'second' }] })
  await ctx.settings.mutate('first', [{ op: 'unset', path: ['list', '1'] }])
  expect(ctx.settings.describe({ redactSecrets: true }).find(row => row.ns === 'first')!.value).toMatchObject({ list: [{ name: 'renamed' }] })
  await expect(ctx.settings.mutate('first', [{ op: 'unset', path: ['ordinary'] }])).rejects.toThrow('not volatile')
})

it('resets a whole form without losing ordinary fields or pinning inherited defaults', async () => {
  const { ctx, profile } = await fixture({ hmr: false })
  await ctx.settings.update('first', { count: 7, list: [{ name: 'custom' }] })
  await ctx.settings.replace('first', {})
  expect(ctx.settings.describe().find(row => row.ns === 'first')!.value).toEqual({ count: 2, token: 'private', list: [] })
  expect(parse(readFileSync(profile.patchPath, 'utf8'))).toEqual([])
  await ctx.settings.update('first', { count: 9 })
  await ctx.settings.mutate('first', [{ op: 'unset', path: [] }])
  expect(parse(readFileSync(profile.patchPath, 'utf8'))).toEqual([])
})

it('rejects non-JSON inputs and invalid array paths without changing the patch', async () => {
  const { ctx, profile } = await fixture({ hmr: false })
  const before = readFileSync(profile.patchPath, 'utf8')
  const circular: unknown[] = []; circular.push(circular)
  const object: Record<string, unknown> = {}; object.self = object
  const custom = Object.create({ constructor: undefined }) as object
  for (const value of [NaN, Infinity, 1n, Symbol('value'), () => {}, new Date(), custom, circular, object, [undefined]]) {
    await expect(ctx.settings.update('first', { count: value })).rejects.toThrow('Config')
  }
  expect(readFileSync(profile.patchPath, 'utf8')).toBe(before)
  await ctx.settings.update('first', { list: [{ name: 'one' }], count: undefined })
  for (const path of [['list', '-1'], ['list', '2'], ['list', '1', 'name']]) {
    await expect(ctx.settings.mutate('first', [{ op: 'set', path, value: 'x' }])).rejects.toThrow('out of range')
  }
  await expect(ctx.settings.mutate('first', [{ op: 'unset', path: ['list', '1'] }])).rejects.toThrow('out of range')
  await expect(ctx.settings.mutate('first', [{ op: 'set', path: [], value: [] }])).rejects.toThrow('plain object')
})

it('refuses missing entries and ordinary-only plugin forms', async () => {
  const { ctx } = await fixture({ hmr: false })
  await expect(ctx.settings.update('missing', {})).rejects.toThrow('No configurable')
  await expect(ctx.settings.update('config-editor', {})).rejects.toThrow('No configurable')
  const entry = ctx.configEditor.entries().find(entry => entry.options.id === 'first')!
  await entry.update({ disabled: true })
  await expect(ctx.configEditor.edit(entry, () => ({}))).rejects.toThrow()
})

it('edits and resets nested fields while retaining ordinary siblings', async () => {
  const schema = z.object({ ordinary: z.string(), nested: z.object({ fixed: z.string().default('fixed'), live: z.number().default(3).volatile() }), count: z.number().default(2).volatile() })
  const { ctx } = await fixture({ schema, hmr: false })
  await ctx.settings.update('first', { nested: { live: 8 }, count: 7 })
  expect(ctx.settings.describe().find(row => row.ns === 'first')!.value).toEqual({ nested: { live: 8 }, count: 7 })
  await expect(ctx.settings.update('first', { nested: { fixed: 'different' } })).rejects.toThrow('not volatile')
  await ctx.settings.update('first', { count: undefined })
  expect(ctx.settings.describe().find(row => row.ns === 'first')!.value).toMatchObject({ count: 7 })
  await ctx.settings.replace('first', {})
  expect(ctx.settings.describe().find(row => row.ns === 'first')!.value).toEqual({ nested: { live: 3 }, count: 2 })
})

it('resets a volatile root and rejects editing ordinary-only schemas', async () => {
  const { ctx } = await fixture({ schema: z.object({ ordinary: z.string(), count: z.number().default(2) }).volatile(), hmr: false })
  await ctx.settings.update('first', { count: 9 })
  await ctx.settings.replace('first', {})
  expect(ctx.settings.describe().find(row => row.ns === 'first')!.value).toMatchObject({ ordinary: 'fixed', count: 2 })
  const ordinary = await fixture({ schema: z.object({ ordinary: z.string() }), hmr: false })
  await expect(ordinary.ctx.settings.update('first', {})).rejects.toThrow('no volatile fields')
})

it('restores the profile patch when a plugin rejects activation after validation', async () => {
  const { ctx, profile } = await fixture({ hmr: false, apply: (_ctx, config) => {
    if ((config as { ordinary: string }).ordinary === 'rejected') throw new Error('activation refused')
  } })
  const entry = ctx.configEditor.entries().find(entry => entry.options.id === 'first')!
  const before = readFileSync(profile.patchPath, 'utf8')
  await expect(ctx.configEditor.edit(entry, raw => ({ ...raw, ordinary: 'rejected' }))).rejects.toThrow()
  expect(readFileSync(profile.patchPath, 'utf8')).toBe(before)
  expect(ctx.settings.describe().find(row => row.ns === 'first')!.value).toMatchObject({ count: 2 })
})

it('invalidates removed forms once and rejects writes held across entry removal', async () => {
  const { ctx } = await fixture({ hmr: false })
  const original = ctx.settings.describe().find(row => row.ns === 'first')!
  const updates: Array<[string, number]> = []
  ctx.on('settings/document-updated', (ns, revision) => { updates.push([ns, revision]) })
  const entry = ctx.configEditor.entries().find(entry => entry.options.id === 'first')!
  entry.parent.remove(entry.options.id)
  expect(ctx.settings.describe().some(row => row.ns === 'first')).toBe(false)
  ctx.settings.describe()
  expect(updates.filter(([ns]) => ns === 'first')).toEqual([['first', original.revision + 1]])
  await expect(ctx.configEditor.edit(entry, raw => raw)).rejects.toThrow('no longer available')
})

it('restores inherited array elements and preserves metadata during a full reset', async () => {
  const { ctx, profile } = await fixture({ hmr: false })
  writeFileSync(profile.patchPath, '- id: first\n  name: cordis:probe\n  disabled: false\n  config:\n    ordinary: fixed\n    token: private\n    count: 8\n- id: second\n  disabled: false\n')
  await ctx.settings.replace('first', {})
  expect(parse(readFileSync(profile.patchPath, 'utf8'))).toEqual([
    { id: 'first', name: 'cordis:probe', disabled: false }, { id: 'second', disabled: false },
  ])
  await ctx.settings.mutate('first', [{ op: 'set', path: ['list', '0'], value: { name: 'one' } }])
  await ctx.settings.mutate('first', [{ op: 'unset', path: ['list', '0', 'token'] }])
  expect(ctx.settings.describe().find(row => row.ns === 'first')!.value).toMatchObject({ list: [{ name: 'one' }] })
  await expect(ctx.settings.update('first', [])).rejects.toThrow('non-plain root')
})

it('resolves group-owned entries and preserves defaults for an entry without raw config', async () => {
  const { ctx, profile } = await fixture({ hmr: false, schema: z.object({ count: z.number().default(2).volatile() }) })
  writeFileSync(profile.patchPath, JSON.stringify([{ insert: [
    { id: 'group', name: 'cordis:group', group: true, config: [{ id: 'nested', name: 'cordis:probe' }] },
    { id: 'unconfigured', name: 'cordis:probe' },
  ] }]))
  await ctx.settings.update('first', { count: 3 })
  expect(ctx.settings.describe().some(row => row.ns === 'nested')).toBe(true)
  await ctx.settings.update('unconfigured', { count: 4 })
  await ctx.settings.replace('unconfigured', {})
  expect(ctx.settings.describe().find(row => row.ns === 'unconfigured')!.value).toEqual({ count: 2 })
  await ctx.settings.mutate('unconfigured', [{ op: 'unset', path: [] }])
})

it('refuses an entry removed by an external bundle edit before commit', async () => {
  const { ctx, profile } = await fixture({ hmr: false })
  const entry = ctx.configEditor.entries().find(row => row.options.id === 'first')!
  const path = join(profile.dir, 'node_modules', 'test-bundle', 'cordis.patch.yml')
  const document = JSON.parse(readFileSync(path, 'utf8')) as Array<{ insert: Array<{ id: string }> }>
  document[0]!.insert = document[0]!.insert.filter(row => row.id !== 'first')
  writeFileSync(path, JSON.stringify(document))
  await expect(ctx.configEditor.edit(entry, raw => raw)).rejects.toThrow('changed during reload')
})

it('refuses an entry disabled after a form was read', async () => {
  const { ctx, profile } = await fixture({ hmr: false })
  const entry = ctx.configEditor.entries().find(row => row.options.id === 'first')!
  writeFileSync(profile.patchPath, '- id: first\n  disabled: true\n')
  await expect(ctx.settings.update('first', { count: 8 })).rejects.toThrow('no longer configurable')
  expect(ctx.settings.describe().some(row => row.ns === 'first')).toBe(false)
  await expect(ctx.configEditor.edit(entry, raw => raw)).rejects.toThrow('no longer active')
})

it('edits schema-default array rows without dropping secrets and removes rows instead of restoring them', async () => {
  const schema = z.object({
    ordinary: z.string(),
    rows: z.array(z.object({ name: z.string(), token: z.string().role('secret') }))
      .default([{ name: 'default', token: 'private-default' }]).volatile(),
  })
  const { ctx } = await fixture({ schema, hmr: false })
  await ctx.settings.mutate('first', [{ op: 'set', path: ['rows', '0', 'name'], value: 'edited' }])
  expect(ctx.settings.describe().find(row => row.ns === 'first')!.value).toEqual({ rows: [{ name: 'edited', token: 'private-default' }] })
  await ctx.settings.mutate('first', [{ op: 'unset', path: ['rows', '0'] }])
  expect(ctx.settings.describe().find(row => row.ns === 'first')!.value).toEqual({ rows: [] })
})

it('edits dictionary keys and creates optional live containers', async () => {
  const { ctx } = await fixture({ hmr: false, schema: z.object({
    bag: z.any().volatile(), providers: z.dict(z.object({ endpoint: z.string() })).volatile(),
  }) })
  await ctx.settings.mutate('first', [
    { op: 'set', path: ['bag', 'key'], value: 'value' },
    { op: 'set', path: ['providers', 'one', 'endpoint'], value: 'https://example.test' },
  ])
  expect(ctx.settings.describe().find(row => row.ns === 'first')!.value).toEqual({
    bag: { key: 'value' }, providers: { one: { endpoint: 'https://example.test' } },
  })
  await ctx.settings.mutate('first', [{ op: 'unset', path: ['bag', 'missing', 'nested', 'key'] }])
  const ordinary = await fixture({ schema: z.object({ ordinary: z.string() }), hmr: false })
  expect(ordinary.ctx.settings.describe().some(row => row.ns === 'first')).toBe(false)
})

it('restores an inherited secret without returning it to remote forms', async () => {
  const { ctx } = await fixture({ hmr: false })
  await ctx.settings.update('first', { token: 'changed' })
  await ctx.settings.mutate('first', [{ op: 'unset', path: ['token'] }])
  expect(ctx.settings.describe().find(row => row.ns === 'first')!.value).toMatchObject({ token: 'private' })
  expect(JSON.stringify(ctx.settings.describe({ redactSecrets: true }))).not.toContain('private')
})

it('does not publish a queued form refresh after disposal', async () => {
  const { ctx } = await fixture({ hmr: false })
  ctx.settings.describe()
  const entries = ctx.configEditor.entries()
  const settings = entries.find(row => row.options.id === 'settings')!
  const updates: string[] = []
  ctx.on('settings/document-updated', (ns) => { updates.push(ns) })
  ctx.emit('app-boot/config-reload')
  await settings.fiber!.dispose()
  await Promise.resolve()
  expect(updates).toEqual([])
})

it('defaults to automatic pages and applies reversible presentation policy to only the caller instance', async () => {
  const { ctx } = await fixture({ hmr: false })
  const first = ctx.configEditor.entries().find(entry => entry.options.id === 'first')!
  const read = (id: string) => ctx.settings.describe().find(view => view.ns === id)!
  expect(read('first').autoGenerate).toBe(true)
  expect(read('second').autoGenerate).toBe(true)
  const settings = first.fiber!.ctx.get('settings')!
  const dispose = settings.configure({ auto: false })
  expect(read('first').autoGenerate).toBe(false)
  expect(read('second').autoGenerate).toBe(true)
  expect(() => settings.configure({ auto: true })).toThrow('already configured')
  await ctx.settings.update('first', { count: 4 })
  expect(read('first').value).toMatchObject({ count: 4 })
  dispose()
  expect(read('first').autoGenerate).toBe(true)
  const disposeNext = settings.configure({ auto: false })
  dispose()
  expect(read('first').autoGenerate).toBe(false)
  disposeNext()
})

it('registers optional presentation policy after Settings loads and removes it with the caller', async () => {
  const { ctx } = await fixture({ hmr: false, apply: (plugin) => {
    plugin.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, plugin.fiber)) })
  } })
  await ctx.loader.await()
  await vi.waitFor(() => { expect(ctx.settings.describe().find(view => view.ns === 'first')!.autoGenerate).toBe(false) })
  const provider = ctx.configEditor.entries().find(entry => entry.options.id === 'settings')!
  const entry = ctx.configEditor.entries().find(entry => entry.options.id === 'first')!
  const owner = entry.fiber
  await provider.update({ disabled: true })
  expect(ctx.get('settings')).toBeUndefined()
  expect(entry.fiber).toBe(owner)
  await provider.update({ disabled: false })
  await ctx.loader.await()
  expect(entry.fiber).toBe(owner)
  await vi.waitFor(() => { expect(ctx.settings.describe().find(view => view.ns === 'first')!.autoGenerate).toBe(false) })
  await entry.update({ disabled: true })
  expect(ctx.settings.describe().some(view => view.ns === 'first')).toBe(false)
  await entry.update({ disabled: false })
  await ctx.loader.await()
  await vi.waitFor(() => { expect(ctx.settings.describe().find(view => view.ns === 'first')!.autoGenerate).toBe(false) })
})

it('imports the removed settings.yaml into the profile once and keeps rejected sections in the renamed file', async () => {
  const { ctx, home, profile, start } = await fixture()
  await ctx.fiber.dispose()
  const legacy = join(home, 'settings.yaml')
  writeFileSync(legacy, 'default-model:\n  model: legacy\nfirst:\n  ordinary: rejected\nmissing:\n  count: 1\n')
  const restored = await start()
  await vi.waitFor(() => { expect(restored.agentDefaultModel.currentSelection().model).toBe('legacy') })
  expect(parse(readFileSync(profile.patchPath, 'utf8'))).toContainEqual({ id: 'default-model', name: 'cordis:model', config: { provider: 'test', model: 'legacy' } })
  expect(restored.settings.describe({ redactSecrets: true }).find(row => row.ns === 'first')!.value).toEqual({ count: 2, list: [] })
  expect(existsSync(legacy)).toBe(false)
  expect(readFileSync(`${legacy}.imported`, 'utf8')).toContain('rejected')
  // An empty document is renamed without writes; a document that cannot be renamed is reported, not rethrown into boot.
  await restored.fiber.dispose()
  writeFileSync(legacy, '')
  const again = await start()
  await vi.waitFor(() => { expect(readFileSync(`${legacy}.imported`, 'utf8')).toBe('') })
  await again.fiber.dispose()
  writeFileSync(legacy, 'default-model:\n  model: blocked\n')
  rmSync(`${legacy}.imported`)
  mkdirSync(join(home, 'settings.yaml.imported', 'occupied'), { recursive: true })
  const blocked = await start()
  const failures = (): unknown[] => blocked.logger.buffer.filter(message => message.type === 'error').map((message): unknown => message.args[0])
  // The rename fails with EISDIR on POSIX and EPERM on Windows; the reported error names the rename either way.
  await vi.waitFor(() => { expect(failures().some(failure => failure instanceof Error && failure.message.includes('rename'))).toBe(true) })
  expect(blocked.agentDefaultModel.currentSelection().model).toBe('legacy')
})

it('describes an entry whose required field only the profile supplies, and reports a failed refresh instead of crashing', async () => {
  const { ctx, profile, start } = await fixture({
    schema: z.object({ ordinary: z.string(), required: z.string().required(), count: z.number().default(2).volatile() }),
  })
  await ctx.fiber.dispose()
  writeFileSync(profile.patchPath, JSON.stringify([{ id: 'first', config: { required: 'profile', count: 4 } }]))
  const restored = await start()
  const first = restored.settings.describe().find(row => row.ns === 'first')!
  expect(first.value).toEqual({ count: 4 })
  expect(first.base).toEqual({})
  vi.spyOn(restored.settings, 'describe').mockImplementationOnce(() => { throw new Error('refresh failed') })
  restored.emit('app-boot/config-reload')
  const failures = (): unknown[] => restored.logger.buffer.filter(message => message.type === 'error').map((message): unknown => message.args[0])
  await vi.waitFor(() => { expect(failures()).toContainEqual(expect.objectContaining({ message: 'refresh failed' })) })
})
