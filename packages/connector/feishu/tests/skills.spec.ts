/** The packaged entry skill: its index names exactly the guides lark-cli 1.0.97 embeds, and it stays below the pruner threshold. */
import { readdirSync, readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderSkillContent } from '@deepseek-ai/dsh-skill'
import { expect, it } from 'vitest'
import { FeishuSkillProvider } from '../src/skills.ts'

const skills = fileURLToPath(new URL('../skills/', import.meta.url))
const entry = join(skills, 'feishu')

/** The guides `lark-cli skills list` reports in the pinned `@larksuite/cli` 1.0.97. */
const GUIDES = [
  'lark-approval', 'lark-apps', 'lark-attendance', 'lark-base', 'lark-calendar', 'lark-contact', 'lark-doc', 'lark-drive',
  'lark-event', 'lark-im', 'lark-mail', 'lark-markdown', 'lark-meeting', 'lark-minutes', 'lark-note', 'lark-okr',
  'lark-openapi-explorer', 'lark-shared', 'lark-sheets', 'lark-skill-maker', 'lark-slides', 'lark-task', 'lark-vc',
  'lark-vc-agent', 'lark-whiteboard', 'lark-wiki', 'lark-workflow-meeting-summary', 'lark-workflow-standup-report',
]

/**
 * `packages/bundle/web-app/presets/standard.patch.yml` prunes a tool result only above `thresholdChars: 8192`
 * code points; a skill result below it reaches the model intact.
 */
const PRUNER_THRESHOLD_CHARS = 8192

/** The body the `skill` tool returns: the file without its YAML frontmatter. */
function body(): string {
  const text = readFileSync(join(entry, 'SKILL.md'), 'utf8')
  const end = text.indexOf('\n---\n', 4)
  return text.slice(end + '\n---\n'.length)
}

it('ships only the feishu entry; its guides stay in lark-cli', () => {
  expect(readdirSync(skills, { recursive: true }).toSorted()).toEqual(['feishu', join('feishu', 'SKILL.md')])
})

it('renders the entry below the pruner threshold', () => {
  const rendered = renderSkillContent({ name: 'feishu', provider: 'feishu', resourceBase: { kind: 'directory', path: entry }, content: body() })
  expect(Array.from(rendered).length).toBeLessThan(PRUNER_THRESHOLD_CHARS)
})

it('indexes every guide of the pinned lark-cli exactly once', () => {
  const indexed = [...body().matchAll(/^- `([a-z-]+)`:/gmu)].map(match => match[1] ?? '')
  expect(indexed.toSorted()).toEqual(GUIDES)
})

it('lists the entry with an opaque resource base and returns its body without the catalog-only fields', async () => {
  const file = join(entry, 'SKILL.md')
  const provider = new FeishuSkillProvider(file)
  expect(await provider.list()).toMatchObject([{ name: 'feishu', provider: 'feishu', source: 'bundled', locator: file, resourceBase: { kind: 'opaque' } }])
  const definition = await provider.get()
  expect(definition).not.toHaveProperty('rank')
  expect(definition).not.toHaveProperty('locator')
  expect(definition.content).toBe(body().trim())
})

it('refuses an entry without YAML frontmatter or without a skill name and description', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-feishu-entry-'))
  try {
    const file = join(dir, 'SKILL.md')
    await writeFile(file, '# No frontmatter\n')
    expect(() => new FeishuSkillProvider(file)).toThrow('has no YAML frontmatter')
    await writeFile(file, '---\nname: Not A Skill\n---\n\nbody\n')
    expect(() => new FeishuSkillProvider(file)).toThrow('needs a skill name and a description')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
