/** Tree mutation reports and detached patch inputs across the Loader/Include upgrade. */
import { Context, FiberState } from '@deepseek-ai/cordis'
import Loader, { Group, type EntryChange, type EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { applyEntryPatches } from '@deepseek-ai/cordis-plugin-include'
import { describe, expect, it, onTestFinished, vi } from 'vitest'

async function fixture() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(Loader)
  ctx.loader.builtins.group = Group
  ctx.loader.builtins.example = () => {}
  const changes: EntryChange[] = []
  vi.spyOn(ctx.loader, 'commit').mockImplementation((change) => { changes.push(change) })
  return { ctx, loader: ctx.loader, changes }
}

describe('Loader tree mutation reports', () => {
  it('reports assigned ids and applied options for create, update, move and remove', async () => {
    const { loader, changes } = await fixture()
    const id = await loader.create({ name: 'cordis:example', config: { value: 1 } })
    await loader.await()
    expect(changes).toHaveLength(1)
    expect(changes[0]).toEqual({ id, group: loader.root, options: loader.resolve(id).options })
    expect(id).not.toBe('')
    const groupId = await loader.create({ name: 'cordis:group', group: true, config: [] })
    await loader.await()
    changes.length = 0
    await loader.update(id, { config: { value: 2 } }, groupId)
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ id, from: loader.root, group: loader.resolveGroup(groupId),
      legacy: { config: { value: 1 } }, options: { config: { value: 2 } } })
    expect(changes[0]!.options).toBe(loader.resolve(id).options)
    changes.length = 0
    await loader.update(id, { config: { value: 3 } })
    expect(changes).toHaveLength(1)
    expect(changes[0]!.from).toBeUndefined()
    changes.length = 0
    const legacy = loader.resolve(id).options
    loader.remove(id)
    await loader.await()
    expect(changes).toEqual([{ id, group: loader.resolveGroup(groupId), legacy }])
    expect(legacy.disabled).toBeUndefined()
  })

  it('reports explicit Fiber saves and self-disposal but ignores child disposal', async () => {
    const { loader, changes } = await fixture()
    const id = await loader.create({ name: 'cordis:example', config: { value: 1 } })
    await loader.await()
    const fiber = loader.resolve(id).fiber!
    changes.length = 0
    await fiber.update({ value: 2 })
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ legacy: { config: { value: 1 } }, options: { config: { value: 2 } } })
    changes.length = 0
    const child = fiber.ctx.plugin(() => {})
    await child
    await child.dispose()
    expect(changes).toEqual([])
    await fiber.dispose()
    expect(changes).toHaveLength(1)
    expect(changes[0]!.options!.disabled).toBe(true)
    expect(changes[0]!.legacy!.disabled).toBeUndefined()
  })

  it('keeps adopted entries and does not report file-driven removal or owner teardown', async () => {
    const { ctx, loader, changes } = await fixture()
    await loader.root.update([
      { id: 'g', name: 'cordis:group', group: true, config: [] },
      { id: 'x', name: 'cordis:example' },
    ])
    await loader.await()
    const target = loader.resolveGroup('g')
    const options = loader.resolve('x').options
    target.data.push(options)
    await target.create(options)
    loader.root.remove('x')
    expect(loader.resolve('x').parent).toBe(target)
    expect(loader.resolve('x').fiber!.state).toBe(FiberState.ACTIVE)
    await target.update([])
    await loader.await()
    expect(loader.store.x).toBeUndefined()
    expect(changes).toEqual([])
    await ctx.fiber.dispose()
    expect(changes).toEqual([])
  })

  it('mounts explicit ids containing the separator without nested-path resolution', async () => {
    const { loader, changes } = await fixture()
    const options: EntryOptions = { id: 'a:b', name: 'cordis:example' }
    await expect(loader.create(options)).resolves.toBe('a:b')
    await loader.await()
    expect(loader.store['a:b']!.fiber!.state).toBe(FiberState.ACTIVE)
    expect(changes).toEqual([{ id: 'a:b', group: loader.root, options }])
    expect(() => loader.resolve('a:b')).toThrow('cannot resolve entry a:b')
  })
})

describe('Include patch data ownership', () => {
  it('detaches file entries even with no patches', () => {
    const data: EntryOptions[] = [{ id: 'x', name: 'example', config: { value: 1 } }]
    const result = applyEntryPatches(data, undefined, vi.fn())
    result[0]!.disabled = true
    ;(result[0]!.config as { value: number }).value = 2
    expect(data).toEqual([{ id: 'x', name: 'example', config: { value: 1 } }])
  })

  it('clones inserted groups and lets later patches address their descendants', () => {
    const insert: EntryOptions[] = [{ id: 'g', name: 'group', group: true,
      config: [{ id: 'x', name: 'example', config: { value: 1 } }] }]
    const warn = vi.fn()
    const result = applyEntryPatches([], [{ insert }, { id: 'x', disabled: true }], warn)
    const children = result[0]!.config as Array<{ disabled?: boolean; config: { value: number } }>
    expect(children[0]!.disabled).toBe(true)
    children[0]!.config.value = 2
    expect(insert[0]!.config).toEqual([{ id: 'x', name: 'example', config: { value: 1 } }])
    expect(warn).not.toHaveBeenCalled()
  })
})
