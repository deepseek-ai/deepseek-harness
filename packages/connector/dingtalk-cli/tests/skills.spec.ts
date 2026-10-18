/** The packaged entry skill: its index names exactly the pinned release's upstream skills, and it stays below the pruner threshold. */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderSkillContent } from '@deepseek-ai/dsh-skill'
import { expect, it } from 'vitest'

const skills = fileURLToPath(new URL('../skills/', import.meta.url))
const entry = join(skills, 'dingtalk')

/** The `multi/` directories of `dws-skills.zip` in the release that `DWS_RELEASE` pins. */
const UPSTREAM_SKILLS = [
  'dingtalk-aicard', 'dingtalk-aisearch', 'dingtalk-aitable', 'dingtalk-calendar', 'dingtalk-chat', 'dingtalk-contact',
  'dingtalk-doc', 'dingtalk-drive', 'dingtalk-event', 'dingtalk-mail', 'dingtalk-minutes', 'dingtalk-misc',
  'dingtalk-shared', 'dingtalk-tag', 'dingtalk-todo', 'dingtalk-wiki',
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

it('ships only the dingtalk entry; its guides are downloaded', () => {
  expect(readdirSync(skills, { recursive: true }).toSorted()).toEqual(['dingtalk', join('dingtalk', 'SKILL.md')])
})

it('renders the entry below the pruner threshold', () => {
  const rendered = renderSkillContent({ name: 'dingtalk', provider: 'dingtalk', resourceBase: { kind: 'directory', path: entry }, content: body() })
  expect(Array.from(rendered).length).toBeLessThan(PRUNER_THRESHOLD_CHARS)
})

it('indexes every upstream skill of the pinned release exactly once', () => {
  const indexed = [...body().matchAll(/^- `([a-z-]+)`：/gmu)].map(match => match[1] ?? '')
  expect(indexed.toSorted()).toEqual(UPSTREAM_SKILLS)
})
