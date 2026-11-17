/** Loader rc.9 and Include 1.2 entry validation, located config errors and module lookup failures. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context, FiberState } from '@deepseek-ai/cordis'
import Loader, { EntryValidationError, Group, ModuleNotFoundError, type EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import Include, { ConfigFileError } from '@deepseek-ai/cordis-plugin-include'
import Schema from '@deepseek-ai/schemastery'
import { describe, expect, it, onTestFinished } from 'vitest'

const Typed = Object.assign((_ctx: Context, _config: { value: number }) => {}, {
  Config: Schema.object({ value: Schema.number().required() }),
})

// `rows.yml` is the file the root Include reads; other files are reachable through nested includes.
async function fixture(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-loader-rc9-'))
  const pathOf = (name: string) => join(dir, name)
  for (const [name, content] of Object.entries(files)) await writeFile(pathOf(name), content)
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await rm(dir, { recursive: true, force: true, maxRetries: 3 })
  })
  const errors: unknown[] = []
  const warnings: unknown[] = []
  ctx.logger.exporter({
    export: ({ type, args }: { type: string; args: unknown[] }) => {
      if (type === 'error') errors.push(...args)
      if (type === 'warn') warnings.push(...args)
    },
  })
  ctx.baseUrl = pathToFileURL(dir).href + '/'
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, { include: Include, group: Group, example: () => {}, typed: Typed })
  const id = await ctx.loader.create({ name: 'cordis:include', config: { path: './rows.yml' } })
  await ctx.loader.await()
  const entry = ctx.loader.resolve(id)
  return { ctx, path: pathOf('rows.yml'), pathOf, entry, include: entry.subtree as Include | undefined, errors, warnings }
}

describe('Loader 1.0.0-rc.9 entry options', () => {
  it('rejects invalid options before a tree changes', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(Loader)
    ctx.loader.builtins.example = () => {}
    // Options read from a file are untyped; set the invalid values past the compiler.
    const invalid = { name: 'cordis:example' } as EntryOptions
    Reflect.set(invalid, 'disabled', 'yes')
    Reflect.set(invalid, 'isolate', { svc: 1 })
    const error = await ctx.loader.create(invalid).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(EntryValidationError)
    expect((error as EntryValidationError).issues).toEqual([
      { message: 'disabled must be a boolean', path: ['disabled'] },
      { message: 'isolate.svc must be true or a string', path: ['isolate', 'svc'] },
    ])
    expect(ctx.loader.root.data).toEqual([])
    await expect(ctx.loader.create({ name: 'cordis:example', group: true })).rejects.toThrow('config is required')
  })

  it('accepts explicit ids containing the separator from a file', async () => {
    const app = await fixture({ 'rows.yml': '- id: pkg:row\n  name: cordis:example\n' })
    expect(app.include!.store['pkg:row']!.fiber!.state).toBe(FiberState.ACTIVE)
  })
})

describe('Include 1.2.0 config files', () => {
  it('reports invalid entries and config values at their file positions', async () => {
    const app = await fixture({ 'rows.yml': [
      '- id: bad',
      '  name: cordis:example',
      '  disabled: 1',
      '- id: typed',
      '  name: cordis:typed',
      '  config:',
      '    value: text',
      '',
    ].join('\n') })
    const messages = app.errors.map(String).join('\n')
    expect(messages).toContain(`disabled must be a boolean (at disabled, ${app.path}:3:13)`)
    expect(messages).toContain(`${app.path}:7:12`)
    expect(app.include!.store['bad']).toBeUndefined()
    expect(app.include!.store['typed']!.fiber!.state).not.toBe(FiberState.ACTIVE)
  })

  it('reports an unknown plugin module at its name position', async () => {
    const app = await fixture({ 'rows.yml': '- id: missing\n  name: ./missing-plugin.js\n' })
    const error = app.errors.find(error => error instanceof ModuleNotFoundError)
    expect(error?.specifier).toBe('./missing-plugin.js')
    expect(error?.message).toContain(`(at name, ${app.path}:2:9)`)
  })

  it('parses YAML 1.2 core scalars and locates syntax errors', async () => {
    const app = await fixture({ 'rows.yml': '- id: typed\n  name: cordis:typed\n  config:\n    value: 0x10\n' })
    expect(app.include!.store['typed']!.fiber!.effectiveConfig).toEqual({ value: 16 })
    await writeFile(app.path, '- id: typed\n  name: [\n')
    await app.include!.refresh()
    const error = app.warnings.find(warning => warning instanceof ConfigFileError)
    expect(error).toBeInstanceOf(ConfigFileError)
    expect((error as ConfigFileError).issues[0]!.location).toMatchObject({ filename: app.path, line: 3 })
  })

  it('rejects a file with a non-mapping entry at its position', async () => {
    const app = await fixture({ 'rows.yml': '- id: ok\n  name: cordis:example\n- id: g\n  name: cordis:group\n  group: true\n  config:\n    - plain\n' })
    const error = app.errors.find(error => error instanceof ConfigFileError)
    expect(error?.issues).toEqual([{ message: 'entry must be an object', location: { filename: app.path, line: 7, column: 7 } }])
    expect(app.entry.fiber!.state).not.toBe(FiberState.ACTIVE)
  })

  it('locates an unresolved alias as a parse error', async () => {
    const app = await fixture({ 'rows.yml': '- id: typed\n  name: cordis:typed\n  config: *missing\n' })
    const error = app.errors.find(error => error instanceof ConfigFileError)
    expect(error?.stage).toBe('parse')
    expect(error?.issues[0]!.location).toEqual({ filename: app.path, line: 3, column: 11 })
  })

  it.each([
    ['an override', '    patches:\n      - id: typed\n        config:\n          value: text\n', '- id: typed\n  name: cordis:typed\n  config:\n    value: 1\n', 8],
    ['an inserted entry', '    patches:\n      - insert:\n          - id: typed\n            name: cordis:typed\n            config:\n              value: text\n', '[]\n', 10],
  ])('locates a config value supplied by %s in the parent file', async (_kind, patches, inner, line) => {
    const app = await fixture({
      'rows.yml': `- id: inner\n  name: cordis:include\n  config:\n    path: ./inner.yml\n${patches}`,
      'inner.yml': inner,
    })
    expect(app.errors.map(String).join('\n')).toContain(`(at value, ${app.path}:${String(line)}:`)
  })
})
