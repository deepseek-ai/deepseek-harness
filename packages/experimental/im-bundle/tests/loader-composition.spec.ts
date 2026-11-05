/**
 * The IM bundle as an operator composes it: the rows the patch declares, the configuration each plugin really
 * receives once its own schema applied the defaults, and a real Loader boot in which a `FakeAdapter` stands in for
 * the Feishu application (no network, no credentials).
 *
 * The boot mounts the real `satori` core and a real `FakeAdapter`, and stands the rest of the plane up with
 * service fakes: the point of this suite is the bundle's composition — which rows exist, in which order, with which
 * injects and config — not the behaviour of the single packages, which their own suites own.
 */

import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as yaml from 'js-yaml'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, type Plugin } from '@deepseek-ai/cordis'
import Include, { entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { Satori } from '@deepseek-ai/cordis-plugin-im-core'
import * as Markdown from '@deepseek-ai/cordis-plugin-im-markdown'
import { FakeAdapter, createTextMode } from '@deepseek-ai/cordis-plugin-im-core/src/testing.ts'
import LarkBot from '@deepseek-ai/cordis-plugin-im-adapter-lark'
import { Config as QQConfig } from '@deepseek-ai/cordis-plugin-im-adapter-qq'
import type { ImMessageEvent } from '@deepseek-ai/dsh-im'
import { Config as ImConfig } from '@deepseek-ai/dsh-im/src/config.ts'
import { Config as CommandsConfig } from '@deepseek-ai/dsh-im-session-commands'
import * as SessionCommands from '@deepseek-ai/dsh-im-session-commands'

/**
 * Install a stand-in for one service the bundle only needs to see mounted. The typed `provide` overload demands the
 * real service class, so this uses the Context API's untyped name overload, which exists for names outside the typed
 * surface: the composition under test never calls into these stand-ins.
 * @param ctx - context of the plugin that would own the service.
 * @param name - service name the stand-in registers.
 * @param value - the stand-in implementation.
 */
function installStandIn(ctx: Context, name: string, value: unknown): void {
  ctx.provide(name, value)
}

const PATCH = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))

/** One inserted row of the bundle patch. */
interface Row {
  id?: string
  name?: string
  disabled?: boolean
  inject?: string[]
  config?: Record<string, unknown>
}

/** The `!!js` expression a patch scalar carries instead of a literal value. */
interface JsExpr {
  __jsExpr: string
}

interface PatchList {
  id?: string
  disabled?: boolean
  insert?: Row[]
}

/** Every patch of the bundle file, with the `!!js` scalars as expression nodes. */
function patches(): PatchOptions[] {
  return yaml.load(readFileSync(PATCH, 'utf8'), { schema: entryListSchema }) as PatchOptions[]
}

/** The rows the patch inserts, in declaration order. */
function rows(): Row[] {
  return (patches() as PatchList[]).flatMap(patch => patch.insert ?? [])
}

/**
 * Turn the expression nodes of one config into the expression text, so a schema can validate the row and a snapshot
 * can show which environment variable an operator-supplied value comes from.
 * @param value - one patch config value.
 * @returns the same shape with every `!!js` scalar replaced by its source text.
 */
function source(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(source)
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (typeof record['__jsExpr'] === 'string') return (value as JsExpr).__jsExpr
    return Object.fromEntries(Object.entries(record).map(([key, entry]) => [key, source(entry)]))
  }
  return value
}

/**
 * Rows whose plugin exports a config schema: the rendered-config snapshot covers exactly these. Each schema has its
 * own input type, so the map is keyed by row id and applied to the patch's plain data.
 */
type Schema = (config: never) => unknown

const SCHEMAS: Record<string, Schema> = {
  im: ImConfig,
  'im-session-commands': CommandsConfig,
  'im-feishu': LarkBot.Config,
  // `QQBot` declares no static `Config`; the schema is exported from its config module.
  'im-qq': QQConfig,
}

describe('IM bundle rows', () => {
  it('declares the IM plane: core, markdown, both adapters, host, commands', () => {
    expect(rows().map(row => [row.id, row.name])).toEqual([
      ['im-http', '@deepseek-ai/cordis-plugin-http'],
      ['im-core', '@deepseek-ai/cordis-plugin-im-core'],
      ['im-markdown', '@deepseek-ai/cordis-plugin-im-markdown'],
      ['im-feishu', '@deepseek-ai/cordis-plugin-im-adapter-lark'],
      ['im-qq', '@deepseek-ai/cordis-plugin-im-adapter-qq'],
      ['im', '@deepseek-ai/dsh-im'],
      ['im-session-commands', '@deepseek-ai/dsh-im-session-commands'],
    ])
  })

  it('inserts Host rows only, without an application entry or profile override', () => {
    expect((patches() as PatchList[]).every(patch => patch.id === undefined && patch.insert !== undefined)).toBe(true)
    expect(rows().every(row => row.inject === undefined)).toBe(true)
  })

  it('ships the Lark application with card streaming and the QQ adapter switched off', () => {
    expect(rows().find(row => row.id === 'im-feishu')?.config).toEqual({
      appId: { __jsExpr: 'process.env.DSH_FEISHU_APP_ID' },
      appSecret: { __jsExpr: 'process.env.DSH_FEISHU_APP_SECRET' },
      cardStreaming: true,
      callbacks: true,
    })
    expect(rows().find(row => row.id === 'im-qq')).toMatchObject({
      disabled: true,
      config: {
        appId: { __jsExpr: 'process.env.DSH_QQ_APP_ID' },
        secret: { __jsExpr: 'process.env.DSH_QQ_APP_SECRET' },
      },
    })
  })

  it('admits nothing and dispatches nothing until an operator adds sources and the default dispatch', () => {
    expect(rows().find(row => row.id === 'im')?.config).toEqual({ sources: [] })
  })

  it('renders every configurable row through its own schema', () => {
    const rendered = rows()
      .filter(row => row.id !== undefined && row.id in SCHEMAS)
      .map((row) => {
        const config = SCHEMAS[row.id!]!(source(row.config ?? {}) as never) as Record<string, unknown>
        return { id: row.id, config }
      })
    expect(rendered.map(row => row.id)).toEqual([
      'im-feishu',
      'im-qq',
      'im',
      'im-session-commands',
    ])
    expect(rendered).toMatchSnapshot()
  })
})

