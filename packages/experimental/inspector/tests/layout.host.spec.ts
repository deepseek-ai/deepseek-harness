/** Host-side source layout invariants. */

import { readdir, readFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url))
const packageRoot = fileURLToPath(new URL('../', import.meta.url))
const testsRoot = fileURLToPath(new URL('./', import.meta.url))

describe('Inspector execution layout', () => {
  it('keeps Client and Host adapters mirrored apart from Client dictionaries and bottom controls', async () => {
    const clientOnly = ['bridge/locales.ts', 'bottom/locales.ts', 'bottom/keyboard.ts']
    const client = await sourceFiles('client')
    expect(clientOnly.every(file => client.includes(file))).toBe(true)
    expect(client.filter(file => !clientOnly.includes(file))).toEqual(await sourceFiles('host'))
  })

  it('keeps Worker Client and Host backend paths mirrored', async () => {
    expect(await sourceFiles('worker/realms/client')).toEqual(await sourceFiles('worker/realms/host'))
  })

  it('keeps shared modules independent of execution-specific directories', async () => {
    await expectNoImports('shared', ['client', 'host', 'worker'])
  })

  it('keeps Client and Host modules isolated from each other and the Worker implementation', async () => {
    await expectNoImports('client', ['host', 'worker'])
    await expectNoImports('host', ['client', 'worker'])
  })

  it('keeps compiler files and specs on their declared execution face', async () => {
    const hostFiles = await compilerFiles('tsconfig.host.json')
    const clientFiles = await compilerFiles('tsconfig.client.json')
    expect(hostFiles.some(file => file.startsWith('src/client/'))).toBe(false)
    expect(clientFiles.some(file => file.startsWith('src/host/') || file.startsWith('src/worker/'))).toBe(false)

    const testFiles = (await walk(testsRoot)).filter(file => file.endsWith('.ts'))
    const specs = testFiles.filter(file => file.endsWith('.spec.ts'))
    expect(specs.every(file => file.endsWith('.host.spec.ts') || file.endsWith('.client.spec.ts'))).toBe(true)
    await expectTestImports(testFiles.filter(file =>
      file.endsWith('.host.ts') || file.endsWith('.host.spec.ts')), ['client'])
    await expectTestImports(testFiles.filter(file =>
      file.endsWith('.client.ts') || file.endsWith('.client.spec.ts')), ['host', 'worker'])
  })

  it('keeps Worker repositories and realm backends independent of the Chrome adapter', async () => {
    await expectNoImports('worker/inspection', ['worker/cdp'])
    await expectNoImports('worker/realms', ['worker/cdp'])
  })
})

async function sourceFiles(directory: string): Promise<string[]> {
  const root = resolve(sourceRoot, directory)
  return (await walk(root))
    .filter(file => file.endsWith('.ts'))
    .map(file => relative(root, file).split(sep).join('/'))
    .sort()
}

async function compilerFiles(config: string): Promise<string[]> {
  const parsed = JSON.parse(await readFile(resolve(packageRoot, config), 'utf8')) as { files?: unknown }
  if (!Array.isArray(parsed.files) || !parsed.files.every(file => typeof file === 'string')) {
    throw new Error(`${config} must declare a string files array`)
  }
  return parsed.files
}

async function expectTestImports(files: readonly string[], forbidden: readonly string[]): Promise<void> {
  for (const file of files) {
    const source = await readFile(file, 'utf8')
    for (const specifier of relativeSpecifiers(source)) {
      const target = resolve(dirname(file), specifier)
      for (const directory of forbidden) {
        const forbiddenRoot = resolve(sourceRoot, directory)
        expect(
          target === forbiddenRoot || target.startsWith(`${forbiddenRoot}${sep}`),
          `${relative(testsRoot, file)} imports ${specifier}`,
        ).toBe(false)
      }
    }
  }
}

async function expectNoImports(owner: string, forbidden: readonly string[]): Promise<void> {
  const root = resolve(sourceRoot, owner)
  for (const file of await walk(root)) {
    if (!file.endsWith('.ts')) continue
    const source = await readFile(file, 'utf8')
    for (const specifier of relativeSpecifiers(source)) {
      const target = resolve(dirname(file), specifier)
      for (const directory of forbidden) {
        const forbiddenRoot = resolve(sourceRoot, directory)
        expect(
          target === forbiddenRoot || target.startsWith(`${forbiddenRoot}${sep}`),
          `${relative(sourceRoot, file)} imports ${specifier}`,
        ).toBe(false)
      }
    }
  }
}

async function walk(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(entries.map(async (entry) => {
    const value = resolve(directory, entry.name)
    return entry.isDirectory() ? await walk(value) : [value]
  }))
  return files.flat()
}

function relativeSpecifiers(source: string): string[] {
  return [...source.matchAll(/(?:from\s+|import\s*\()['"](\.[^'"]+)['"]/gu)].map(match => match[1] ?? '')
}
