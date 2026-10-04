/**
 * Shipped creator skills: every rendered skill stays below the pruner threshold, referenced
 * files exist, templates parse, and no skill bans reading DSH sources.
 */
import { execFileSync } from 'node:child_process'
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, matchesGlob, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { fileURLToPath } from 'node:url'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { codePointLength } from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import SkillRegistry, { renderSkillContent } from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'
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
  const repositorySkills = fileURLToPath(new URL('../../../../.agents/skills/', import.meta.url))
  const alias = join(repositorySkills, 'agent-experience/SKILL.md')
  const canonical = join(skills, 'agent-experience/SKILL.md')

  it('keeps agent-experience in the package with a repository alias, not a second copy', () => {
    expect(names).toContain('agent-experience')
    expect(lstatSync(canonical).isFile()).toBe(true)
    const linked = lstatSync(alias).isSymbolicLink()
    // Git can materialize link targets as plain files on Windows with core.symlinks=false.
    if (!linked) expect(process.platform).toBe('win32')
    const target = linked ? readlinkSync(alias) : readFileSync(alias, 'utf8').trim()
    expect(resolve(dirname(alias), target)).toBe(canonical)
  })

  it.for(['package', 'repository'] as const)('loads agent-experience from the %s skill root', async (source, test) => {
    if (source === 'repository' && process.platform === 'win32' && !lstatSync(alias).isSymbolicLink()) {
      test.skip(true, 'Repository discovery requires a checkout with symbolic links enabled.')
    }
    const ctx = new Context()
    test.onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(SkillFileSystem, {
      includeDefaultRoots: false, watch: false,
      customSkillDirs: [source === 'package' ? skills : repositorySkills],
    })
    expect((await ctx.skills.list()).map(skill => skill.name)).toContain('agent-experience')
    const loaded = await ctx.skills.get('agent-experience')
    expect(loaded?.path).toBe(realpathSync(canonical))
    expect(loaded?.content).toBe(body('agent-experience').trim())
  })

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

  it('ships discoverable, exported, packaged display resources with every plugin template', () => {
    const templates = join(skills, 'cordis-plugin-development', 'templates')
    for (const name of readdirSync(templates)) {
      const dir = join(templates, name)
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        exports: Record<string, string> & { './icon': string }
        files: string[]
        dsh: { bundle: { patch: string } }
      }
      expect(manifest).not.toHaveProperty('icon')
      expect(manifest.exports['./locale/*.json']).toBe('./locale/*.json')
      // The package-meta gate validates these resources through the real metadata reader.
      expect(manifest.exports['./icon']).toBe('./icon.svg')
      const locales = readdirSync(join(dir, 'locale')).map(file => `locale/${file}`)
      expect(locales).toContain('locale/en.json')
      for (const file of locales) {
        const locale = JSON.parse(readFileSync(join(dir, file), 'utf8')) as { meta: { title: string; description: string } }
        expect(locale.meta.title).toMatch(/\S/u)
        expect(locale.meta.description).toMatch(/\S/u)
      }
      const resources = new Set([...Object.values(manifest.exports).filter(file => !file.includes('*')),
        ...locales, manifest.dsh.bundle.patch])
      for (const resource of resources) {
        const file = resource.replace(/^\.\//u, '')
        expect(body('cordis-plugin-development'), file).toContain(`\`templates/${name}/${file}\``)
        expect(statSync(join(dir, file)).isFile(), file).toBe(true)
        if (file !== 'package.json') expect(manifest.files.some(pattern => matchesGlob(file, pattern)), file).toBe(true)
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
