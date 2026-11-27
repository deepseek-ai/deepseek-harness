/** Row insertion, removal, and config replacement through a real profile, root Include, and Loader. */
import { rmSync, writeFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { FiberState } from '@deepseek-ai/cordis'
import { editorProfile, HEADER, PROBE, TEMPLATE, WAITING } from './profile-fixture.ts'

const RESTORE_WARNING = 'Prior profile patches did not reconcile after a rejected write'

/** The probe row `added` inside a top-level `insert` item. */
const ADDED = '    - id: added\n      name: cordis:probe\n      config: {}\n'

/** A profile override that switches the bundle row `base` off. */
const BASE_OFF = '- id: base\n  disabled: true\n'

it('inserts a row at the end of the profile patch and starts it', async () => {
  const { ctx, starts, row, read } = await editorProfile({ bundle: [{ id: 'base', name: PROBE, config: {} }] })
  await ctx.configEditor.insert({ id: 'added', name: PROBE, config: { label: 'one' } })
  expect(read()).toBe(`${HEADER}- insert:\n    - id: added\n      name: cordis:probe\n      config:\n        label: one\n`)
  expect(row('added').fiber?.state).toBe(FiberState.ACTIVE)
  expect(starts).toEqual([{}, { label: 'one' }])
  expect(Object.fromEntries(ctx.configEditor.configuration().map(({ entry, inserted }) => [entry.options.id, inserted])))
    .toEqual({ base: false, added: true })
})

it('adds a row to a trailing insert item, and a new insert item after a trailing override', async () => {
  const { ctx, row, read } = await editorProfile()
  await ctx.configEditor.insert({ id: 'first', name: PROBE, config: {} })
  await ctx.configEditor.insert({ id: 'second', name: PROBE, config: {} })
  const rows = `${HEADER}- insert:\n    - id: first\n      name: cordis:probe\n      config: {}\n    - id: second\n      name: cordis:probe\n      config: {}\n`
  expect(read()).toBe(rows)
  await ctx.configEditor.editRow(row('first'), () => ({ label: 'edited' }))
  await ctx.configEditor.insert({ id: 'third', name: PROBE, config: {} })
  expect(read()).toBe(`${rows}- id: first\n  name: cordis:probe\n  config:\n    label: edited\n- insert:\n    - id: third\n      name: cordis:probe\n      config: {}\n`)
})

it('creates a missing profile patch and writes a JavaScript expression as a `!!js` scalar', async () => {
  const { ctx, profile, starts, read } = await editorProfile()
  rmSync(profile.patchPath)
  await ctx.configEditor.insert({ id: 'added', name: PROBE, config: { label: { __jsExpr: '1 + 1' } } })
  expect(read()).toBe('- insert:\n    - id: added\n      name: cordis:probe\n      config:\n        label: !!js 1 + 1\n')
  expect(starts).toEqual([{ label: 2 }])
})

it.each([
  ['throws at start', PROBE, { fail: 'refused to start' }, 'added (cordis:probe): Error: refused to start'],
  ['has a config its plugin rejects', PROBE, { invalid: true }, 'invalid is not a probe field'],
  ['waits for a service', WAITING, {}, 'added (cordis:waiting): pending (waiting for service: absentService)'],
])('restores the file and the rows when an inserted row %s', async (_case, name, config, message) => {
  const { ctx, starts, read, warnings } = await editorProfile({ bundle: [{ id: 'base', name: PROBE, config: {} }] })
  await expect(ctx.configEditor.insert({ id: 'added', name, config })).rejects.toThrow(message)
  expect(read()).toBe(TEMPLATE)
  expect(ctx.configEditor.entries().map(entry => entry.options.id)).toEqual(['base'])
  expect(starts).toEqual([{}])
  expect(warnings().flat()).not.toContain(RESTORE_WARNING)
})

it('refuses to insert a row whose id the composed profile uses, also for a row that is switched off', async () => {
  const { ctx, read } = await editorProfile({
    bundle: [{ id: 'base', name: PROBE, config: {} }, { id: 'off', name: PROBE, config: {} }],
    patch: '- id: off\n  disabled: true\n',
  })
  await expect(ctx.configEditor.insert({ id: 'base', name: PROBE, config: {} })).rejects.toThrow('Configuration entry "base" already exists')
  await expect(ctx.configEditor.insert({ id: 'off', name: PROBE, config: {} })).rejects.toThrow('Configuration entry "off" already exists')
  expect(read()).toBe('- id: off\n  disabled: true\n')
})

it('refuses to insert a row whose config the home patch overrides', async () => {
  const { ctx, read } = await editorProfile({ home: '- id: added\n  config:\n    label: home\n' })
  await expect(ctx.configEditor.insert({ id: 'added', name: PROBE, config: { label: 'profile' } }))
    .rejects.toThrow('Configuration for "added" is overridden by a home patch or command-line overlay')
  expect(read()).toBe(TEMPLATE)
  expect(ctx.configEditor.entries()).toEqual([])
})

it('stores an inserted row that the home patch switches off', async () => {
  const { ctx, starts, row, read } = await editorProfile({ home: '- id: added\n  disabled: true\n' })
  await ctx.configEditor.insert({ id: 'added', name: PROBE, config: {} })
  expect(read()).toBe(`${HEADER}- insert:\n${ADDED}`)
  expect(row('added').disabled).toBe(true)
  expect(starts).toEqual([])
})

it('removes an inserted row together with its override, leaving the template', async () => {
  const { ctx, row, read } = await editorProfile()
  await ctx.configEditor.insert({ id: 'added', name: PROBE, config: {} })
  await ctx.configEditor.editRow(row('added'), () => ({ label: 'edited' }))
  await ctx.configEditor.remove(row('added'))
  expect(read()).toBe(TEMPLATE)
  expect(ctx.configEditor.entries()).toEqual([])
})

it('removes one row of several and keeps the other rows, insert items, and overrides', async () => {
  const other = '- insert:\n    - id: other\n      name: cordis:probe\n      config: {}\n- id: other\n  disabled: true\n'
  const kept = '    - id: kept\n      name: cordis:probe\n      config: {}\n'
  const { ctx, row, read } = await editorProfile({ patch: `${other}- insert:\n${ADDED}${kept}- id: added\n  disabled: true\n` })
  await ctx.configEditor.remove(row('added'))
  expect(read()).toBe(`${other}- insert:\n${kept}`)
  expect(ctx.configEditor.entries().map(entry => entry.options.id)).toEqual(['other', 'kept'])
})

it.each([
  ['above the item that takes its place', `# header\n- insert:\n${ADDED}${BASE_OFF}`, `# header\n${BASE_OFF}`],
  ['above the comment of the item that takes its place', `# header\n- insert:\n${ADDED}# about base\n${BASE_OFF}`, `# header\n# about base\n${BASE_OFF}`],
  ['above an emptied list', `# header\n- insert:\n${ADDED}`, '# header\n[]\n'],
  ['after the items that remain', `${BASE_OFF}# about added\n- insert:\n${ADDED}`, `${BASE_OFF}\n# about added\n`],
  ['above a trailing comment', `${BASE_OFF}# about added\n- insert:\n${ADDED}\n# trailing\n`, `${BASE_OFF}\n# about added\n# trailing\n`],
  [
    'after the items that remain, in file order for two removed items',
    `${BASE_OFF}# about added\n- insert:\n${ADDED}# about the override\n- id: added\n  disabled: true\n`,
    `${BASE_OFF}\n# about added\n# about the override\n`,
  ],
])('keeps the comment above a removed item %s', async (_case, patch, expected) => {
  const { ctx, row, read } = await editorProfile({ bundle: [{ id: 'base', name: PROBE, config: {} }], patch })
  await ctx.configEditor.remove(row('added'))
  expect(read()).toBe(expected)
})

it('refuses to remove a row a bundle adds, and keeps its profile override', async () => {
  const patch = '- id: base\n  config:\n    label: profile\n'
  const { ctx, starts, row, read } = await editorProfile({ bundle: [{ id: 'base', name: PROBE, config: {} }], patch })
  await expect(ctx.configEditor.remove(row('base'))).rejects.toThrow('Configuration entry "base" is not a row this profile adds')
  expect(read()).toBe(patch)
  expect(starts).toEqual([{ label: 'profile' }])
})

it('refuses to remove a row that an external edit removed', async () => {
  const { ctx, profile, row } = await editorProfile({ patch: `- insert:\n${ADDED}` })
  const entry = row('added')
  writeFileSync(profile.patchPath, '[]\n')
  await expect(ctx.configEditor.remove(entry)).rejects.toThrow('Configuration entry changed during reload')
  await expect(ctx.configEditor.remove(entry)).rejects.toThrow('Configuration entry is no longer available')
})

it('stores the next config of a row that is switched off as given, without starting the row', async () => {
  const patch = `- insert:\n${ADDED}- id: added\n  disabled: true\n`
  const { ctx, starts, row, read } = await editorProfile({ patch })
  await expect(ctx.configEditor.edit(row('added'), () => ({}))).rejects.toThrow('Configuration entry is no longer available')
  await ctx.configEditor.editRow(row('added'), () => ({ invalid: true }))
  expect(read()).toBe(`${patch}  config:\n    invalid: true\n`)
  expect(row('added').options.config).toEqual({ invalid: true })
  expect(starts).toEqual([])
})

it('stores the next config of a row that an external edit switched off while it ran, without starting the row', async () => {
  const { ctx, profile, starts, row, read } = await editorProfile({ patch: `- insert:\n${ADDED}` })
  const off = `- insert:\n${ADDED}- id: added\n  disabled: true\n`
  writeFileSync(profile.patchPath, off)
  await expect(ctx.configEditor.edit(row('added'), () => ({}))).rejects.toThrow('Configuration plugin is no longer active')
  await ctx.configEditor.editRow(row('added'), () => ({ invalid: true }))
  expect(read()).toBe(`${off}  config:\n    invalid: true\n`)
  expect(row('added').options.config).toEqual({ invalid: true })
  expect(starts).toEqual([{}])
})

it('starts a failed row with its next config', async () => {
  const { ctx, starts, row, read } = await editorProfile({ bundle: [{ id: 'broken', name: PROBE, config: { fail: 'first failure' } }] })
  expect(row('broken').fiber?.state).toBe(FiberState.FAILED)
  await expect(ctx.configEditor.edit(row('broken'), () => ({}))).rejects.toThrow('Configuration plugin is no longer active')
  await ctx.configEditor.editRow(row('broken'), () => ({ label: 'fixed' }))
  expect(read()).toBe(`${HEADER}- id: broken\n  name: cordis:probe\n  config:\n    label: fixed\n`)
  expect(row('broken').fiber?.state).toBe(FiberState.ACTIVE)
  expect(starts).toEqual([{ label: 'fixed' }])
})

it('rejects with the failure of the next config when a failed row fails again, and logs the restoring rejection', async () => {
  const { ctx, row, read, warnings } = await editorProfile({ bundle: [{ id: 'broken', name: PROBE, config: { fail: 'first failure' } }] })
  await expect(ctx.configEditor.editRow(row('broken'), () => ({ fail: 'second failure' }))).rejects.toThrow('broken (cordis:probe): Error: second failure')
  expect(read()).toBe(TEMPLATE)
  expect(row('broken').fiber?.state).toBe(FiberState.FAILED)
  expect(row('broken').options.config).toEqual({ fail: 'first failure' })
  const restoring = expect.stringContaining('broken (cordis:probe): Error: first failure') as string
  expect(warnings()).toContainEqual([RESTORE_WARNING, expect.objectContaining({ message: restoring })])
})

it('validates the next config of an active row, applies it, and restores the row when it does not start', async () => {
  const { ctx, starts, row, read, warnings } = await editorProfile({ bundle: [{ id: 'base', name: PROBE, config: { label: 'bundle' } }] })
  await expect(ctx.configEditor.editRow(row('base'), () => ({ invalid: true }))).rejects.toThrow('invalid is not a probe field')
  expect(read()).toBe(TEMPLATE)
  await ctx.configEditor.editRow(row('base'), () => ({ label: 'profile' }))
  const stored = `${HEADER}- id: base\n  name: cordis:probe\n  config:\n    label: profile\n`
  expect(read()).toBe(stored)
  await expect(ctx.configEditor.editRow(row('base'), () => ({ fail: 'refused to start' }))).rejects.toThrow('base (cordis:probe): Error: refused to start')
  expect(read()).toBe(stored)
  expect(row('base').fiber?.state).toBe(FiberState.ACTIVE)
  expect(starts).toEqual([{ label: 'bundle' }, { label: 'profile' }, { label: 'profile' }])
  expect(warnings().flat()).not.toContain(RESTORE_WARNING)
})

it('refuses the next config of a row that still waits for a service', async () => {
  const { ctx, row, read } = await editorProfile({ bundle: [{ id: 'waiting', name: WAITING, config: {} }] })
  await expect(ctx.configEditor.editRow(row('waiting'), () => ({ label: 'next' })))
    .rejects.toThrow('waiting (cordis:waiting): pending (waiting for service: absentService)')
  expect(read()).toBe(TEMPLATE)
  expect(row('waiting').options.config).toEqual({})
})

it('keeps the file header when an edit resets the first override to the inherited config', async () => {
  const { ctx, row, read } = await editorProfile({
    bundle: [{ id: 'base', name: PROBE, config: {} }],
    patch: `${HEADER}- id: base\n  name: cordis:probe\n  config:\n    label: profile\n`,
  })
  await ctx.configEditor.edit(row('base'), (_current, inherited) => inherited)
  expect(read()).toBe(TEMPLATE)
})
