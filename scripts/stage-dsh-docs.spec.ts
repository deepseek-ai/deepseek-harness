import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanStagedDshDocs, publishedDocuments, stageDshDocs } from './stage-dsh-docs.ts'

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
  it('copies published pages and assets without the internal trees', async () => {
    const source = join(temporaryRoot(), 'docs')
    const destination = join(temporaryRoot(), 'cli', 'docs')
    const published = new Set(['guide/index.md', 'guide/index.zh.md'])
    write(source, 'guide/index.md')
    write(source, 'guide/index.zh.md')
    write(source, 'guide/index.i18n.yaml')
    write(source, 'images/diagram.png', 'png')
    write(source, 'postmortem/incident.md')
    write(source, 'AGENTS.md')
    write(source, 'persistence-changes/v1/changes.md')
    write(source, 'persistence-changes/v1/record.json')
    write(source, 'i18n/terminology.md')

    await stageDshDocs(source, destination, published)

    expect(existsSync(join(destination, 'guide', 'index.md'))).toBe(true)
    expect(existsSync(join(destination, 'guide', 'index.zh.md'))).toBe(true)
    expect(existsSync(join(destination, 'images', 'diagram.png'))).toBe(true)
    for (const excluded of ['guide/index.i18n.yaml', 'postmortem', 'AGENTS.md', 'persistence-changes', 'i18n']) {
      expect(existsSync(join(destination, excluded))).toBe(false)
    }
  })

  it('replaces a previous copy instead of merging into it', async () => {
    const source = join(temporaryRoot(), 'docs')
    const destination = join(temporaryRoot(), 'cli', 'docs')
    write(source, 'kept.md')
    write(destination, 'removed.md')

    await stageDshDocs(source, destination, new Set(['kept.md']))

    expect(existsSync(join(destination, 'kept.md'))).toBe(true)
    expect(existsSync(join(destination, 'removed.md'))).toBe(false)
  })

  it('removes a staged copy', async () => {
    const destination = join(temporaryRoot(), 'cli', 'docs')
    write(destination, 'architecture.md')

    await cleanStagedDshDocs(destination)

    expect(existsSync(destination)).toBe(false)
  })

  it('publishes the website manifest pages and no internal document', () => {
    const published = publishedDocuments()

    expect(published.has('architecture.md')).toBe(true)
    expect(published.has('architecture.zh.md')).toBe(true)
    for (const excluded of ['AGENTS.md', 'testing.md', 'postmortem/README.md', 'persistence-changes/README.md', 'i18n/README.md']) {
      expect(published.has(excluded)).toBe(false)
    }
  })
})
