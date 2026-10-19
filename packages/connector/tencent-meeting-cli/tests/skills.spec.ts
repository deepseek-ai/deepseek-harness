/** The bundled entry skill: its index names exactly the upstream guides, and it reaches the model below the pruner threshold. */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderSkillContent } from '@deepseek-ai/dsh-skill'
import { expect, it } from 'vitest'

const entry = fileURLToPath(new URL('../skills/tencent-meeting/', import.meta.url))
const guides = join(entry, 'guides')

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

it('ships only the tencent-meeting entry at the bundled skill root', () => {
  expect(readdirSync(fileURLToPath(new URL('../skills/', import.meta.url)))).toEqual(['tencent-meeting'])
})

it('renders the entry below the pruner threshold', () => {
  const rendered = renderSkillContent({ name: 'tencent-meeting', provider: 'tencent-meeting', resourceBase: { kind: 'directory', path: entry }, content: body() })
  expect(Array.from(rendered).length).toBeLessThan(PRUNER_THRESHOLD_CHARS)
})

it('indexes every upstream guide exactly once, and each indexed guide exists', () => {
  const indexed = [...body().matchAll(/^- `([a-z-]+)`：/gmu)].map(match => match[1] ?? '')
  expect(indexed.toSorted()).toEqual(readdirSync(guides).toSorted())
  for (const name of indexed) expect(() => statSync(join(guides, name, 'SKILL.md')), name).not.toThrow()
})
