import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillOffice from '@deepseek-ai/dsh-skill-office'
import { describe, expect, it, vi } from 'vitest'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readFile: vi.fn(actual.readFile) }
})

const assets = fileURLToPath(new URL('../assets/', import.meta.url))
const userPython = 'Follow an explicit user or applicable AGENTS.md requirement for a Python environment. Otherwise use the project\'s or user\'s existing Python, such as `python3` or `python` on PATH. Before the first script, check that this Python can import the libraries the workflow needs. If Python or a library is missing, tell the user which packages to install; do not install packages into a global environment without the user\'s agreement.'
const workspacePython = 'Follow an explicit user or applicable AGENTS.md requirement for a Python environment. Otherwise call `load_workspace_dependencies` and run scripts with its Python executable and bundled libraries. Do not install packages or search for a system Python for the default workflow. If the tool is unavailable, use an already configured environment and report a missing dependency only when it prevents the requested operation.'
const names = ['office']

describe('bundled Office skills', () => {
  it('keeps the description and the complete body within the context budgets', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SkillRegistry)
      await ctx.plugin(SkillOffice)
      expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(names)
      const route = (await ctx.skills.get('office'))!
      expect(route.description).toBe('Create, read, edit, and validate Word, PowerPoint, and Excel files; render Office files and PDFs; convert or recalculate. Load first to enable document_render, document_convert, document_recalculate.')
      expect(Math.ceil(route.description.length / 4)).toBeLessThanOrEqual(50)
    } finally { await ctx.fiber.dispose() }
    for (const pythonEnvironment of ['workspace-dependencies', 'user'] as const) {
      const scoped = new Context()
      try {
        await scoped.plugin(SkillRegistry)
        await scoped.plugin(SkillOffice, { pythonEnvironment })
        const content = (await scoped.skills.get('office'))!.content
        expect(Math.ceil(content.length / 4), pythonEnvironment).toBeLessThanOrEqual(350)
      } finally { await scoped.fiber.dispose() }
    }
  })

  it('packages only the office skill file', async () => {
    expect(await readdir(assets)).toEqual(names)
    expect(await readdir(join(assets, 'office'))).toEqual(['SKILL.md'])
  })

  it('loads each packaged body and removes all candidates on disposal', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SkillRegistry)
      const fiber = await ctx.plugin(SkillOffice)
      const catalog = await ctx.skills.list()
      expect(catalog.map(skill => skill.name)).toEqual(names)
      for (const skill of catalog) {
        expect(skill.description.length).toBeLessThanOrEqual(500)
        expect(skill).toMatchObject({ source: 'bundled', provider: 'dsh-office', invocation: { modelInvocable: true, userInvocable: true } })
        const loaded = await ctx.skills.get(skill.name)
        expect(loaded?.resourceBase).toEqual({ kind: 'directory', path: join(assets, skill.name).split(sep).join('/') })
        const raw = await readFile(join(assets, skill.name, 'SKILL.md'), 'utf8')
        const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, '').trim()
        expect(loaded?.content).toBe(`${body}\n\n## Python environment\n\n${workspacePython}`)
      }
      await fiber.dispose()
      expect(await ctx.skills.list()).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('loads relocated resources through a real cordis.yml composition', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-office-skills-'))
    const ctx = new Context()
    try {
      const external = join(root, '中文 assets')
      await cp(assets, external, { recursive: true })
      const configPath = join(root, 'cordis.yml')
      await writeFile(configPath, [
        "- name: '@deepseek-ai/dsh-skill'",
        "- name: '@deepseek-ai/dsh-skill-office'",
        '  config:',
        `    assetRoot: ${JSON.stringify(external)}`,
        '',
      ].join('\n'))
      ctx.baseUrl = pathToFileURL(root).href + '/'
      await ctx.plugin(Loader)
      ctx.loader.builtins.include = Include
      const modules = new Map<string, unknown>([
        ['@deepseek-ai/dsh-skill', SkillRegistry],
        ['@deepseek-ai/dsh-skill-office', SkillOffice],
      ])
      ctx.loader.internal = {
        version: 'v2',
        loadCache: new Map(),
        register() { throw new Error('unexpected register') },
        getOrCreateModuleJob() { throw new Error('unexpected module job') },
        resolveSync() { throw new Error('unexpected resolution') },
        load() { throw new Error('unexpected load') },
        async import(specifier: string) {
          if (!modules.has(specifier)) throw new Error(`Unexpected Loader import: ${specifier}`)
          return modules.get(specifier)
        },
      }
      await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
      await ctx.loader.await()
      expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(names)
      const loaded = await ctx.skills.get('office')
      expect(loaded?.resourceBase).toEqual({ kind: 'directory', path: join(external, 'office').split(sep).join('/') })
      const raw = await readFile(join(external, 'office', 'SKILL.md'), 'utf8')
      const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, '').trim()
      expect(loaded?.content).toBe(`${body}\n\n## Python environment\n\n${workspacePython}`)
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([
    ['defaults to', undefined, workspacePython],
    ['accepts', 'user', userPython],
    ['accepts', 'workspace-dependencies', workspacePython],
  ] as const)('%s the %s Python environment at the end of the office skill', async (_verb, pythonEnvironment, section) => {
    const ctx = new Context()
    try {
      await ctx.plugin(SkillRegistry)
      await ctx.plugin(SkillOffice, pythonEnvironment === undefined ? {} : { pythonEnvironment })
      const content = (await ctx.skills.get('office'))!.content
      expect(content.endsWith(`\n\n## Python environment\n\n${section}`)).toBe(true)
      expect(content).not.toContain(section === userPython ? workspacePython : userPython)
    } finally { await ctx.fiber.dispose() }
  })

  it('rejects an unknown Python environment', async () => {
    // Loader input is untyped YAML; call the schema the same way.
    expect(() => { Reflect.apply(SkillOffice.Config, undefined, [{ pythonEnvironment: 'system' }]) }).toThrow('pythonEnvironment')
  })

  it.each([
    ['description: "Quoted: description"', '\r\n', 'Quoted: description'],
    ['description: >-\n  Folded\n  description', '\n', 'Folded description'],
  ])('parses frontmatter %s and leaves body metadata-like lines intact', async (header, newline, description) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-office-metadata-'))
    const ctx = new Context()
    try {
      await cp(assets, root, { recursive: true })
      const body = '# Office instructions\n\ndescription: instruction text'
      await writeFile(join(root, 'office', 'SKILL.md'), `---\n${header}\n---\n\n${body}\n`.replaceAll('\n', newline))
      await ctx.plugin(SkillRegistry)
      await ctx.plugin(SkillOffice, { assetRoot: root })
      const skill = await ctx.skills.get('office')
      expect(skill?.description).toBe(description)
      expect(skill?.content).toBe(`${body.replaceAll('\n', newline)}\n\n## Python environment\n\n${workspacePython}`)
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a relative asset root before registration', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SkillRegistry)
      expect(() => { SkillOffice.apply(ctx, { assetRoot: 'assets', pythonEnvironment: 'user' }) }).toThrow('absolute directory')
      expect(await ctx.skills.list()).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('omits unreadable or invalid skills from a complete catalog and reports each failure once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-office-invalid-'))
    const ctx = new Context()
    const warnings: string[] = []
    try {
      ctx.logger.exporter({ levels: { default: 2 }, export: ({ type, args }) => { if (type === 'warn') warnings.push(String(args[0])) } })
      await ctx.plugin(SkillRegistry)
      await cp(assets, root, { recursive: true })
      const skillFile = join(root, 'office', 'SKILL.md')
      const original = await readFile(skillFile, 'utf8')
      const catalog = async () => {
        const snapshot = await ctx.skills.snapshot()
        return { complete: snapshot.complete, names: snapshot.skills.map(skill => skill.name) }
      }
      await rm(skillFile)
      let fiber = await ctx.plugin(SkillOffice, { assetRoot: root })
      expect(await catalog()).toEqual({ complete: true, names: [] })
      expect(warnings).toEqual([expect.stringMatching(/^skill-office: skill "office" is unavailable: Error: ENOENT.*SKILL\.md/u)])
      await fiber.dispose()
      const invalid: [content: string, failure: string][] = [
        ['# Missing frontmatter\ndescription: body text\n', 'has no YAML frontmatter'],
        ...['', 'null', 'scalar', 'name: office', 'description: 3', 'description: ""']
          .map((header): [string, string] => [`---\n${header}\n---\n# Instructions\n`, 'has no description']),
        // YAML parse errors carry their own codes; they persist like other invalid metadata.
        ['---\ndescription: [unclosed\n---\n# Instructions\n', 'YAMLParseError'],
      ]
      for (const [content, failure] of invalid) {
        await writeFile(skillFile, content)
        fiber = await ctx.plugin(SkillOffice, { assetRoot: root })
        expect(await catalog()).toEqual({ complete: true, names: [] })
        expect(warnings.at(-1)).toContain(failure)
        await fiber.dispose()
      }
      await writeFile(skillFile, original)
      const registerProvider = vi.spyOn(ctx.skills, 'registerProvider')
      await ctx.plugin(SkillOffice, { assetRoot: root })
      expect(await catalog()).toEqual({ complete: true, names })
      const reported = warnings.length
      await rm(skillFile)
      expect(await ctx.skills.get('office')).toBeUndefined()
      expect(warnings).toHaveLength(reported + 1)
      expect(await catalog()).toEqual({ complete: true, names: [] })
      expect(warnings).toHaveLength(reported + 1)
      const provider = registerProvider.mock.calls[0]![0]({ signal: new AbortController().signal, invalidate: () => {} })
      await expect(provider.list({ signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' })
      expect(warnings).toHaveLength(reported + 1)
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('omits a skill whose frontmatter becomes malformed YAML after discovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-office-malformed-'))
    const ctx = new Context()
    try {
      await ctx.plugin(SkillRegistry)
      await cp(assets, root, { recursive: true })
      await ctx.plugin(SkillOffice, { assetRoot: root })
      expect((await ctx.skills.snapshot()).complete).toBe(true)
      await writeFile(join(root, 'office', 'SKILL.md'), '---\ndescription: [unclosed\n---\n# Instructions\n')
      expect(await ctx.skills.get('office')).toBeUndefined()
      const snapshot = await ctx.skills.snapshot()
      expect({ complete: snapshot.complete, names: snapshot.skills.map(skill => skill.name) })
        .toEqual({ complete: true, names: [] })
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([
    ['an Error without a code', new Error('temporary read failure')],
    ['a non-Error rejection', 'temporary read failure'],
  ])('retries discovery and preserves load failures for %s', async (_label, error) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-office-unknown-read-'))
    const ctx = new Context()
    try {
      await ctx.plugin(SkillRegistry)
      await cp(assets, root, { recursive: true })
      const skillFile = join(root, 'office', 'SKILL.md')
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
      const read = vi.mocked(readFile)
      let failRead = true
      try {
        read.mockImplementation((path, options) => path === skillFile && failRead
          // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Exercise primitive read failures.
          ? Promise.reject(error) : actual.readFile(path, options))
        await ctx.plugin(SkillOffice, { assetRoot: root })
        const incomplete = await ctx.skills.snapshot()
        expect({ complete: incomplete.complete, names: incomplete.skills.map(skill => skill.name) })
          .toEqual({ complete: false, names: [] })
        failRead = false
        const recovered = await ctx.skills.snapshot()
        expect({ complete: recovered.complete, names: recovered.skills.map(skill => skill.name) })
          .toEqual({ complete: true, names })
        failRead = true
        await expect(ctx.skills.get('office')).rejects.toBe(error)
      } finally {
        read.mockReset()
      }
      expect((await ctx.skills.get('office'))?.content).toContain('# Office tasks')
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('retries read errors other than a missing path instead of omitting the skill', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-office-retry-'))
    const ctx = new Context()
    try {
      await ctx.plugin(SkillRegistry)
      await cp(assets, root, { recursive: true })
      const skillFile = join(root, 'office', 'SKILL.md')
      const original = await readFile(skillFile, 'utf8')
      const catalog = async () => {
        const snapshot = await ctx.skills.snapshot()
        return { complete: snapshot.complete, names: snapshot.skills.map(skill => skill.name) }
      }
      await rm(skillFile)
      // Reading a directory fails with EISDIR, standing in for a lock or permission error.
      await mkdir(skillFile)
      await ctx.plugin(SkillOffice, { assetRoot: root })
      expect(await catalog()).toEqual({ complete: false, names: [] })
      await rm(skillFile, { recursive: true })
      await writeFile(skillFile, original)
      expect(await catalog()).toEqual({ complete: true, names })
      await rm(skillFile)
      await mkdir(skillFile)
      await expect(ctx.skills.get('office')).rejects.toMatchObject({ code: 'EISDIR' })
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})

it('directs Office operations to dedicated tools without executable paths', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(SkillOffice)
    const route = (await ctx.skills.get('office'))!.content
    expect(route).toContain('`document_render`, `document_convert`, and `document_recalculate` become available on the next step; if one is missing later, load `office` again.')
    expect(route).toContain('Bundled Python includes `pypdf` for existing PDFs.')
    expect(route).toContain('python-docx, python-pptx, and openpyxl cannot open legacy `.doc`, `.ppt`, or `.xls` files; convert them with `document_convert` first.')
    expect(route).toContain('openpyxl writes formulas without calculated values; use `document_recalculate` when results must show.')
    expect(route).not.toMatch(
      /operation:|`office` tool|office-render|office-recalculate|office-export-pdf|LibreOffice Kit CLI|--output-dir|"<node>"|`[a-z]+\.md`/u,
    )
  } finally { await ctx.fiber.dispose() }
})
