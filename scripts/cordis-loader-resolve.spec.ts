/** Loader resolves configuration imports in their project when Node internals are unavailable. */
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { existsSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { createResolve } from '../vendor/loader/src/resolve.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const mkdir = vi.fn(actual.mkdir)
  return { ...actual, mkdir, default: { ...actual, mkdir } }
})

async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), 'dsh-cordis-resolve-'))
  onTestFinished(() => fs.rm(root, { recursive: true, force: true }))
  await fs.writeFile(join(root, 'package.json'), JSON.stringify({
    name: 'fixture-app', type: 'module',
    imports: { '#local': './local.js' }, exports: { './sub': './sub.js' },
  }))
  await fs.writeFile(join(root, 'local.js'), 'export const tag = "subpath-import"\n')
  await fs.writeFile(join(root, 'sub.js'), 'export const tag = "self-reference"\n')
  const dep = join(root, 'node_modules', 'fixture-dep')
  await fs.mkdir(dep, { recursive: true })
  await fs.writeFile(join(dep, 'package.json'), JSON.stringify({
    name: 'fixture-dep', type: 'module',
    exports: { '.': { import: './index.js' }, './sub': { import: './sub.js' } },
  }))
  await fs.writeFile(join(dep, 'index.js'), 'export const tag = "bare-dep"\n')
  await fs.writeFile(join(dep, 'sub.js'), 'export const tag = "dependency-subpath"\n')
  await fs.mkdir(join(root, 'src'))
  await fs.writeFile(join(root, 'src', 'plugin.js'), 'export const tag = "relative"\n')
  return { root, baseUrl: pathToFileURL(join(root, 'src', 'cordis.yml')).href }
}

async function treeFor(baseUrl: string) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(Loader, { baseUrl })
  ctx.loader.internal = undefined
  return ctx.loader.root.tree
}

describe('Loader project resolution', () => {
  it('loads import-only dependencies, subpaths and package mappings from the config project', async () => {
    const { root, baseUrl } = await fixture()
    const tree = await treeFor(baseUrl)
    for (const [specifier, tag] of [
      ['fixture-dep', 'bare-dep'], ['fixture-dep/sub', 'dependency-subpath'],
      ['#local', 'subpath-import'], ['fixture-app/sub', 'self-reference'],
    ] as const) {
      expect(await tree.import(specifier)).toMatchObject({ tag })
    }
    expect(existsSync(join(root, '.cordis', 'resolve.mjs'))).toBe(true)
    expect(existsSync(join(root, 'src', '.cordis'))).toBe(false)
    expect(await fs.readFile(join(root, '.cordis', '.gitignore'), 'utf8')).toContain('*')
    await expect(tree.import('fixture-dep/missing')).rejects.toThrow()
  })

  it('keeps project scopes independent and shares concurrent resolution within one scope', async () => {
    const first = await fixture()
    const second = await fixture()
    const [a, b, c] = await Promise.all([
      createResolve(first.baseUrl),
      createResolve(pathToFileURL(join(first.root, 'cordis.yml')).href),
      createResolve(second.baseUrl),
    ])
    expect(a).toBeTypeOf('function')
    expect(a).toBe(b)
    expect(a?.('fixture-dep')).not.toBe(c?.('fixture-dep'))
  })

  it('imports relative, URL and builtin specifiers without changing their identity', async () => {
    const { root, baseUrl } = await fixture()
    const tree = await treeFor(baseUrl)
    expect(await tree.import('./plugin.js')).toMatchObject({ tag: 'relative' })
    expect(existsSync(join(root, '.cordis'))).toBe(false)
    expect(await tree.import(pathToFileURL(join(root, 'local.js')).href)).toMatchObject({ tag: 'subpath-import' })
    expect(await tree.import('node:path')).toMatchObject({ join })
    await expect(tree.import('./missing.js')).rejects.toThrow()
  })

  it('retains native import when helper creation is denied', async () => {
    const { root, baseUrl } = await fixture()
    const tree = await treeFor(baseUrl)
    const denied = vi.mocked(fs.mkdir).mockRejectedValueOnce(Object.assign(new Error('read-only project'), { code: 'EACCES' }))
    onTestFinished(() => { denied.mockReset() })
    expect(await createResolve(baseUrl)).toBeUndefined()
    expect(await tree.import('node:path')).toMatchObject({ join })
    await expect(tree.import('fixture-dep')).rejects.toThrow()
    expect(existsSync(join(root, '.cordis'))).toBe(false)
  })

  it('retains native import without a file-backed package scope', async () => {
    expect(await createResolve(undefined)).toBeUndefined()
    expect(await createResolve('https://example.com/cordis.yml')).toBeUndefined()
    const tree = await treeFor('https://example.com/cordis.yml')
    expect(await tree.import('node:path')).toMatchObject({ join })
  })
})
