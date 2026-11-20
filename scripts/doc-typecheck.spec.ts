/** Markdown compiler-face routing and invalid-example diagnostics through real TypeScript projects. */
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { compileBlocks, extractBlocks } from './doc-typecheck.ts'
import { removeFixtureSafely } from './test-fixture-cleanup.ts'

it('checks Client examples against their JSX project and rejects invalid props without mixing Host types', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-doc-faces-'))
  try {
    for (const face of ['host', 'client'] as const) {
      const extension = face === 'client' ? 'tsx' : 'ts'
      mkdirSync(join(root, face))
      writeFileSync(join(root, face, `index.${extension}`), face === 'client'
        ? 'export interface Props { ready: boolean }\n'
        : 'export interface Props { count: number }\n')
      writeFileSync(join(root, face, 'tsconfig.json'), JSON.stringify({
        compilerOptions: { composite: true, outDir: './lib', types: [], jsx: 'preserve' },
        include: [`index.${extension}`],
      }))
      writeFileSync(join(root, `tsconfig.${face}.json`), JSON.stringify({
        compilerOptions: {
          composite: true,
          noEmit: true,
          strict: true,
          types: [],
          ...(face === 'client' ? { jsx: 'preserve' } : {}),
          paths: { 'fixture-api': [`./${face}/index.${extension}`] },
        },
        references: [{ path: `./${face}` }],
      }))
    }
    const file = join(root, 'README.md')
    const markdown = [
      '# Example', '',
      '```ts',
      "import type { Props } from 'fixture-api'",
      'export const props: Props = { count: 1 }',
      '```',
      '```ts client',
      "import type { Props } from 'fixture-api'",
      'export const props: Props = { ready: true }',
      '```',
      '',
    ].join('\n')
    writeFileSync(file, markdown)
    expect(compileBlocks(extractBlocks(file, root), false, root)).toBeUndefined()
    writeFileSync(file, markdown.replace('ready: true', "ready: 'wrong'"))
    expect(compileBlocks(extractBlocks(file, root), false, root))
      .toContain("README.md (block at line 7, +2:31): error TS2322: Type 'string' is not assignable to type 'boolean'.")
    expect(readdirSync(root).filter(name => name.startsWith('.doc-typecheck-'))).toEqual([])
  } finally {
    removeFixtureSafely(root)
  }
})
