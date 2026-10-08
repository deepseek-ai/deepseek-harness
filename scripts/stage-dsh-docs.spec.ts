import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { stageDshDocs } from './stage-dsh-docs.ts'

const roots: string[] = []

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-stage-docs-'))
  roots.push(root)
  return root
}

function write(root: string, path: string, contents = '# fixture\n'): void {
  const target = join(root, path)
  mkdirSync(join(target, '..'), { recursive: true })
  writeFileSync(target, contents)
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('documentation staging', () => {
  it('copies reader-facing documents and assets without the tooling-owned records', async () => {
    const source = join(temporaryRoot(), 'docs')
    const destination = join(temporaryRoot(), 'cli', 'docs')
    write(source, 'guide/index.md')
    write(source, 'guide/index.zh.md')
    write(source, 'guide/index.i18n.yaml')
    write(source, 'images/diagram.png', 'png')
    write(source, 'persistence-changes/v1/changes.md')
    write(source, 'persistence-changes/README.md')
    write(source, 'AGENTS.md')

    await stageDshDocs(source, destination)

    expect(existsSync(join(destination, 'guide', 'index.md'))).toBe(true)
    expect(existsSync(join(destination, 'guide', 'index.zh.md'))).toBe(true)
    expect(existsSync(join(destination, 'images', 'diagram.png'))).toBe(true)
    expect(existsSync(join(destination, 'AGENTS.md'))).toBe(true)
    expect(existsSync(join(destination, 'guide', 'index.i18n.yaml'))).toBe(false)
    expect(existsSync(join(destination, 'persistence-changes'))).toBe(false)
  })

  it('replaces a previous copy instead of merging into it', async () => {
    const source = join(temporaryRoot(), 'docs')
    const destination = join(temporaryRoot(), 'cli', 'docs')
    write(source, 'kept.md')
    write(destination, 'removed.md')

    await stageDshDocs(source, destination)

    expect(existsSync(join(destination, 'kept.md'))).toBe(true)
    expect(existsSync(join(destination, 'removed.md'))).toBe(false)
  })
})
