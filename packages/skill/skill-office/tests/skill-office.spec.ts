import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillOffice from '@deepseek-ai/dsh-skill-office'
import { isSea } from 'node:sea'
import { describe, expect, it, vi } from 'vitest'
import { execa } from 'execa'

vi.mock('node:sea', () => ({ isSea: vi.fn(() => false) }))

const assets = fileURLToPath(new URL('../assets/', import.meta.url))
const names = ['office-docx', 'office-pptx', 'office-xlsx']

describe('bundled Office skills', () => {
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
        expect(loaded?.resourceBase).toEqual({ kind: 'directory', path: join(assets, skill.name) })
        const raw = await readFile(join(assets, skill.name, 'SKILL.md'), 'utf8')
        expect(loaded?.content).toContain(raw.slice(raw.indexOf('\n---\n') + 5).trim())
        expect(loaded?.content).toContain(JSON.stringify(process.execPath))
        expect(loaded?.content).toContain('libreofficeKit')
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
        async import(specifier: string) {
          if (!modules.has(specifier)) throw new Error(`Unexpected Loader import: ${specifier}`)
          return modules.get(specifier)
        },
      } as unknown as NonNullable<typeof ctx.loader.internal>
      await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
      await ctx.loader.await()
      expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(names)
      const loaded = await ctx.skills.get('office-xlsx')
      expect(loaded?.resourceBase).toEqual({ kind: 'directory', path: join(external, 'office-xlsx') })
      const raw = await readFile(join(external, 'office-xlsx', 'SKILL.md'), 'utf8')
      expect(loaded?.content).toContain(raw.slice(raw.indexOf('\n---\n') + 5).trim())
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
      await ctx.plugin(SkillOffice, { assetRoot: root, cli: false })
      const skill = await ctx.skills.get('office-docx')
      expect(skill?.description).toBe(description)
      expect(skill?.content).toBe(body.replaceAll('\n', newline) + '\n\nLibreOffice Kit is disabled in this deployment.')
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects relative resource paths and incomplete asset trees before registration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-office-invalid-'))
    const ctx = new Context()
    try {
      await ctx.plugin(SkillRegistry)
      expect(() => { SkillOffice.apply(ctx, { assetRoot: 'assets' }) }).toThrow('absolute directory')
      await cp(assets, root, { recursive: true })
      await rm(join(root, 'scripts', 'check_office.py'))
      await cp(join(assets, 'office-docx'), join(root, 'scripts', 'check_office.py'), { recursive: true })
      expect(() => { SkillOffice.apply(ctx, { assetRoot: root }) }).toThrow('scripts/check_office.py')
      await rm(join(root, 'scripts', 'check_office.py'), { recursive: true })
      await cp(join(assets, 'scripts', 'check_office.py'), join(root, 'scripts', 'check_office.py'))
      await writeFile(join(root, 'office-docx', 'SKILL.md'), '# Missing frontmatter\ndescription: body text\n')
      expect(() => { SkillOffice.apply(ctx, { assetRoot: root }) }).toThrow('has no YAML frontmatter')
      for (const header of ['', 'null', 'scalar', 'name: office-docx', 'description: 3', 'description: ""']) {
        await writeFile(join(root, 'office-docx', 'SKILL.md'), `---\n${header}\n---\n# Instructions\n`)
        expect(() => { SkillOffice.apply(ctx, { assetRoot: root }) }).toThrow('has no description')
      }
      expect(await ctx.skills.list()).toEqual([])
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})

it('rejects unavailable CLI and Node paths before exposing an executable command', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-office-command-'))
  const ctx = new Context()
  try {
    await ctx.plugin(SkillRegistry)
    for (const config of [{ node: 'node' }, { cli: 'cli.js' }, { node: root }, { cli: root }, { cli: join(root, 'missing.js') }]) {
      expect(() => { SkillOffice.apply(ctx, config) }).toThrow()
      expect(await ctx.skills.list()).toEqual([])
    }
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

it('executes capabilities using only paths returned by the loaded skill from a separate workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'office CLI 工作目录 '))
  const ctx = new Context()
  try {
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(SkillOffice)
    const skill = await ctx.skills.get('office-docx')
    const json = skill?.content.match(/\n(\{\n[\s\S]+)$/u)?.[1]
    expect(json).toBeDefined()
    const { libreofficeKit } = JSON.parse(json!) as { libreofficeKit: { node: string; cli: string } }
    const result = await execa(libreofficeKit.node, [libreofficeKit.cli, 'capabilities'], {
      cwd: root, env: { PATH: '' }, timeout: 20_000, killSignal: 'SIGKILL', reject: false,
    })
    expect(result.timedOut, result.stderr).toBe(false)
    expect(result.signal, result.stderr).toBeUndefined()
    expect(result.exitCode, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ runtime: { version: '0.1.1', cliPath: libreofficeKit.cli } })
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

it('requires standalone Node in Electron and SEA, while permitting explicit CLI opt-out', async () => {
  const ctx = new Context()
  const original = Object.getOwnPropertyDescriptor(process.versions, 'electron')
  try {
    await ctx.plugin(SkillRegistry)
    vi.mocked(isSea).mockReturnValue(true)
    expect(() => { SkillOffice.apply(ctx) }).toThrow('standalone Node')
    vi.mocked(isSea).mockReturnValue(false)
    Object.defineProperty(process.versions, 'electron', { value: '44.0.0', configurable: true })
    expect(() => { SkillOffice.apply(ctx) }).toThrow('standalone Node')
    const fiber = await ctx.plugin(SkillOffice, { cli: false })
    expect((await ctx.skills.get('office-docx'))?.content).toContain('disabled in this deployment')
    await fiber.dispose()
    await ctx.plugin(SkillOffice, { node: process.execPath })
    expect((await ctx.skills.get('office-docx'))?.content).toContain(JSON.stringify(process.execPath))
  } finally {
    vi.mocked(isSea).mockReturnValue(false)
    if (original === undefined) Reflect.deleteProperty(process.versions, 'electron')
    else Object.defineProperty(process.versions, 'electron', original)
    await ctx.fiber.dispose()
  }
})
