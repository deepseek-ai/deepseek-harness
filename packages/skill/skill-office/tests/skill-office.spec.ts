import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillOffice from '@deepseek-ai/dsh-skill-office'
import { describe, expect, it, vi } from 'vitest'
import { READ_MAX_BYTES, READ_MAX_LINE_LENGTH } from '../../../fs/tool-fs/src/read-render.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readFile: vi.fn(actual.readFile), stat: vi.fn(actual.stat) }
})

const assets = fileURLToPath(new URL('../assets/', import.meta.url))
const userPython = 'Follow an explicit user or applicable AGENTS.md requirement for a Python environment. Otherwise use the project\'s or user\'s existing Python, such as `python3` or `python` on PATH. Before the first script, check that this Python can import the libraries the workflow needs. If Python or a library is missing, tell the user which packages to install; do not install packages into a global environment without the user\'s agreement.'
const workspacePython = 'Follow an explicit user or applicable AGENTS.md requirement for a Python environment. Otherwise call `load_workspace_dependencies` and run scripts with its Python executable and bundled libraries. Do not install packages or search for a system Python for the default workflow. If the tool is unavailable, use an already configured environment and report a missing dependency only when it prevents the requested operation.'
const names = ['office']
const references = ['docx.md', 'pptx.md', 'xlsx.md']
const readReference = (file: string) => readFile(join(assets, 'office', file), 'utf8')

