/** File reconciliation and persistence results through real Loader entries. */
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context, FiberState } from '@deepseek-ai/cordis'
import Loader, { Group, type EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { expect, it, onTestFinished, vi } from 'vitest'

const row = (id: string, value: number): EntryOptions => ({ id, name: 'cordis:example', config: { value } })

// File rows may omit ids; Include assigns them.
async function fixture(data: Array<Omit<EntryOptions, 'id'> & { id?: string }>) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-include-journal-'))
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await rm(dir, { recursive: true, force: true, maxRetries: 3 })
  })
  ctx.baseUrl = pathToFileURL(dir).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.builtins.group = Group
  ctx.loader.builtins.example = () => {}
  const filename = join(dir, 'root.json')
  await writeFile(filename, JSON.stringify(data))
  const id = await ctx.loader.create({ name: 'cordis:include', config: { path: './root.json' } })
  await ctx.loader.await()
  const include = ctx.loader.resolve(id).subtree as Include
  const read = async () => JSON.parse(await readFile(filename, 'utf8')) as EntryOptions[]
  const edit = (entries: EntryOptions[]) => writeFile(filename, JSON.stringify(entries))
  const update = (id: string, value: number) => include.update(id, { config: { value } })
  const value = (id: string) => (include.store[id]!.fiber!.effectiveConfig as { value: number }).value
  return { ctx, dir, filename, id, include, read, edit, update, value }
}

it.each(['refresh-first', 'update-first'] as const)('merges independent file and runtime edits with %s ordering', async (order) => {
  const app = await fixture([row('a', 1), row('b', 1)])
  await app.edit([row('a', 1), row('b', 3)])
  if (order === 'refresh-first') await Promise.all([app.include.refresh(), app.update('a', 2)])
  else await Promise.all([app.update('a', 2), app.include.refresh()])
  await app.include.flush()
  expect(app.value('a')).toBe(2)
  expect(app.value('b')).toBe(3)
  expect(await app.read()).toEqual([row('a', 2), row('b', 3)])
})

it('lets the file win a conflicting config edit and reports the conflict', async () => {
  const app = await fixture([row('a', 1)])
  const error = vi.spyOn(app.include.ctx.logger, 'error')
  await app.edit([row('a', 3)])
  await app.update('a', 2)
  await app.include.flush()
  expect(app.value('a')).toBe(3)
  expect(await app.read()).toEqual([row('a', 3)])
  expect(error.mock.calls.some(([message]) => String(message).includes('config conflict'))).toBe(true)
})

