import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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
  it('copies published pages, assets, and upgrade guides without the internal trees', async () => {
    const source = join(temporaryRoot(), 'docs')
    const destination = join(temporaryRoot(), 'cli', 'docs')
    const published = new Set(['guide/index.md', 'guide/index.zh.md'])
    write(source, 'guide/index.md')
    write(source, 'guide/index.zh.md')
    write(source, 'guide/index.i18n.yaml')
    write(source, 'images/diagram.png', 'png')
    write(source, 'upgrade-guide/v0.1.0/change/guide.md', '---\ndescription: "Change."\n---\n# Change\n')
    write(source, 'upgrade-guide/v0.1.0/change/guide.zh.md', '---\ndescription: "变更。"\n---\n# 变更\n')
    write(source, 'upgrade-guide/v0.1.0/change/guide.i18n.yaml')
    write(source, 'postmortem/incident.md')
    write(source, 'AGENTS.md')
    write(source, 'persistence-changes/v1/changes.md')
    write(source, 'i18n/terminology.md')

    await stageDshDocs(source, destination, published)

    for (const copied of [
      'guide/index.md', 'guide/index.zh.md', 'images/diagram.png',
      'upgrade-guide/v0.1.0/change/guide.md', 'upgrade-guide/v0.1.0/change/guide.zh.md', 'upgrade-guide/README.md',
    ]) {
      expect(existsSync(join(destination, copied)), copied).toBe(true)
    }
    for (const excluded of [
      'guide/index.i18n.yaml', 'upgrade-guide/v0.1.0/change/guide.i18n.yaml',
      'postmortem', 'AGENTS.md', 'persistence-changes', 'i18n',
    ]) {
      expect(existsSync(join(destination, excluded)), excluded).toBe(false)
    }
  })

  it('indexes every staged upgrade guide by the release it upgrades from, newest first', async () => {
    const source = join(temporaryRoot(), 'docs')
    const destination = join(temporaryRoot(), 'cli', 'docs')
    const guide = (description: string, title: string): string => `---\nkind: upgrade-guide\ndescription: "${description}"\n---\n# ${title}\n`
    write(source, 'upgrade-guide/v0.2.0-rc.1/b-item/guide.md', '---\r\n# note\r\nkind: upgrade-guide\r\ndescription: >\r\n  Second | change\r\n  across lines.\r\n---\r\n# Second\r\n')
    write(source, 'upgrade-guide/v0.2.0-rc.1/b-item/guide.zh.md', guide('第二项。', '第二'))
    write(source, 'upgrade-guide/v0.2.0-rc.1/a-item/guide.md', guide('First change.', 'First'))
    write(source, 'upgrade-guide/v0.2.0-rc.1/a-item/guide.zh.md', guide('第一项。', '第一'))
    write(source, 'upgrade-guide/v0.10.0/c-item/guide.md', guide('Later change.', 'Later'))
    write(source, 'upgrade-guide/v0.10.0/c-item/guide.zh.md', guide('后续变更。', '后续'))

    await stageDshDocs(source, destination, new Set())
    const index = readFileSync(join(destination, 'upgrade-guide/README.md'), 'utf8')
    await stageDshDocs(source, destination, new Set())

    expect(readFileSync(join(destination, 'upgrade-guide/README.md'), 'utf8')).toBe(index)
    expect(index).toContain('upgrading from release vT to the release after it; vT is the release being left, not the target')
    const sections = index.split('\n## ').slice(1).map(section => section.split('\n').filter(line => line.startsWith('| ') && !line.startsWith('| Item') && !line.startsWith('| ---')))
    expect(index.match(/^## .+$/gmu)).toEqual(['## v0.10.0', '## v0.2.0-rc.1'])
    expect(sections).toEqual([
      ['| Later | Later change. | 后续变更。 | [v0.10.0/c-item/guide.md](v0.10.0/c-item/guide.md) | [v0.10.0/c-item/guide.zh.md](v0.10.0/c-item/guide.zh.md) |'],
      [
        '| First | First change. | 第一项。 | [v0.2.0-rc.1/a-item/guide.md](v0.2.0-rc.1/a-item/guide.md) | [v0.2.0-rc.1/a-item/guide.zh.md](v0.2.0-rc.1/a-item/guide.zh.md) |',
        '| Second | Second \\| change across lines. | 第二项。 | [v0.2.0-rc.1/b-item/guide.md](v0.2.0-rc.1/b-item/guide.md) | [v0.2.0-rc.1/b-item/guide.zh.md](v0.2.0-rc.1/b-item/guide.zh.md) |',
      ],
    ])
  })

  it('writes a preamble-only index without guides and rejects a guide the index cannot describe', async () => {
    const source = join(temporaryRoot(), 'docs')
    const destination = join(temporaryRoot(), 'cli', 'docs')
    write(source, 'kept.md')
    await stageDshDocs(source, destination, new Set(['kept.md']))
    expect(readFileSync(join(destination, 'upgrade-guide/README.md'), 'utf8')).not.toContain('## ')

    write(source, 'upgrade-guide/v0.1.0/change/guide.md', '# Untitled summary\n')
    write(source, 'upgrade-guide/v0.1.0/change/guide.zh.md', '# 无摘要\n')
    await expect(stageDshDocs(source, destination, new Set())).rejects.toThrow(/needs a frontmatter description and a level-one title/)
  })

  it('publishes the generated index for the repository guides', async () => {
    const destination = join(temporaryRoot(), 'cli', 'docs')
    await stageDshDocs(join(import.meta.dirname, '..', 'docs'), destination)
    const index = readFileSync(join(destination, 'upgrade-guide/README.md'), 'utf8')
    for (const file of readdirSync(join(import.meta.dirname, '..', 'docs/upgrade-guide'), { recursive: true, encoding: 'utf8' })) {
      if (file.endsWith('guide.md')) expect(index).toContain(`](${file.split('\\').join('/')})`)
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
