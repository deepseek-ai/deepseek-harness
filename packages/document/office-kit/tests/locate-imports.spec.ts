/** The `/locate` entry loads without Cordis, Schemastery, Kit, or the rendering service. */
import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'

it('imports only Node built-in modules as values', async () => {
  const source = (await readFile(new URL('../src/locate.ts', import.meta.url), 'utf8')).replaceAll(/\/\*[\s\S]*?\*\//g, '')
  const imports = [...source.matchAll(/^import\s+(type\s+)?[^'"]*?from\s+'([^']+)'/gm)]
  expect(imports.length).toBeGreaterThan(0)
  const valueImports = imports.filter(([, type]) => type === undefined).map(([, , specifier]) => specifier)
  expect(valueImports.every(specifier => specifier?.startsWith('node:'))).toBe(true)
  expect(source).not.toMatch(/\bimport\s*\(/)
})
