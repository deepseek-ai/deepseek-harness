import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import { validateGeneratedBundle } from '../src/generated-bundle.ts'
import { writeBundle } from './fixture.ts'

it('admits new package rows and its exports, rejecting edits, duplicates, foreign rows and escaping files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-created-bundle-'))
  const outside = await mkdtemp(join(tmpdir(), 'dsh-outside-bundle-'))
  onTestFinished(async () => { await rm(directory, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }) })
  const name = '@dsh-local/view-test'
  await writeBundle(directory, name)
  await expect(validateGeneratedBundle(directory, name)).resolves.toBeUndefined()
  const patch = join(directory, 'cordis.patch.yml')
  await writeFile(patch, JSON.stringify([{ insert: [{ id: name + ':client', name: name + '/client' }] }]))
  await expect(validateGeneratedBundle(directory, name)).resolves.toBeUndefined()
  for (const rows of [
    [{ insert: [{ id: 'existing', name }] }],
    [{ insert: [{ id: name + ':one', name: 'other-package' }] }],
    [{ insert: [{ id: name + ':one', name }, { id: name + ':one', name }] }],
    [{ remove: 'existing' }], [], [{ insert: [] }],
    [{ insert: [{ id: name + ':group', name, group: true, config: [{ id: 'existing-plugin', name }] }] }],
  ]) {
    await writeFile(patch, JSON.stringify(rows))
    await expect(validateGeneratedBundle(directory, name)).rejects.toThrow()
  }
  await writeBundle(directory, '@dsh-local/wrong-name')
  await expect(validateGeneratedBundle(directory, name)).rejects.toThrow()
  await writeBundle(directory, name)
  await writeBundle(outside, name)
  await rm(patch)
  await symlink(join(outside, 'cordis.patch.yml'), patch)
  await expect(validateGeneratedBundle(directory, name)).rejects.toThrow('remain inside')
})

it('accepts ordinary YAML but rejects custom tags, aliases, missing exports and unbuilt entries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-created-yaml-'))
  onTestFinished(() => rm(directory, { recursive: true, force: true }))
  const name = '@dsh-local/view-yaml'
  await writeBundle(directory, name)
  const path = join(directory, 'cordis.patch.yml')
  await writeFile(path, `- insert:\n    - id: '${name}:counter'\n      name: '${name}'\n`)
  await expect(validateGeneratedBundle(directory, name)).resolves.toBeUndefined()
  for (const text of [
    '- insert: !!js \'process.exit()\'',
    '- insert: !include other.yml',
    `- insert: &rows [{id: '${name}:one', name: '${name}'}]\n- insert: *rows`,
    JSON.stringify([{ insert: [{ id: name + ':one', name: name + '/missing' }] }]),
  ]) {
    await writeFile(path, text)
    await expect(validateGeneratedBundle(directory, name)).rejects.toThrow()
  }
  await writeBundle(directory, name)
  await rm(join(directory, 'index.js'))
  await expect(validateGeneratedBundle(directory, name)).rejects.toThrow()
})

it('keeps an internal relative runtime link usable after copying and deleting the workspace source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-created-link-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'source'), installed = join(root, 'installed')
  await mkdir(source)
  const name = '@dsh-local/view-links'
  await writeBundle(source, name)
  await mkdir(join(source, 'assets'))
  await writeFile(join(source, 'assets', 'note.txt'), 'local asset')
  await writeFile(join(source, 'runtime.mjs'), 'export const value = 42')
  await rm(join(source, 'index.js'))
  await symlink('./runtime.mjs', join(source, 'index.js'))
  await validateGeneratedBundle(source, name)
  await cp(source, installed, { recursive: true, verbatimSymlinks: true })
  await rm(source, { recursive: true })
  await validateGeneratedBundle(installed, name)
  const loaded = await import(pathToFileURL(join(installed, 'index.js')).href) as { value: number }
  expect(loaded.value).toBe(42)
  await symlink(join(installed, 'runtime.mjs'), join(installed, 'absolute.mjs'))
  await expect(validateGeneratedBundle(installed, name)).rejects.toThrow('relative')
})

it('checks explicit, default and legacy subpath entries and refuses source files or directories', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-created-entry-'))
  onTestFinished(() => rm(directory, { recursive: true, force: true }))
  const name = '@dsh-local/view-entries'
  await writeBundle(directory, name)
  const base = { name, version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }
  for (const main of ['./index.js', undefined]) {
    await writeFile(join(directory, 'package.json'), JSON.stringify({ ...base, main }))
    await expect(validateGeneratedBundle(directory, name)).resolves.toBeUndefined()
  }
  await writeFile(join(directory, 'cordis.patch.yml'), JSON.stringify([{ insert: [{ id: name + ':client', name: name + '/index.js' }] }]))
  await expect(validateGeneratedBundle(directory, name)).resolves.toBeUndefined()
  await writeBundle(directory, name)
  for (const exports of [null, { '.': './source.ts' }, { '.': './folder.js' }]) {
    await mkdir(join(directory, 'folder.js'), { recursive: true })
    await writeFile(join(directory, 'package.json'), JSON.stringify({ ...base, exports }))
    await expect(validateGeneratedBundle(directory, name)).rejects.toThrow()
  }
})

it('requires a built ./client export when the package declares a client entry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-created-client-'))
  onTestFinished(() => rm(directory, { recursive: true, force: true }))
  const name = '@dsh-local/view-client'
  await writeBundle(directory, name)
  const manifest = { name, version: '1.0.0', main: './index.js', dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } } }
  await mkdir(join(directory, 'folder.js'))
  for (const exports of [undefined, { '.': './index.js' }, { '.': './index.js', './client': './client.ts' },
    { '.': './index.js', './client': './lib/client.js' }, { '.': './index.js', './client': './folder.js' }]) {
    await writeFile(join(directory, 'package.json'), JSON.stringify({ ...manifest, exports }))
    await expect(validateGeneratedBundle(directory, name)).rejects.toThrow('Build and export the "./client" entry before installation.')
  }
  await mkdir(join(directory, 'lib'))
  await writeFile(join(directory, 'lib', 'client.js'), 'export function apply() {}\n')
  await writeFile(join(directory, 'package.json'), JSON.stringify({ ...manifest, exports: { '.': './index.js', './client': './lib/client.js' } }))
  await expect(validateGeneratedBundle(directory, name)).resolves.toBeUndefined()
  await writeFile(join(directory, 'package.json'), JSON.stringify({ ...manifest, dsh: { ...manifest.dsh, client: 'web' } }))
  await expect(validateGeneratedBundle(directory, name)).rejects.toThrow()
})
