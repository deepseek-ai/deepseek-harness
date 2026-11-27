/** The slot scan reads SlotMap merges under both module names of the ui-slots declarations. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { scanSlotFiles, slotDeclarations } from './slot-walk.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it.each([
  ['package root', '@deepseek-ai/dsh-client-ui-slots'],
  ['/client subpath', '@deepseek-ai/dsh-client-ui-slots/client'],
])('reads a SlotMap merge declared under the %s', (_label, moduleName) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-slot-walk-'))
  roots.push(root)
  const files: Record<string, string> = {
    'packages/client/owner/package.json': JSON.stringify({ name: '@fixture/owner' }),
    'packages/client/owner/src/client/slots.ts': [
      `declare module '${moduleName}' {`,
      '  interface SlotMap {',
      '    /** Fixture slot. */',
      "    'fixture.slot': { kind: 'single'; scope: 'root' }",
      '  }',
      '}',
      'export {}',
      '',
    ].join('\n'),
  }
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }

  const scanned = scanSlotFiles(root, ['packages/*/*/src/**/*.ts'])
  expect(scanned.map(file => file.rel)).toEqual(['packages/client/owner/src/client/slots.ts'])
  expect(scanned.flatMap(file => slotDeclarations(file)).map(declaration => [declaration.key, declaration.kind, declaration.scope]))
    .toEqual([['fixture.slot', 'single', 'root']])
})
