import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillOffice from '@deepseek-ai/dsh-skill-office'
import { isSea } from 'node:sea'
import { execa } from 'execa'
import { describe, expect, it, vi } from 'vitest'

vi.mock('node:sea', () => ({ isSea: vi.fn(() => false) }))

const assets = fileURLToPath(new URL('../assets/', import.meta.url))
const names = ['office', 'office-docx', 'office-export-pdf', 'office-pptx', 'office-recalculate', 'office-render', 'office-xlsx']

describe('bundled Office skills', () => {
  it('keeps routing and authoring within the progressive context budgets', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SkillRegistry)
      await ctx.plugin(SkillOffice)
      const catalog = await ctx.skills.list()
      expect(catalog.map(skill => skill.name)).toEqual(names)
      const route = (await ctx.skills.get('office'))!
      expect(Math.ceil(route.description.length / 4)).toBeLessThanOrEqual(50)
      expect(Math.ceil(route.content.length / 4)).toBeLessThanOrEqual(200)
      for (const [name, previousTokens] of [['office-docx', 1688], ['office-pptx', 1879], ['office-xlsx', 2330]] as const) {
        const skill = (await ctx.skills.get(name))!
        expect(Math.ceil(skill.content.length / 4)).toBeLessThanOrEqual(Math.floor(previousTokens * 0.65))
        expect(skill.content).not.toMatch(/read_image|transparent|DPI/)
        expect(skill.content).not.toContain('dsoffice')
        expect(skill.content).toContain('office-render')
      }
    } finally { await ctx.fiber.dispose() }
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
        expect(loaded?.content.startsWith(body)).toBe(true)
        if (!['office-render', 'office-recalculate', 'office-export-pdf'].includes(skill.name)) expect(loaded?.content).toBe(body)
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
      const loaded = await ctx.skills.get('office-xlsx')
      expect(loaded?.resourceBase).toEqual({ kind: 'directory', path: join(external, 'office-xlsx').split(sep).join('/') })
      const raw = await readFile(join(external, 'office-xlsx', 'SKILL.md'), 'utf8')
      const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, '').trim()
      expect(loaded?.content).toBe(body)
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
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
      await writeFile(join(root, 'office-docx', 'SKILL.md'), `---\n${header}\n---\n\n${body}\n`.replaceAll('\n', newline))
      await ctx.plugin(SkillRegistry)
      await ctx.plugin(SkillOffice, { assetRoot: root })
      const skill = await ctx.skills.get('office-docx')
      expect(skill?.description).toBe(description)
      expect(skill?.content).toBe(body.replaceAll('\n', newline))
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects relative resource paths before registration', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SkillRegistry)
      expect(() => { SkillOffice.apply(ctx, { assetRoot: 'assets' }) }).toThrow('absolute directory')
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
      const docx = join(root, 'office-docx', 'SKILL.md')
      const original = await readFile(docx, 'utf8')
      const remaining = names.filter(name => name !== 'office-docx')
      const catalog = async () => {
        const snapshot = await ctx.skills.snapshot()
        return { complete: snapshot.complete, names: snapshot.skills.map(skill => skill.name) }
      }
      await rm(docx)
      let fiber = await ctx.plugin(SkillOffice, { assetRoot: root })
      expect(await catalog()).toEqual({ complete: true, names: remaining })
      expect((await ctx.skills.get('office-xlsx'))?.content).toContain('openpyxl')
      expect(warnings).toEqual([expect.stringMatching(/^skill-office: skill "office-docx" is unavailable: Error: ENOENT.*SKILL\.md/u)])
      await fiber.dispose()
      const invalid: [content: string, failure: string][] = [
        ['# Missing frontmatter\ndescription: body text\n', 'has no YAML frontmatter'],
        ...['', 'null', 'scalar', 'name: office-docx', 'description: 3', 'description: ""']
          .map((header): [string, string] => [`---\n${header}\n---\n# Instructions\n`, 'has no description']),
        // YAML parse errors carry their own codes; they persist like other invalid metadata.
        ['---\ndescription: [unclosed\n---\n# Instructions\n', 'YAMLParseError'],
      ]
      for (const [content, failure] of invalid) {
        await writeFile(docx, content)
        fiber = await ctx.plugin(SkillOffice, { assetRoot: root })
        expect(await catalog()).toEqual({ complete: true, names: remaining })
        expect(warnings.at(-1)).toContain(failure)
        await fiber.dispose()
      }
      await writeFile(docx, original)
      const registerProvider = vi.spyOn(ctx.skills, 'registerProvider')
      await ctx.plugin(SkillOffice, { assetRoot: root })
      expect(await catalog()).toEqual({ complete: true, names })
      const reported = warnings.length
      await rm(docx)
      expect(await ctx.skills.get('office-docx')).toBeUndefined()
      expect(warnings).toHaveLength(reported + 1)
      expect(await catalog()).toEqual({ complete: true, names: remaining })
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
      await writeFile(join(root, 'office-docx', 'SKILL.md'), '---\ndescription: [unclosed\n---\n# Instructions\n')
      expect(await ctx.skills.get('office-docx')).toBeUndefined()
      const snapshot = await ctx.skills.snapshot()
      expect({ complete: snapshot.complete, names: snapshot.skills.map(skill => skill.name) })
        .toEqual({ complete: true, names: names.filter(name => name !== 'office-docx') })
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
      const docx = join(root, 'office-docx', 'SKILL.md')
      const original = await readFile(docx, 'utf8')
      const catalog = async () => {
        const snapshot = await ctx.skills.snapshot()
        return { complete: snapshot.complete, names: snapshot.skills.map(skill => skill.name) }
      }
      await rm(docx)
      // Reading a directory fails with EISDIR, standing in for a lock or permission error.
      await mkdir(docx)
      await ctx.plugin(SkillOffice, { assetRoot: root })
      expect(await catalog()).toEqual({ complete: false, names: names.filter(name => name !== 'office-docx') })
      await rm(docx, { recursive: true })
      await writeFile(docx, original)
      expect(await catalog()).toEqual({ complete: true, names })
      await rm(docx)
      await mkdir(docx)
      await expect(ctx.skills.get('office-docx')).rejects.toMatchObject({ code: 'EISDIR' })
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})

