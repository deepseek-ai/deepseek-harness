/**
 * Shipped creator skills: every rendered skill stays below the pruner threshold, referenced
 * files exist, templates parse, and no skill bans reading DSH sources.
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { codePointLength } from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import { renderSkillContent } from '@deepseek-ai/dsh-skill'
import { describe, expect, it } from 'vitest'

const skills = fileURLToPath(new URL('../skills/', import.meta.url))
const names = readdirSync(skills)

/**
 * `packages/bundle/web-app/presets/standard.patch.yml` prunes a tool result only above `thresholdChars: 8192`
 * code points; a skill result below it reaches the model intact.
 */
const PRUNER_THRESHOLD_CHARS = 8192

/** The body the `skill` tool returns: the file without its YAML frontmatter. */
function body(name: string): string {
  const text = readFileSync(join(skills, name, 'SKILL.md'), 'utf8')
  const end = text.indexOf('\n---\n', 4)
  return text.slice(end + '\n---\n'.length)
}

function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter(file => file.endsWith('.md'))
    .map(file => join(dir, file))
}

describe('the shipped creator skills', () => {
  it('render below the pruner threshold and name only files that exist', () => {
    for (const name of names) {
      const rendered = renderSkillContent({
        name, provider: 'filesystem', resourceBase: { kind: 'directory', path: join(skills, name) }, content: body(name),
      })
      expect(codePointLength(rendered), name).toBeLessThan(PRUNER_THRESHOLD_CHARS)
      const referenced = [...body(name).matchAll(/`((?:references|templates)\/[^`]+)`/g)].map(match => match[1] ?? match[0])
      for (const path of referenced) expect(() => statSync(join(skills, name, path)), `${name}: ${path}`).not.toThrow()
    }
  })

  it('keep whole-file plugin references below the pruner threshold with read line numbers', () => {
    const references = join(skills, 'cordis-plugin-development', 'references')
    for (const file of readdirSync(references)) {
      const lines = readFileSync(join(references, file), 'utf8').split('\n')
      // The read tool renders each line as `${number}: ${text}`.
      const numbered = lines.map((text, index) => `${String(index + 1)}: ${text}`).join('\n')
      expect(codePointLength(numbered), file).toBeLessThan(PRUNER_THRESHOLD_CHARS)
    }
  })

  it('ship templates whose manifest, patch, and JavaScript parse', () => {
    const templates = join(skills, 'cordis-plugin-development', 'templates')
    for (const name of readdirSync(templates)) {
      const dir = join(templates, name)
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dsh: { bundle: { patch: string } } }
      const patch = yaml.load(readFileSync(join(dir, manifest.dsh.bundle.patch), 'utf8'), { schema: entryListSchema })
      expect(Array.isArray(patch)).toBe(true)
      for (const file of readdirSync(dir).filter(entry => entry.endsWith('.js'))) {
        execFileSync(process.execPath, ['--check', join(dir, file)])
      }
    }
  })

  it('never forbid reading DSH package sources and never route skill files through the shell', () => {
    for (const name of names) {
      for (const file of markdownFiles(join(skills, name))) {
        const text = readFileSync(file, 'utf8')
        expect(text, file).not.toMatch(/do not read (DSH |package |DSH package )?sources/i)
        // Desktop ships the skill directory inside app.asar, which only the Host process can open.
        expect(text, file).not.toMatch(/`(cat|cp|ls) /)
      }
    }
  })
})