/** One observed boot of the bundle. */
interface Booted {
  ctx: Context
  /** Rows whose fake module ran, in activation order. */
  applied: string[]
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/**
 * Boot the bundle patch on a real Loader, with the Feishu module replaced by a `FakeAdapter`.
 * @returns the live context and what the boot observed.
 */
async function boot(): Promise<Booted> {
  root = await mkdtemp(join(tmpdir(), 'dsh-im-bundle-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, '[]\n')
  const applied: string[] = []

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include

  const im = { sessions: {} }
  // Every fixture that consumes the IM host declares it, exactly as the real plugin's `inject` does: a row is
  // activated only once the host exists, independently of the declaration order of the patch.
  const fake = (name: string, injects: string[] = [], apply: (ctx: Context) => void = () => {}): Plugin.Object => ({
    name,
    inject: injects,
    apply: (ctx: Context) => { applied.push(name); apply(ctx) },
  })
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/cordis-plugin-http', fake('im-http')],
    ['@deepseek-ai/cordis-plugin-im-core', Satori],
    ['@deepseek-ai/cordis-plugin-im-markdown', Markdown],
    // The adapter override: the Feishu application module is replaced by the in-memory fake platform.
    ['fixture:fake-adapter', fake('im-feishu', [], (child) => {
      child.plugin(FakeAdapter, { modes: { text: createTextMode() }, selfId: 'cli_fake' })
    })],
    ['@deepseek-ai/cordis-plugin-im-adapter-qq', fake('im-qq')],
    ['@deepseek-ai/dsh-im', fake('im', [], (child) => { child.provide('im', im) })],
    ['@deepseek-ai/dsh-im-session-commands', fake('im-session-commands', ['im'])],
  ])
  // The Loader's module map (`internal`) is Node's own surface; this fixture only needs its `import()`.
  Object.defineProperty(ctx.loader, 'internal', {
    configurable: true,
    value: {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    },
  })

  const list = patches()
  for (const row of list.flatMap(patch => (patch.insert ?? []) as Row[])) {
    if (row.id !== 'im-feishu') continue
    row.name = 'fixture:fake-adapter'
    delete row.config
  }
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href, patches: list } })
  await ctx.loader.await()

  return { ctx, applied }
}

/** Ids of the rows the Loader left unactivated (disabled rows are expected to be here). */
function inactive(ctx: Context): string[] {
  return [...ctx.loader.entries()]
    .filter(entry => entry.fiber === undefined)
    .map(entry => entry.options.id ?? '')
}

describe('IM bundle Loader composition', () => {
  it('boots every enabled row with a FakeAdapter in place of the Feishu application', async () => {
    const booted = await boot()

    expect([...booted.applied].sort()).toEqual([
      'im',
      'im-feishu',
      'im-http',
      'im-session-commands',
    ])
    // The only disabled row is the QQ adapter.
    expect(inactive(booted.ctx).sort()).toEqual(['im-qq'])
    const bot = booted.ctx.satori.bots[0]
    expect(bot).toBeInstanceOf(FakeAdapter)
    expect(bot?.id).toBe('fake:bot')
  })
})

describe('IM bundle command routing', () => {
  it('keeps session-commands ahead of the other listeners in the waterfall', async () => {
    const ctx = new Context()
    context = ctx
    const replies: unknown[] = []
    const reached: string[] = []
    installStandIn(ctx, 'im', { sessions: { forChat: () => [], stop: async () => true } })
    installStandIn(ctx, 'commands', { list: () => [] })
    ctx.provide('agents', {} as Context['agents'])
    // A strategy listener registered BEFORE the plugin still sees nothing: the bundle mounts session-commands,
    // and that plugin prepends itself, so a command never reaches a strategy as model input.
    ctx.on('im/message', async (_event, next) => {
      reached.push('strategy')
      return next()
    })
    await ctx.plugin(SessionCommands, CommandsConfig({ allow: 'all', admins: [], passthrough: ['compact'], resettable: ['dispatcher'], locale: 'zh' }))
    const event = {
      message: {
        command: { name: 'help', rawInput: '' },
        addressed: true,
        chat: { key: 'fake:bot|chat' },
      },
      reply: async (content: unknown) => {
        replies.push(content)
        return { status: 'confirmed' }
      },
    } as ImMessageEvent
    const outcome = await ctx.waterfall('im/message', event, async () => ({ kind: 'ignored' }))
    expect(outcome).toMatchObject({ kind: 'handled', by: 'session-commands' })
    expect(reached).toEqual([])
    expect(replies).toHaveLength(1)
  })
})