describe('bundled Office skills', () => {
  it('keeps routing and one format file within the progressive context budgets', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SkillRegistry)
      await ctx.plugin(SkillOffice)
      const catalog = await ctx.skills.list()
      expect(catalog.map(skill => skill.name)).toEqual(names)
      const route = (await ctx.skills.get('office'))!
      expect(route.description).toBe('Create, read, edit, and validate Word, PowerPoint, and Excel files; render Office files and PDFs; convert or recalculate. Load first to enable office_render, office_convert, and office_recalculate.')
      expect(Math.ceil(route.description.length / 4)).toBeLessThanOrEqual(50)
      const routing = route.content.slice(0, route.content.indexOf('\n\n## Python environment\n\n'))
      expect(Math.ceil(routing.length / 4)).toBeLessThanOrEqual(230)
      for (const [file, previousTokens] of [['docx.md', 1688], ['pptx.md', 1879], ['xlsx.md', 2330]] as const) {
        const reference = await readReference(file)
        expect(Math.ceil((route.content.length + reference.length) / 4)).toBeLessThanOrEqual(230 + Math.floor(previousTokens * 0.7))
        expect(reference).not.toMatch(/read_image/)
        expect(reference).not.toContain('dsoffice')
        expect(reference).toContain('`office_render`')
        expect(reference).toContain('"Content and structure checks passed; visual inspection was not completed." or "内容与结构检查通过；视觉检查未完成。"')
      }
    } finally { await ctx.fiber.dispose() }
  })

  it('links each format file once from SKILL.md and keeps every line within one read', async () => {
    const skill = await readReference('SKILL.md')
    expect(skill).toContain('use the `read` tool, not shell commands, to read its format file')
    expect([...skill.matchAll(/`([a-z]+\.md)`/gu)].map(match => match[1])).toEqual(references)
    expect(await readdir(assets)).toEqual(names)
    expect((await readdir(join(assets, 'office'))).filter(file => file !== 'SKILL.md').sort()).toEqual(references)
    for (const file of references) {
      const reference = await readReference(file)
      expect(Buffer.byteLength(reference)).toBeLessThan(READ_MAX_BYTES)
      for (const line of reference.split(/\r?\n/u)) expect(line.length).toBeLessThan(READ_MAX_LINE_LENGTH)
      expect(reference).not.toMatch(/`[a-z]+\.md`|\]\([^)]*\.md\)/u)
      expect(reference).toContain('Run Python as described in the Python environment section of the `office` skill.')
      expect(reference).not.toMatch(/load `office`|section below/u)
    }
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

  it.each([
    ['missing', async (path: string) => { await rm(path) }, 'ENOENT'],
    ['a directory', async (path: string) => { await rm(path); await mkdir(path) }, 'is not a regular file'],
  ])('omits the skill and reports the path when a format file is %s', async (_label, damage, failure) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-office-format-'))
    const ctx = new Context()
    const warnings: string[] = []
    try {
      ctx.logger.exporter({ levels: { default: 2 }, export: ({ type, args }) => { if (type === 'warn') warnings.push(String(args[0])) } })
      await ctx.plugin(SkillRegistry)
      await cp(assets, root, { recursive: true })
      const docx = join(root, 'office', 'docx.md')
      await damage(docx)
      await ctx.plugin(SkillOffice, { assetRoot: root })
      const snapshot = await ctx.skills.snapshot()
      expect({ complete: snapshot.complete, names: snapshot.skills.map(skill => skill.name) }).toEqual({ complete: true, names: [] })
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toMatch(/^skill-office: skill "office" is unavailable: /u)
      expect(warnings[0]).toContain(docx)
      expect(warnings[0]).toContain(failure)
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('omits the skill when a format file disappears after discovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-office-format-removed-'))
    const ctx = new Context()
    try {
      await ctx.plugin(SkillRegistry)
      await cp(assets, root, { recursive: true })
      await ctx.plugin(SkillOffice, { assetRoot: root })
      expect((await ctx.skills.snapshot()).skills.map(skill => skill.name)).toEqual(names)
      await rm(join(root, 'office', 'xlsx.md'))
      expect(await ctx.skills.get('office')).toBeUndefined()
      const snapshot = await ctx.skills.snapshot()
      expect({ complete: snapshot.complete, names: snapshot.skills.map(skill => skill.name) }).toEqual({ complete: true, names: [] })
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('retries discovery when a format file check fails without a missing path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-office-format-retry-'))
    const ctx = new Context()
    const error = new Error('temporary stat failure')
    try {
      await ctx.plugin(SkillRegistry)
      await cp(assets, root, { recursive: true })
      const pptx = join(root, 'office', 'pptx.md')
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
      const check = vi.mocked(stat)
      let fail = true
      try {
        check.mockImplementation((path, options) => path === pptx && fail ? Promise.reject(error) : actual.stat(path, options))
        await ctx.plugin(SkillOffice, { assetRoot: root })
        const incomplete = await ctx.skills.snapshot()
        expect({ complete: incomplete.complete, names: incomplete.skills.map(skill => skill.name) }).toEqual({ complete: false, names: [] })
        fail = false
        const recovered = await ctx.skills.snapshot()
        expect({ complete: recovered.complete, names: recovered.skills.map(skill => skill.name) }).toEqual({ complete: true, names })
        fail = true
        await expect(ctx.skills.get('office')).rejects.toBe(error)
      } finally {
        check.mockReset()
      }
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
    expect(route).toContain('If `office_render`, `office_convert`, or `office_recalculate` is not in your tools, load `office` with `skill`; they appear next step.')
    for (const instruction of ['`office_render`', '`office_recalculate`', '`office_convert` with `format`', '`format: "xlsx"` or `"ods"`']) expect(route).toContain(instruction)
    for (const content of [route, ...await Promise.all(references.map(readReference))]) {
      expect(content).not.toMatch(
        /operation:|`office` tool|office-render|office-recalculate|office-export-pdf|LibreOffice Kit CLI|--output-dir|"<node>"/u,
      )
    }
    expect(await readReference('xlsx.md')).toContain('`office_recalculate` with `format: "xlsx"`')
    for (const [format, legacy, library] of [['docx', 'doc', 'python-docx'], ['xlsx', 'xls', 'openpyxl'], ['pptx', 'ppt', 'python-pptx']]) {
      expect(await readReference(`${format}.md`)).toContain(`${library} cannot read legacy \`.${legacy}\` files. Use \`office_convert\` with \`format: "${format}"\`, copy the result into the workspace, then edit the copy.`)
    }
  } finally { await ctx.fiber.dispose() }
})
