/** The bundled entry skill: its index names exactly the pinned upstream guides, and it reaches the model below the pruner threshold. */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderSkillContent } from '@deepseek-ai/dsh-skill'
import { expect, it } from 'vitest'

const entry = fileURLToPath(new URL('../skills/wecom/', import.meta.url))

/** The `skills/<guide>/SKILL.md` directories of the pinned commit, as `scripts/upstream-skills-digest.ts` lists them. */
const PINNED_GUIDES = [
  'wecomcli-calendar', 'wecomcli-contact', 'wecomcli-disk', 'wecomcli-doc', 'wecomcli-doc-manage', 'wecomcli-email', 'wecomcli-media',
  'wecomcli-meeting', 'wecomcli-message', 'wecomcli-pptx', 'wecomcli-shared', 'wecomcli-sheet', 'wecomcli-smartpage', 'wecomcli-smartsheet',
  'wecomcli-todo',
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

it('ships only the wecom entry at the bundled skill root', () => {
  expect(readdirSync(fileURLToPath(new URL('../skills/', import.meta.url)))).toEqual(['wecom'])
})

it('renders the entry below the pruner threshold', () => {
  const rendered = renderSkillContent({ name: 'wecom', provider: 'wecom', resourceBase: { kind: 'directory', path: entry }, content: body() })
  expect(Array.from(rendered).length).toBeLessThan(PRUNER_THRESHOLD_CHARS)
})

it('indexes every guide of the pinned commit exactly once', () => {
  const indexed = [...body().matchAll(/^- `(wecomcli-[a-z-]+)`：/gmu)].map(match => match[1] ?? '')
  expect(indexed.toSorted()).toEqual(PINNED_GUIDES.toSorted())
})