it('executes capabilities using only paths returned by the loaded skill from a separate workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'office CLI 工作目录 '))
  const ctx = new Context()
  try {
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(SkillOffice)
    const skill = await ctx.skills.get('office-render')
    const json = skill?.content.match(/\n(\{\n[\s\S]+)$/u)?.[1]
    expect(json).toBeDefined()
    const { libreofficeKit } = JSON.parse(json!) as { libreofficeKit: { node: string; cli: string } }
    const result = await execa(libreofficeKit.node, [libreofficeKit.cli, 'capabilities'], {
      cwd: root, env: { PATH: '' }, timeout: 20_000, killSignal: 'SIGKILL', reject: false,
    })
    expect(result.timedOut, result.stderr).toBe(false)
    expect(result.signal, result.stderr).toBeUndefined()
    expect(result.exitCode, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ runtime: { version: '0.2.3-rc.4', cliPath: libreofficeKit.cli } })
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})


it('validates operation paths on loading while authoring remains available', async () => {
  const ctx = new Context()
  const original = Object.getOwnPropertyDescriptor(process.versions, 'electron')
  try {
    await ctx.plugin(SkillRegistry)
    for (const config of [{ node: 'node' }, { cli: 'cli.js' }, { node: assets }, { cli: assets }, { cli: join(assets, 'missing.js') }]) {
      const fiber = await ctx.plugin(SkillOffice, config)
      expect((await ctx.skills.get('office-docx'))?.content).toContain('python-docx')
      await expect(ctx.skills.get('office-render')).rejects.toThrow()
      await fiber.dispose()
    }
    const carrier = await ctx.plugin(SkillOffice)
    vi.mocked(isSea).mockReturnValue(true)
    await expect(ctx.skills.get('office-render')).rejects.toThrow('standalone Node')
    vi.mocked(isSea).mockReturnValue(false)
    Object.defineProperty(process.versions, 'electron', { value: '44.0.0', configurable: true })
    await expect(ctx.skills.get('office-render')).rejects.toThrow('standalone Node')
    await carrier.dispose()
    const disabled = await ctx.plugin(SkillOffice, { cli: false })
    expect((await ctx.skills.get('office-render'))?.content).toContain('disabled in this deployment')
    await disabled.dispose()
    await ctx.plugin(SkillOffice, { node: process.execPath })
    expect((await ctx.skills.get('office-render'))?.content).toContain(JSON.stringify(process.execPath))
  } finally {
    vi.mocked(isSea).mockReturnValue(false)
    if (original === undefined) Reflect.deleteProperty(process.versions, 'electron')
    else Object.defineProperty(process.versions, 'electron', original)
    await ctx.fiber.dispose()
  }
})