it('retains unsaved edits across a missing or invalid file and clears failure after recovery', async () => {
  const app = await fixture([row('a', 1)])
  await rm(app.filename)
  await app.update('a', 2)
  await expect(app.include.flush()).rejects.toThrow('unsaved change')
  await expect(readFile(app.filename)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(app.value('a')).toBe(2)
  await writeFile(app.filename, '{')
  await expect(app.include.refresh()).rejects.toThrow('failed to parse')
  expect(await readFile(app.filename, 'utf8')).toBe('{')
  await app.edit([row('a', 1), row('b', 1)])
  await app.include.refresh()
  await expect(app.include.flush()).resolves.toBeUndefined()
  expect(await app.read()).toEqual([row('a', 2), row('b', 1)])
})

it('routes patch-owned fields and inserted rows into the parent file', async () => {
  const app = await fixture([])
  const inner = join(app.dir, 'inner.json')
  const original = JSON.stringify([row('a', 1)])
  await writeFile(inner, original)
  const id = await app.include.create({ name: 'cordis:include', config: {
    path: './inner.json', patches: [{ id: 'a', disabled: true }, { insert: [row('b', 1)] }],
  } })
  await app.ctx.loader.await()
  const child = app.ctx.loader.resolve(id).subtree as Include
  await child.update('a', { disabled: false })
  await child.update('b', { config: { value: 2 } })
  await child.flush()
  await app.include.flush()
  expect(await readFile(inner, 'utf8')).toBe(original)
  expect((await app.read())[0]!.config).toEqual({ path: './inner.json', patches: [
    { id: 'a', disabled: false }, { insert: [row('b', 2)] },
  ] })
  expect(child.store.a!.fiber!.effectiveConfig).toEqual({ value: 1 })
  expect(child.store.b!.fiber!.effectiveConfig).toEqual({ value: 2 })
})

// Windows does not implement POSIX write permission bits.
it.skipIf(process.platform === 'win32')('retains read-only file changes until a writable retry succeeds', async () => {
  const app = await fixture([row('a', 1)])
  try {
    await chmod(app.filename, 0o444)
    await app.update('a', 2)
    await expect(app.include.flush()).rejects.toThrow('unsaved change')
    expect(await app.read()).toEqual([row('a', 1)])
    expect(app.value('a')).toBe(2)
  } finally {
    await chmod(app.filename, 0o644)
  }
  await app.include.flush()
  expect(await app.read()).toEqual([row('a', 2)])
})

it('preserves file text on file-driven removal and drains runtime edits before shutdown', async () => {
  const app = await fixture([row('a', 1), row('b', 1)])
  const edited = JSON.stringify([row('a', 1)], null, 4) + '\n'
  await writeFile(app.filename, edited)
  await app.include.refresh()
  expect(app.include.store.b).toBeUndefined()
  expect(await readFile(app.filename, 'utf8')).toBe(edited)
  await app.update('a', 2)
  await app.include.stop()
  expect(await app.read()).toEqual([row('a', 2)])
})

it('keeps persisted runtime edits when the Include config changes', async () => {
  const app = await fixture([row('a', 1)])
  await app.include.update('a', { disabled: true })
  await app.include.flush()
  await app.ctx.loader.update(app.id, { config: { path: './root.json', enableLogs: true } })
  await app.include.flush()
  expect(app.include.store.a!.fiber?.state).not.toBe(FiberState.ACTIVE)
  expect(await app.read()).toEqual([{ ...row('a', 1), disabled: true }])
})

it('keeps generated ids and fibers for anonymous file and inserted rows across updates', async () => {
  const app = await fixture([{ name: 'cordis:example', config: { value: 1 } }])
  const config = { path: './root.json', patches: [{ insert: [{ name: 'cordis:example', config: { value: 2 } }] }] }
  await app.ctx.loader.update(app.id, { config })
  await app.include.flush()
  const fibers = () => Object.values(app.include.store).map(entry => entry.fiber)
  const before = fibers()
  expect(before).toHaveLength(2)
  await app.ctx.loader.update(app.id, { config: { ...config, enableLogs: true } })
  await app.include.flush()
  await app.include.refresh()
  expect(fibers()).toEqual(before)
  expect(fibers().every((fiber, index) => fiber === before[index])).toBe(true)
})

it('persists a row moved into the Include from another tree as a complete creation', async () => {
  const app = await fixture([{ id: 'g', name: 'cordis:group', group: true, config: [] }])
  const apply = vi.fn()
  app.ctx.loader.builtins.counted = apply
  const id = await app.ctx.loader.create({ name: 'cordis:counted', config: { value: 1 } })
  await app.ctx.loader.await()
  const entry = app.ctx.loader.store[id]!
  await app.ctx.loader.update(id, { config: { value: 2 } }, `${app.id}:g`)
  await app.include.flush()
  await app.ctx.loader.await()
  expect(app.include.store[id] === entry).toBe(true)
  expect(id in app.ctx.loader.store).toBe(false)
  expect(apply).toHaveBeenCalledTimes(2)
  expect(entry.fiber!.state).toBe(FiberState.ACTIVE)
  expect(await app.read()).toEqual([{ id: 'g', name: 'cordis:group', group: true, config: [
    { id, name: 'cordis:counted', config: { value: 2 } },
  ] }])
})

it('rejects a cross-tree move onto an id the destination already holds', async () => {
  const app = await fixture([{ id: 'g', name: 'cordis:group', group: true, config: [row('x', 1)] }])
  await app.ctx.loader.create({ id: 'x', name: 'cordis:example', config: { value: 2 } } as EntryOptions)
  await app.ctx.loader.await()
  await expect(app.ctx.loader.update('x', {}, `${app.id}:g`)).rejects.toThrow('already exists in the target tree')
  expect(app.ctx.loader.root.data.map(options => options.id)).toContain('x')
  expect(app.value('x')).toBe(1)
  await app.include.flush()
  expect(await app.read()).toEqual([{ id: 'g', name: 'cordis:group', group: true, config: [row('x', 1)] }])
})

it('transfers the members of a group moved into the Include', async () => {
  const app = await fixture([{ id: 'g', name: 'cordis:group', group: true, config: [] }])
  const apply = vi.fn()
  app.ctx.loader.builtins.counted = apply
  const outer = await app.ctx.loader.create({ name: 'cordis:group', group: true, config: [] })
  await app.ctx.loader.await()
  const inner = await app.ctx.loader.create({ name: 'cordis:counted', config: { value: 1 } }, outer)
  await app.ctx.loader.await()
  const [group, member] = [app.ctx.loader.store[outer]!, app.ctx.loader.store[inner]!]
  await app.ctx.loader.update(outer, {}, `${app.id}:g`)
  await app.include.flush()
  await app.ctx.loader.await()
  expect(app.include.store[outer] === group && app.include.store[inner] === member).toBe(true)
  expect(outer in app.ctx.loader.store || inner in app.ctx.loader.store).toBe(false)
  expect(group.subgroup!.tree === app.include).toBe(true)
  expect(apply).toHaveBeenCalledOnce()
  expect(await app.read()).toEqual([{ id: 'g', name: 'cordis:group', group: true, config: [
    { id: outer, name: 'cordis:group', group: true, config: [{ id: inner, name: 'cordis:counted', config: { value: 1 } }] },
  ] }])
  app.ctx.loader.remove(`${app.id}:${outer}`)
  await app.include.flush()
  await app.ctx.loader.await()
  expect(member.fiber?.state).not.toBe(FiberState.ACTIVE)
})
