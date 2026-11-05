/**
 * The shipped dsh-doc skill: it is the package's only skill, renders below the pruner threshold, and
 * names exactly the files it ships; its templates parse and show their detail documents, and it never
 * bans reading DSH sources. The Web preset e2e measures whole-reference reads.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { fileURLToPath } from 'node:url'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { codePointLength } from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import { languageChain, localFiles, readPackageDocument } from '@deepseek-ai/dsh-plugin-detail'
import SkillRegistry, { renderSkillContent } from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'
import { describe, expect, it, type TestContext } from 'vitest'
import { JSDOM } from 'jsdom'
import { packageMetaProblems } from '../../../../scripts/verify-package-meta.ts'

const skills = fileURLToPath(new URL('../skills/', import.meta.url))

/**
 * `packages/bundle/web-app/presets/standard.patch.yml` prunes a tool result only above `thresholdChars: 8192`
 * code points; a skill result below it reaches the model intact.
 */
const PRUNER_THRESHOLD_CHARS = 8192
/** Fixture read budget, independent of Plugin Manager deployment limits. */
const TEST_DOCUMENT_MAX_BYTES = 1 << 20

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

describe('the shipped dsh-doc skill', () => {
  const skill = join(skills, 'dsh-doc')
  const templates = join(skill, 'templates')
  const repositorySkills = fileURLToPath(new URL('../../../../.agents/skills/', import.meta.url))

  async function loadRoot(root: string, test: TestContext) {
    const ctx = new Context()
    test.onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(SkillFileSystem, { includeDefaultRoots: false, watch: false, customSkillDirs: [root] })
    return ctx
  }

  it('is the only skill the package skill root exposes', async (test) => {
    const ctx = await loadRoot(skills, test)
    expect((await ctx.skills.list()).map(entry => entry.name)).toEqual(['dsh-doc'])
    expect((await ctx.skills.get('dsh-doc'))?.content).toBe(body('dsh-doc').trim())
  })

  it('leaves repository skills without a second dsh-doc and wraps the packaged tool-design reference', async (test) => {
    const ctx = await loadRoot(repositorySkills, test)
    const repository = (await ctx.skills.list()).map(entry => entry.name)
    expect(repository).not.toContain('dsh-doc')
    expect(repository).toEqual(expect.arrayContaining(['dsh-doc-writing', 'agent-experience']))
    const wrapper = join(repositorySkills, 'agent-experience', 'SKILL.md')
    expect(lstatSync(wrapper).isFile()).toBe(true)
    const link = /\]\(([^)]+tool-design\.md)\)/u.exec(readFileSync(wrapper, 'utf8'))?.[1]
    expect(link && resolve(dirname(wrapper), link)).toBe(join(skill, 'references', 'tool-design.md'))
  })

  it('renders below the pruner threshold and lists exactly the files it ships', () => {
    const rendered = renderSkillContent({
      name: 'dsh-doc', provider: 'filesystem', resourceBase: { kind: 'directory', path: skill }, content: body('dsh-doc'),
    })
    expect(codePointLength(rendered)).toBeLessThan(PRUNER_THRESHOLD_CHARS)
    const referenced = new Set([...body('dsh-doc').matchAll(/`((?:references|templates)\/[^`]+)`/g)].map(match => match[1] ?? match[0]))
    const shipped = readdirSync(skill, { recursive: true, encoding: 'utf8' })
      .filter(file => file !== 'SKILL.md' && statSync(join(skill, file)).isFile())
      .map(file => file.split(sep).join('/'))
      .map(file => file.replace(/(templates\/[^/]+\/locale)\/[^/]+$/u, '$1'))
    expect([...referenced].sort()).toEqual([...new Set(shipped)].sort())
  })

  it('ship templates whose manifest, patch, and JavaScript parse', () => {
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
    for (const name of readdirSync(templates)) {
      const dir = join(templates, name)
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        exports: Record<string, string> & { './icon': string }
        files: string[]
        dsh: { bundle: { patch: string } }
      }
      expect(manifest).not.toHaveProperty('icon')
      expect(manifest.files).toContain('docs')
      const runtimeFiles = [manifest.dsh.bundle.patch, manifest.exports['.'], manifest.exports['./client']]
        .filter((file): file is string => file !== undefined).map(file => file.replace(/^\.\//u, ''))
      for (const file of runtimeFiles) expect(manifest.files, file).toContain(file)
      expect(manifest.exports['./locale/*.json']).toBe('./locale/*.json')
      // The package-meta gate validates these resources through the real metadata reader.
      expect(manifest.exports['./icon']).toBe('./icon.svg')
      const locales = readdirSync(join(dir, 'locale')).map(file => `locale/${file}`)
      expect(locales).toContain('locale/en.json')
      const english = JSON.parse(readFileSync(join(dir, 'locale', 'en.json'), 'utf8')) as { meta: Record<string, string> }
      const details: string[] = []
      for (const file of locales) {
        const locale = JSON.parse(readFileSync(join(dir, file), 'utf8')) as {
          meta: { title: string; description: string; detail: string }
        }
        expect(Object.keys(locale.meta).sort(), file).toEqual(Object.keys(english.meta).sort())
        expect(locale.meta.title).toMatch(/\S/u)
        expect(locale.meta.description).toMatch(/\S/u)
        expect(locale.meta.detail, file).toMatch(/^[^/]+\/.+\.md$/u)
        details.push(locale.meta.detail)
      }
      const resources = new Set([...Object.values(manifest.exports).filter(file => !file.includes('*')),
        ...locales, ...details, manifest.dsh.bundle.patch])
      for (const resource of resources) {
        const file = resource.replace(/^\.\//u, '')
        expect(body('dsh-doc'), file).toContain(`\`templates/${name}/${file.startsWith('locale/') ? 'locale' : file}\``)
        expect(statSync(join(dir, file)).isFile(), file).toBe(true)
      }
    }
  })

  it('publishes template metadata through the same package check as CI', (test) => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-template-meta-'))
    test.onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
    for (const name of readdirSync(templates)) {
      const destination = join(root, 'packages', 'templates', name)
      cpSync(join(templates, name), destination, { recursive: true })
    }
    expect(packageMetaProblems(root)).toEqual([])
  })

  it('uses a 36-unit canvas for each template icon', () => {
    const { window } = new JSDOM()
    try {
      for (const name of readdirSync(templates)) {
        const document = new window.DOMParser().parseFromString(readFileSync(join(templates, name, 'icon.svg'), 'utf8'), 'image/svg+xml')
        expect(document.querySelector('parsererror'), name).toBeNull()
        const svg = document.documentElement
        expect(svg.localName, name).toBe('svg')
        expect(svg.getAttribute('width'), name).toBe('36')
        expect(svg.getAttribute('height'), name).toBe('36')
        expect(svg.getAttribute('viewBox'), name).toBe('0 0 36 36')
      }
    } finally { window.close() }
  })

  it.for(readdirSync(join(skills, 'dsh-doc', 'templates')))('shows the %s template detail document on its bundle page', async (name) => {
    const dir = join(templates, name)
    const locale = JSON.parse(readFileSync(join(dir, 'locale', 'en.json'), 'utf8')) as { meta: { detail: string } }
    for (const file of readdirSync(join(dir, 'locale'))) {
      const document = await readPackageDocument(localFiles(dir, '1.0.0'), '', languageChain(file.replace(/\.json$/u, '')), TEST_DOCUMENT_MAX_BYTES, AbortSignal.timeout(10_000))
      expect(document, file).toMatchObject({ origin: 'locale', path: locale.meta.detail })
      expect(document?.markdown, file).toMatch(/\n## How to use\n[\s\S]*\n## Good to know\n/u)
    }
  })

  it('names only shipped files and no retired skill in any of its documents', () => {
    for (const file of markdownFiles(skill)) {
      const text = readFileSync(file, 'utf8')
      for (const match of text.matchAll(/`((?:references|templates)\/[^`]+)`/g)) {
        expect(() => statSync(join(skill, match[1] ?? '')), `${file}: ${match[1] ?? ''}`).not.toThrow()
      }
      expect(text, file).not.toMatch(/cordis-plugin-development|editing-cordis-compositions|cordis-composition-reference|agent-experience/u)
    }
  })

  // The commands target bash; Windows Desktop is directed to the file-read tool instead.
  it.skipIf(process.platform === 'win32')('documents shell commands that locate a package and list upgrade index sections', (test) => {
    const install = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-doc-commands-')))
    test.onTestFinished(() => { rmSync(install, { recursive: true, force: true }) })
    const pkg = join(install, 'node_modules', '@deepseek-ai', 'dsh-tool-bash')
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(pkg, 'package.json'), '{"name":"@deepseek-ai/dsh-tool-bash"}\n')
    mkdirSync(join(install, 'docs', 'upgrade-guide'), { recursive: true })
    writeFileSync(join(install, 'docs', 'upgrade-guide', 'README.md'), '# Upgrade guides\r\n\r\n## v2.0.0\r\n\r\n| row |\n## v1.0.0\n')
    const run = (file: string) => {
      const command = /```sh\n\s*(.+)\n\s*```/u.exec(readFileSync(join(skill, 'references', file), 'utf8'))?.[1]
      expect(command, file).toBeDefined()
      return execFileSync('bash', ['-c', command ?? ''], {
        encoding: 'utf8', env: { ...process.env, DSH_INSTALL_DIR: install, DSH_NODE_EXECUTABLE: process.execPath },
      })
    }
    expect(run('locate-docs.md').trim()).toBe(pkg)
    expect(run('upgrading.md')).toBe('3 ## v2.0.0\n6 ## v1.0.0\n')
  })

  // Desktop's real Electron and archive run in apps/desktop/tests/installed-docs-asar.built.e2e.ts.
  it.skipIf(spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0']).status !== 0)('documents a PowerShell process form that waits for the runtime', (test) => {
    const install = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-doc-pwsh-')))
    test.onTestFinished(() => { rmSync(install, { recursive: true, force: true }) })
    const pkg = join(install, 'node_modules', '@deepseek-ai', 'dsh-tool-bash')
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(pkg, 'package.json'), '{"name":"@deepseek-ai/dsh-tool-bash"}\n')
    const command = /```powershell\n([\s\S]+?)\n```/u.exec(readFileSync(join(skill, 'references', 'locate-docs.md'), 'utf8'))?.[1]
    expect(command).toBeDefined()
    const run = (script: string) => spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', env: { ...process.env, DSH_INSTALL_DIR: install, DSH_NODE_EXECUTABLE: process.execPath },
    })
    const found = run(command ?? '')
    expect(found.status, found.stderr).toBe(0)
    expect(found.stdout.trim()).toBe(pkg)
    // A failing script keeps its exit code and writes its error to stderr only.
    const missing = run((command ?? '').replace("'@deepseek-ai/dsh-tool-bash'", "'@deepseek-ai/dsh-missing'"))
    expect(missing.status).not.toBe(0)
    expect(missing.stdout).toBe('')
    expect(missing.stderr).toContain('@deepseek-ai/dsh-missing')
  })

  it('never forbid reading DSH package sources and never route skill files through the shell', () => {
    for (const file of markdownFiles(skill)) {
      const text = readFileSync(file, 'utf8')
      expect(text, file).not.toMatch(/do not read (DSH |package |DSH package )?sources/i)
      // Desktop ships the skill directory inside app.asar, which only the Host process can open.
      expect(text, file).not.toMatch(/`(cat|cp|ls) /)
    }
  })
})
