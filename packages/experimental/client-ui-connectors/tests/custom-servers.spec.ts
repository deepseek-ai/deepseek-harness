/**
 * The `connectors` service streams the MCP server rows of the profile's composition, changes one as a single Host
 * operation that stops at the first refused step, and shows the account of each OAuth server row that is on.
 */
import { Context, FiberState } from '@deepseek-ai/cordis'
import type { ChangeResult } from '@deepseek-ai/dsh-plugin-manager'
import { expect, it, onTestFinished, vi } from 'vitest'
import Connectors from '../src/index.ts'
import { emptyDraft } from '../src/server-form.ts'
import type { CustomServersList, ServerDraft } from '../src/types.ts'

const SERVER_ROW = '@deepseek-ai/dsh-mcp-manager/server'
const DOCS_URL = 'https://docs.example/mcp'
const DOCS = { serverName: 'docs', transport: 'streamable-http', url: DOCS_URL, headers: { 'X-Old': '${credential:MCP_DOCS_HEADER_X_OLD}' } }
const OAUTH = { serverName: 'docs', transport: 'streamable-http', url: DOCS_URL, headers: {}, oauth: { credentialKey: 'mcp-client/docs' } }
const WIKI_OAUTH = { ...OAUTH, serverName: 'wiki', oauth: { credentialKey: 'mcp-client/wiki' } }
const PLAIN: ServerDraft = { ...emptyDraft(), name: 'docs', url: DOCS_URL }
const TOKEN: ServerDraft = { ...PLAIN, auth: 'token', token: 't0ken' }
const UNAVAILABLE = 'custom MCP servers need the profile configuration editor, the plugin manager, credentials, and the MCP manager'
const NOT_EDITABLE = 'the server row cannot be edited: it is gone, the form cannot read it, or the draft renames it'

/** One row of the composition the configuration editor double lists. */
interface Seed {
  readonly config?: unknown
  /** The row's module; the MCP manager's server row plugin when omitted. */
  readonly module?: string
  /** A bundle adds the row, so no `insert` item of the profile patch lists it. */
  readonly bundle?: boolean
  off?: boolean
  /**
   * Why a row that is switched on does not run: its `disabled` expression throws, its plugin did not start, it waits
   * for a service, or the Loader holds no fiber for it.
   */
  readonly stalled?: 'switch' | 'start' | 'waiting' | 'unloaded'
  /** Settles when the row's lifecycle work is over. */
  readonly starting?: Promise<void>
}

/** The fields of a Loader entry the service reads. */
interface RowEntry {
  readonly id: string
  readonly options: { readonly id: string; readonly name: string; config?: unknown }
  readonly disabled: boolean
  readonly fiber: { readonly state: FiberState; await(): Promise<void> } | undefined
}

interface Setup {
  /** The service the profile lacks. */
  readonly without?: 'configEditor' | 'pluginManager' | 'credentials' | 'mcpManager'
  /** Whether the MCP account service runs. */
  readonly accounts?: boolean
}

function entryOf(id: string, seed: Seed): RowEntry {
  const state = seed.stalled === 'start' ? FiberState.FAILED : seed.stalled === 'waiting' ? FiberState.PENDING : FiberState.ACTIVE
  const fiber = {
    state,
    async await(): Promise<void> {
      await seed.starting
      if (seed.stalled === 'start') throw new Error('connection refused')
    },
  }
  return {
    // Profile rows load under the Loader entry `include`.
    id: `include:${id}`,
    options: { id, name: seed.module ?? SERVER_ROW, config: seed.config },
    get disabled(): boolean {
      if (seed.stalled === 'switch') throw new Error('MCP_DOCS_ON is not defined')
      return seed.off === true
    },
    fiber: seed.stalled === 'unloaded' ? undefined : fiber,
  }
}

async function next(lists: AsyncIterator<CustomServersList>): Promise<CustomServersList> {
  const item = await lists.next()
  if (item.done === true) throw new Error('the stream ended')
  return item.value
}

/** The list a new subscription starts with. */
async function read(service: Connectors): Promise<CustomServersList> {
  const stop = new AbortController()
  const lists = service.watchServers(stop.signal)[Symbol.asyncIterator]()
  const list = await next(lists)
  stop.abort()
  await lists.next()
  return list
}

function warnings(ctx: Context): unknown[] {
  return ctx.logger.buffer.filter(message => message.type === 'warn').map((message): unknown => message.args)
}

/** Let every continuation that is already due run. */
function settled(): Promise<void> {
  return new Promise((resolve) => { setImmediate(resolve) })
}

async function bench(seeds: Record<string, Seed> = { docs: { config: DOCS } }, setup: Setup = {}) {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const calls: string[] = []
  const rows = new Map<string, { seed: Seed; entry: RowEntry }>()
  const put = (name: string, seed: Seed): void => {
    const id = `mcp-server-${name}`
    rows.set(id, { seed, entry: entryOf(id, seed) })
  }
  for (const [name, seed] of Object.entries(seeds)) put(name, seed)
  const configuration = vi.fn(() => [...rows.values()].map(({ seed, entry }) => (
    { entry, inherited: {}, override: {}, inserted: seed.bundle !== true }
  )))
  const editRow = vi.fn(async (entry: RowEntry, change: (current: unknown, inherited: unknown) => Record<string, unknown>) => {
    entry.options.config = change(structuredClone(entry.options.config ?? {}), {})
    calls.push(`editRow ${entry.options.id}`)
  })
  const insert = vi.fn(async (row: { id: string; name: string; config: Record<string, unknown> }) => {
    const seed = { config: row.config, module: row.name }
    rows.set(row.id, { seed, entry: entryOf(row.id, seed) })
    calls.push(`insert ${row.id}`)
  })
  const remove = vi.fn(async (entry: RowEntry) => {
    rows.delete(entry.options.id)
    calls.push(`remove ${entry.options.id}`)
  })
  const setPluginEnabled = vi.fn(async (id: string, enabled: boolean): Promise<ChangeResult> => {
    for (const { seed, entry } of rows.values()) if (entry.id === id) seed.off = !enabled
    calls.push(`switch ${id} ${enabled ? 'on' : 'off'}`)
    return { changed: true, application: 'applied', stage: 'enable', target: id }
  })
  const set = vi.fn(async (ref: string, _value: string) => { calls.push(`set ${ref}`) })
  const unset = vi.fn(async (ref: string) => { calls.push(`unset ${ref}`) })
  const deleteRecord = vi.fn(async (key: string) => { calls.push(`deleteRecord ${key}`) })
  const signOut = vi.fn(async (name: string) => { calls.push(`signOut ${name}`) })
  /** The servers the MCP manager double lists. */
  const managed: { name: string; configured: boolean }[] = []
  const withdrawn: string[] = []
  const register = vi.fn((registration: { server: string }) => () => { withdrawn.push(registration.server) })
  const doubles = {
    configEditor: { configuration, editRow, insert, remove },
    pluginManager: { setPluginEnabled },
    credentials: { set, unset, deleteRecord },
    mcpManager: { signOut, list: () => managed },
  }
  for (const [name, double] of Object.entries(doubles)) {
    if (name !== setup.without) ctx.provide(name, double)
  }
  if (setup.accounts === true) ctx.provide('mcpAccounts', { register })
  const fiber = ctx.plugin(Connectors)
  await fiber
  const service = ctx.get('connectors')
  if (service === undefined) throw new Error('the connectors service did not start')
  return {
    ctx, fiber, service, calls, configuration, editRow, insert, remove, setPluginEnabled, set, unset, deleteRecord, signOut, managed,
    register, withdrawn, put,
    /** Take a row out of the composition as another writer would. */
    drop(name: string): void { rows.delete(`mcp-server-${name}`) },
    /** The row as the composition holds it. */
    options(name: string): RowEntry['options'] | undefined { return rows.get(`mcp-server-${name}`)?.entry.options },
    /** The revision of the rows as they are. */
    async revision(): Promise<string> {
      const list = await read(service)
      if (!list.available) throw new Error('the profile holds no custom servers')
      return list.revision
    },
  }
}

it('lists every server row with its state, marking the rows a bundle adds and the rows the form cannot edit', async () => {
  const files = { serverName: 'files', transport: 'stdio', command: 'npx' }
  const b = await bench({
    docs: { config: DOCS, bundle: true },
    files: { config: files, off: true },
    odd: { config: { serverName: 'odd', transport: 'ws' } },
    code: { config: { serverName: 'code', transport: 'stdio', command: { __jsExpr: 'process.env.SHELL' } } },
    nameless: { config: { transport: 'stdio', command: 'npx' } },
    number: { config: 5 },
    list: { config: [] },
    nothing: { config: null },
    model: { config: DOCS, module: '@deepseek-ai/dsh-llm-deepseek' },
  })
  expect(await read(b.service)).toEqual({
    available: true,
    revision: expect.stringMatching(/^[0-9a-f]{64}$/) as string,
    servers: [
      { id: 'mcp-server-docs', name: 'docs', state: 'on', raw: DOCS, inherited: true },
      { id: 'mcp-server-files', name: 'files', state: 'off', raw: files, inherited: false },
      { id: 'mcp-server-odd', name: 'odd', state: 'on', inherited: false },
      { id: 'mcp-server-code', name: 'code', state: 'on', inherited: false },
      { id: 'mcp-server-nameless', name: 'mcp-server-nameless', state: 'on', inherited: false },
      { id: 'mcp-server-number', name: 'mcp-server-number', state: 'on', inherited: false },
      { id: 'mcp-server-list', name: 'mcp-server-list', state: 'on', inherited: false },
      { id: 'mcp-server-nothing', name: 'mcp-server-nothing', state: 'on', inherited: false },
    ],
  })
})

it('lists a row that is switched on and does not run as failed, with the reason', async () => {
  const b = await bench({
    refused: { config: { ...DOCS, serverName: 'refused' }, stalled: 'start' },
    expression: { config: { ...DOCS, serverName: 'expression' }, stalled: 'switch' },
    waiting: { config: { ...DOCS, serverName: 'waiting' }, stalled: 'waiting' },
    unloaded: { config: { ...DOCS, serverName: 'unloaded' }, stalled: 'unloaded' },
  })
  expect(await read(b.service)).toMatchObject({ servers: [
    { name: 'refused', state: 'failed', error: 'connection refused' },
    { name: 'expression', state: 'failed', error: 'MCP_DOCS_ON is not defined' },
    { name: 'waiting', state: 'failed', error: 'the server row is not running' },
    { name: 'unloaded', state: 'failed', error: 'the server row is not running' },
  ] })
})

it.each(['configEditor', 'pluginManager', 'credentials', 'mcpManager'] as const)(
  'lists nothing and refuses a change in a profile without the %s service',
  async (without) => {
    const b = await bench({ docs: { config: DOCS } }, { without })
    expect(await read(b.service)).toEqual({ available: false })
    await expect(b.service.setServerEnabled('mcp-server-docs', false, 'any')).rejects.toMatchObject({
      code: 'connectors/refused', message: UNAVAILABLE, details: { server: 'mcp-server-docs' },
    })
  },
)

it('streams a list at subscription, then after each reload, each plugin manager change, and each change made through the service', async () => {
  const b = await bench()
  const stop = new AbortController()
  const lists = b.service.watchServers(stop.signal)[Symbol.asyncIterator]()
  expect(await next(lists)).toMatchObject({ servers: [{ name: 'docs', state: 'on' }] })

  b.put('wiki', { config: { ...DOCS, serverName: 'wiki' } })
  b.ctx.emit('app-boot/config-reload')
  expect(await next(lists)).toMatchObject({ servers: [{ name: 'docs' }, { name: 'wiki', state: 'on' }] })

  b.put('wiki', { config: { ...DOCS, serverName: 'wiki' }, off: true })
  b.ctx.emit('plugin-manager/changed', { reason: 'plugin' })
  expect(await next(lists)).toMatchObject({ servers: [{ name: 'docs' }, { name: 'wiki', state: 'off' }] })

  await b.service.removeServer('mcp-server-wiki', await b.revision())
  expect(await next(lists)).toMatchObject({ servers: [{ name: 'docs' }] })

  stop.abort()
  expect(await lists.next()).toMatchObject({ done: true })
})

it('wakes its streams after a refused change, which can leave a row inactive without an event', async () => {
  const b = await bench()
  const lists = b.service.watchServers(new AbortController().signal)[Symbol.asyncIterator]()
  await next(lists)
  b.editRow.mockImplementationOnce(async () => {
    b.put('docs', { config: DOCS, stalled: 'start' })
    throw new Error('connection refused')
  })
  await expect(b.service.saveServer(PLAIN, await b.revision(), 'mcp-server-docs')).rejects.toMatchObject({ message: 'connection refused' })
  expect(await next(lists)).toMatchObject({ servers: [{ name: 'docs', state: 'failed', error: 'connection refused' }] })
})

it('ends its streams and withdraws the service when the plugin unloads', async () => {
  const b = await bench()
  const lists = b.service.watchServers(new AbortController().signal)[Symbol.asyncIterator]()
  await next(lists)
  const ended = lists.next()
  await b.fiber.dispose()
  expect(await ended).toMatchObject({ done: true })
  expect(b.ctx.get('connectors')).toBeUndefined()
})

it('adds a new server as a row of the profile patch, then stores its secrets', async () => {
  const b = await bench()
  await b.service.saveServer({ ...TOKEN, name: 'wiki', url: 'https://wiki.example/mcp' }, await b.revision())
  expect(b.options('wiki')).toEqual({
    id: 'mcp-server-wiki',
    name: SERVER_ROW,
    config: {
      serverName: 'wiki', transport: 'streamable-http', url: 'https://wiki.example/mcp',
      headers: { Authorization: 'Bearer ${credential:MCP_WIKI_TOKEN}' },
    },
  })
  expect(b.set).toHaveBeenCalledWith('MCP_WIKI_TOKEN', 't0ken')
  expect(b.calls).toEqual(['insert mcp-server-wiki', 'set MCP_WIKI_TOKEN'])
  expect(await read(b.service)).toMatchObject({ servers: [{ name: 'docs' }, { id: 'mcp-server-wiki', name: 'wiki', state: 'on', inherited: false }] })
})

it('writes the row before storing its new secrets, then deletes the secrets the row stopped using', async () => {
  const b = await bench()
  await b.service.saveServer(TOKEN, await b.revision(), 'mcp-server-docs')
  expect(b.options('docs')?.config).toEqual({
    serverName: 'docs', transport: 'streamable-http', url: DOCS_URL, headers: { Authorization: 'Bearer ${credential:MCP_DOCS_TOKEN}' },
  })
  expect(b.calls).toEqual(['editRow mcp-server-docs', 'set MCP_DOCS_TOKEN', 'unset MCP_DOCS_HEADER_X_OLD'])
})

it('keeps the fields of the previous config that the form does not show', async () => {
  const b = await bench({ docs: { config: { ...OAUTH, toolLoading: 'on-demand' } } })
  await b.service.saveServer({ ...PLAIN, auth: 'oauth' }, await b.revision(), 'mcp-server-docs')
  expect(b.options('docs')?.config).toEqual({ ...OAUTH, toolLoading: 'on-demand' })
})

it('keeps the grant an OAuth row names, under a server name that could not form a grant key', async () => {
  const oauth = { credentialKey: 'mcp-client/team-docs', requestTimeoutMs: 5000 }
  const b = await bench({ Docs_1: { config: { ...OAUTH, serverName: 'Docs_1', oauth } }, Wiki_1: { config: { ...DOCS, serverName: 'Wiki_1' } } })
  await b.service.saveServer({ ...PLAIN, name: 'Docs_1', auth: 'oauth', scope: 'read' }, await b.revision(), 'mcp-server-Docs_1')
  expect(b.options('Docs_1')?.config).toEqual({ ...OAUTH, serverName: 'Docs_1', oauth: { ...oauth, scope: 'read' } })
  // A row without a grant would name it after the server.
  await expect(b.service.saveServer({ ...PLAIN, name: 'Wiki_1', auth: 'oauth' }, await b.revision(), 'mcp-server-Wiki_1')).rejects.toMatchObject({
    code: 'connectors/refused', message: 'the server cannot be saved: name-oauth',
  })
  expect(b.calls).toEqual(['editRow mcp-server-Docs_1'])
})

it('refuses an edit of a row that is gone, that the form cannot read, or that the draft renames', async () => {
  const b = await bench({ docs: { config: DOCS }, odd: { config: { serverName: 'odd', transport: 'ws' } } })
  const revision = await b.revision()
  await expect(b.service.saveServer(PLAIN, revision, 'mcp-server-gone')).rejects.toMatchObject({
    code: 'connectors/refused', message: NOT_EDITABLE, details: { server: 'docs' },
  })
  await expect(b.service.saveServer({ ...PLAIN, name: 'odd' }, revision, 'mcp-server-odd')).rejects.toMatchObject({ message: NOT_EDITABLE })
  await expect(b.service.saveServer({ ...PLAIN, name: 'wiki' }, revision, 'mcp-server-docs')).rejects.toMatchObject({ message: NOT_EDITABLE })
  expect(b.calls).toEqual([])
})

it('refuses a draft the form would not save, and a change that names an older revision, before any step', async () => {
  const b = await bench({ docs: { config: DOCS }, Docs2: { config: { ...DOCS, serverName: 'Docs2' } } })
  const revision = await b.revision()
  await expect(b.service.saveServer({ ...TOKEN, name: 'bad name' }, revision)).rejects.toMatchObject({
    code: 'connectors/refused', message: 'the server cannot be saved: name-invalid', details: { server: 'bad name' },
  })
  await expect(b.service.saveServer({ ...TOKEN, name: 'docs2' }, revision)).rejects.toMatchObject({
    message: 'the server cannot be saved: name-taken',
  })
  await expect(b.service.removeServer('mcp-server-docs', 'older')).rejects.toMatchObject({
    code: 'connectors/conflict', message: 'the server rows changed; read the servers again', details: { server: 'mcp-server-docs' },
  })
  expect(b.calls).toEqual([])
})

it('refuses a draft that keeps a stored secret its row does not use', async () => {
  const b = await bench()
  const revision = await b.revision()
  const borrowed: ServerDraft = { ...PLAIN, headers: [{ key: 'X-Key', value: '', secret: true, ref: 'DEEPSEEK_API_KEY' }] }
  await expect(b.service.saveServer(borrowed, revision, 'mcp-server-docs')).rejects.toMatchObject({
    code: 'connectors/refused', message: 'the server names a credential reference its entry does not use',
  })
  await expect(b.service.saveServer({ ...TOKEN, token: '', tokenRef: 'DEEPSEEK_API_KEY' }, revision, 'mcp-server-docs'))
    .rejects.toMatchObject({ code: 'connectors/refused' })
  await expect(b.service.saveServer({ ...borrowed, name: 'wiki' }, revision)).rejects.toMatchObject({ code: 'connectors/refused' })
  const kept: ServerDraft = { ...PLAIN, headers: [{ key: 'X-Old', value: '', secret: true, ref: 'MCP_DOCS_HEADER_X_OLD' }] }
  await b.service.saveServer(kept, revision, 'mcp-server-docs')
  expect(b.calls).toEqual(['editRow mcp-server-docs'])
})

it('refuses a config the server row plugin would reject, before any step', async () => {
  const b = await bench({ docs: { config: { ...DOCS, startupTimeoutMs: 0 }, off: true } })
  await expect(b.service.saveServer(PLAIN, await b.revision(), 'mcp-server-docs')).rejects.toMatchObject({
    code: 'connectors/refused', message: expect.stringContaining('startupTimeoutMs') as string, details: { server: 'docs' },
  })
  expect(b.calls).toEqual([])
})

it('stores no secret after a refused or conflicting write, and keeps the written row when a secret is refused', async () => {
  const b = await bench()
  const revision = await b.revision()
  b.editRow.mockRejectedValueOnce(new Error('read-only profile'))
  await expect(b.service.saveServer(TOKEN, revision, 'mcp-server-docs')).rejects.toMatchObject({
    code: 'connectors/refused', message: 'read-only profile', details: { server: 'docs' },
  })
  b.editRow.mockRejectedValueOnce('storage failed')
  await expect(b.service.saveServer(TOKEN, revision, 'mcp-server-docs')).rejects.toMatchObject({
    code: 'connectors/refused', message: 'storage failed',
  })
  // Another writer changed the row between the revision check and the profile lock.
  b.editRow.mockImplementationOnce(async (_entry, change) => { change({ ...DOCS, url: 'https://moved.example/mcp' }, {}) })
  await expect(b.service.saveServer(TOKEN, revision, 'mcp-server-docs')).rejects.toMatchObject({
    code: 'connectors/conflict', details: { server: 'docs' },
  })
  b.insert.mockRejectedValueOnce(new Error('Configuration entry "mcp-server-wiki" already exists'))
  await expect(b.service.saveServer({ ...TOKEN, name: 'wiki' }, revision)).rejects.toMatchObject({
    code: 'connectors/refused', message: 'Configuration entry "mcp-server-wiki" already exists', details: { server: 'wiki' },
  })
  expect(b.set).not.toHaveBeenCalled()

  b.set.mockRejectedValueOnce(new Error('vault locked'))
  await expect(b.service.saveServer(TOKEN, revision, 'mcp-server-docs')).rejects.toMatchObject({
    code: 'connectors/refused', message: 'vault locked',
  })
  expect(b.options('docs')?.config).toMatchObject({ headers: { Authorization: 'Bearer ${credential:MCP_DOCS_TOKEN}' } })
  expect(b.unset).not.toHaveBeenCalled()
})

it('refuses a save whose own credential reference another row uses, and keeps such a reference when a server is removed', async () => {
  const token = { Authorization: 'Bearer ${credential:MCP_A_ENV_TOKEN}' }
  const b = await bench({ 'a-env': { config: { ...DOCS, serverName: 'a-env', headers: token }, off: true } })
  const local: ServerDraft = {
    ...emptyDraft(), name: 'a', transport: 'stdio', command: 'npx', env: [{ key: 'TOKEN', value: 's3cret', secret: true }],
  }
  await expect(b.service.saveServer(local, await b.revision())).rejects.toMatchObject({
    code: 'connectors/refused',
    message: 'the server would share the credential reference MCP_A_ENV_TOKEN with another server',
    details: { server: 'a' },
  })
  expect(b.calls).toEqual([])

  const own = { 'X-Own': '${credential:MCP_A_ENV_HEADER_X_OWN}', 'X-Odd': '${credential:MCP_A_ENV_HEADER_X_ODD}' }
  const c = await bench({
    'a': { config: { serverName: 'a', transport: 'stdio', command: 'npx', env: { TOKEN: '${credential:MCP_A_ENV_TOKEN}' } }, off: true },
    'a-env': { config: { ...DOCS, serverName: 'a-env', headers: { ...token, ...own } } },
    // The form cannot read these rows; a reference in a config that is a map still counts.
    'odd': { config: { serverName: 'odd', transport: 'ws', headers: { 'X-Odd': '${credential:MCP_A_ENV_HEADER_X_ODD}' } } },
    'number': { config: 5 },
  })
  await c.service.removeServer('mcp-server-a-env', await c.revision())
  expect(c.calls).toEqual(['remove mcp-server-a-env', 'unset MCP_A_ENV_HEADER_X_OWN'])
})

it('counts a reference as used wherever the manager expands it: in a URL, command, argument, working directory, or beside another reference', async () => {
  const b = await bench({
    files: { config: { serverName: 'files', transport: 'stdio', command: 'npx', args: ['--token=${credential:MCP_WIKI_TOKEN}'] } },
  })
  await expect(b.service.saveServer({ ...TOKEN, name: 'wiki' }, await b.revision())).rejects.toMatchObject({
    code: 'connectors/refused',
    message: 'the server would share the credential reference MCP_WIKI_TOKEN with another server',
    details: { server: 'wiki' },
  })
  expect(b.calls).toEqual([])

  const header = (key: string): string => `\${credential:MCP_DOCS_HEADER_${key}}`
  const c = await bench({
    docs: { config: { ...DOCS, headers: { A: header('A'), B: header('B'), C: header('C'), D: header('D'), E: header('E'), F: header('F') } } },
    files: { config: {
      serverName: 'files', transport: 'stdio', command: header('A'), args: ['--token', header('B')],
      env: { PAIR: `\${credential:TEAM_ID}:${header('C')}` }, cwd: header('D'),
    } },
    wiki: { config: { serverName: 'wiki', transport: 'streamable-http', url: `https://wiki.example/${header('E')}/mcp`, headers: {} } },
  })
  await c.service.removeServer('mcp-server-docs', await c.revision())
  expect(c.calls).toEqual(['remove mcp-server-docs', 'unset MCP_DOCS_HEADER_F'])
})

it('keeps a secret the saved row still uses in an argument after its environment row is removed', async () => {
  const args = ['--key=${credential:MCP_LOCAL_ENV_KEY}']
  const env = { KEY: '${credential:MCP_LOCAL_ENV_KEY}', OLD: '${credential:MCP_LOCAL_ENV_OLD}' }
  const b = await bench({ local: { config: { serverName: 'local', transport: 'stdio', command: 'npx', args, env } } })
  const draft: ServerDraft = { ...emptyDraft(), name: 'local', transport: 'stdio', command: 'npx', args }
  await b.service.saveServer(draft, await b.revision(), 'mcp-server-local')
  expect(b.calls).toEqual(['editRow mcp-server-local', 'unset MCP_LOCAL_ENV_OLD'])
})

it('signs a running server out before an edit drops OAuth, and keeps the row when signing out fails', async () => {
  const b = await bench({ docs: { config: OAUTH } })
  b.signOut.mockRejectedValueOnce(new Error('connection busy'))
  await expect(b.service.saveServer(PLAIN, await b.revision(), 'mcp-server-docs')).rejects.toMatchObject({
    code: 'connectors/refused', message: 'connection busy',
  })
  expect(b.editRow).not.toHaveBeenCalled()
  // An edit that keeps OAuth keeps the grant.
  await b.service.saveServer({ ...PLAIN, auth: 'oauth', scope: 'read' }, await b.revision(), 'mcp-server-docs')
  expect(b.calls).toEqual(['editRow mcp-server-docs'])
  await b.service.saveServer(PLAIN, await b.revision(), 'mcp-server-docs')
  expect(b.calls).toEqual(['editRow mcp-server-docs', 'signOut docs', 'editRow mcp-server-docs'])
  expect(b.deleteRecord).not.toHaveBeenCalled()
})

it('deletes the grant record of a server that does not run when an edit drops OAuth or the server is removed', async () => {
  const b = await bench({ docs: { config: OAUTH, off: true }, number: { config: 5 } })
  b.managed.push({ name: 'docs', configured: false }, { name: 'wiki', configured: true })
  await b.service.saveServer(PLAIN, await b.revision(), 'mcp-server-docs')
  expect(b.calls).toEqual(['deleteRecord mcp-client/docs', 'editRow mcp-server-docs'])

  const c = await bench({ docs: { config: OAUTH, stalled: 'start' } })
  await c.service.removeServer('mcp-server-docs', await c.revision())
  expect(c.calls).toEqual(['deleteRecord mcp-client/docs', 'remove mcp-server-docs'])
  expect(c.signOut).not.toHaveBeenCalled()

  // A registered server of the same name keeps its grant under the record its own name forms.
  const d = await bench({ docs: { config: { ...OAUTH, oauth: { credentialKey: 'mcp-client/team-docs' } }, stalled: 'start' } })
  d.managed.push({ name: 'docs', configured: true })
  await d.service.removeServer('mcp-server-docs', await d.revision())
  expect(d.calls).toEqual(['deleteRecord mcp-client/team-docs', 'remove mcp-server-docs'])
})

it('keeps a grant record that another row names, or whose key the name of a registered server forms', async () => {
  const b = await bench({ docs: { config: OAUTH, off: true }, mirror: { config: { ...OAUTH, serverName: 'mirror' } } })
  await b.service.removeServer('mcp-server-docs', await b.revision())
  expect(b.calls).toEqual(['remove mcp-server-docs'])

  // A connector registers its server without a row and keeps its grant under `mcp-client/<server name>`.
  const linear = { ...OAUTH, serverName: 'alias', oauth: { credentialKey: 'mcp-client/linear' } }
  const c = await bench({ docs: { config: OAUTH, off: true }, alias: { config: linear, stalled: 'start' } })
  c.managed.push({ name: 'docs', configured: true }, { name: 'linear', configured: true })
  await c.service.removeServer('mcp-server-docs', await c.revision())
  await c.service.removeServer('mcp-server-alias', await c.revision())
  expect(c.calls).toEqual(['remove mcp-server-docs', 'remove mcp-server-alias'])
})

it.each<[string, unknown]>([
  ['no record', {}],
  ['a record key that is no string', { credentialKey: 5 }],
  ['a record key without a scope', { credentialKey: 'mcp-client' }],
  ['a record key the credentials service rejects', { credentialKey: 'Mcp/Docs' }],
])('deletes no grant record for a server that does not run and names %s', async (_name, oauth) => {
  const b = await bench({ docs: { config: { ...OAUTH, oauth }, off: true } })
  await b.service.removeServer('mcp-server-docs', await b.revision())
  expect(b.calls).toEqual(['remove mcp-server-docs'])
})

it('removes a server after its grant, then deletes the secrets it owned', async () => {
  const b = await bench({
    docs: { config: { ...OAUTH, headers: { 'X-Key': '${credential:MCP_DOCS_HEADER_X_KEY}' } } },
    files: { config: { serverName: 'files', transport: 'stdio', command: 'npx' } },
  })
  await b.service.removeServer('mcp-server-docs', await b.revision())
  expect(b.calls).toEqual(['signOut docs', 'remove mcp-server-docs', 'unset MCP_DOCS_HEADER_X_KEY'])
  await b.service.removeServer('mcp-server-files', await b.revision())
  expect(b.calls.slice(3)).toEqual(['remove mcp-server-files'])
  expect(await read(b.service)).toMatchObject({ servers: [] })
})

it('refuses to remove a row a bundle adds before any step, and refuses a change of a row that is gone', async () => {
  const b = await bench({ docs: { config: OAUTH, bundle: true } })
  const revision = await b.revision()
  await expect(b.service.removeServer('mcp-server-docs', revision)).rejects.toMatchObject({
    code: 'connectors/refused',
    message: 'the profile patch does not add this server row; switch it off instead of removing it',
    details: { server: 'mcp-server-docs' },
  })
  await expect(b.service.removeServer('mcp-server-gone', revision)).rejects.toMatchObject({
    code: 'connectors/refused', message: 'the server row is gone', details: { server: 'mcp-server-gone' },
  })
  await expect(b.service.setServerEnabled('mcp-server-gone', true, revision)).rejects.toMatchObject({ message: 'the server row is gone' })
  expect(b.calls).toEqual([])
})

it('removes a row the form cannot read without its grant and secrets', async () => {
  const odd = {
    serverName: 'odd', transport: 'ws', headers: { 'X-Key': '${credential:MCP_ODD_HEADER_X_KEY}' }, oauth: { credentialKey: 'mcp-client/odd' },
  }
  const b = await bench({ odd: { config: odd } })
  await b.service.removeServer('mcp-server-odd', await b.revision())
  expect(b.calls).toEqual(['remove mcp-server-odd'])
})

it('keeps a server whose sign-out fails, and reports the first secret it could not delete', async () => {
  const b = await bench({
    docs: { config: OAUTH },
    keys: { config: { ...DOCS, serverName: 'keys', headers: { A: '${credential:MCP_KEYS_HEADER_A}', B: '${credential:MCP_KEYS_HEADER_B}' } } },
  })
  const revision = await b.revision()
  b.signOut.mockRejectedValueOnce(new Error('connection busy'))
  await expect(b.service.removeServer('mcp-server-docs', revision)).rejects.toMatchObject({ message: 'connection busy' })
  expect(b.remove).not.toHaveBeenCalled()
  b.remove.mockRejectedValueOnce(new Error('read-only profile'))
  await expect(b.service.removeServer('mcp-server-keys', revision)).rejects.toMatchObject({ message: 'read-only profile' })
  expect(b.unset).not.toHaveBeenCalled()
  b.unset.mockRejectedValueOnce(new Error('vault locked'))
  await expect(b.service.removeServer('mcp-server-keys', revision)).rejects.toMatchObject({
    code: 'connectors/refused', message: 'vault locked', details: { server: 'mcp-server-keys' },
  })
  expect(b.unset).toHaveBeenCalledOnce()
})

it('switches a row through the plugin manager by its Loader entry id, which changes the revision', async () => {
  const b = await bench()
  const revision = await b.revision()
  await b.service.setServerEnabled('mcp-server-docs', false, revision)
  expect(b.calls).toEqual(['switch include:mcp-server-docs off'])
  expect(await read(b.service)).toMatchObject({ servers: [{ name: 'docs', state: 'off' }] })
  await expect(b.service.setServerEnabled('mcp-server-docs', true, revision)).rejects.toMatchObject({ code: 'connectors/conflict' })
  await b.service.setServerEnabled('mcp-server-docs', true, await b.revision())
  expect(b.calls.slice(1)).toEqual(['switch include:mcp-server-docs on'])
})

it.each<[string, Partial<ChangeResult>, string]>([
  ['takes effect after a restart', { application: 'restart-required' }, 'the switch is saved and takes effect after DSH restarts'],
  ['another patch decides', { application: 'overridden' }, 'a home patch or command-line overlay decides whether this server is on'],
  ['left the row failed', { application: 'failed', error: { code: 'operation-error', diagnostic: 'connection refused' } }, 'connection refused'],
  ['failed without a diagnostic', { application: 'failed', error: { code: 'operation-error' } }, 'operation-error'],
  ['the plugin manager cancelled', { application: 'cancelled' }, 'the plugin manager did not apply the switch'],
])('refuses a switch that %s', async (_name, outcome, message) => {
  const b = await bench({ docs: { config: DOCS, off: true } })
  b.setPluginEnabled.mockResolvedValueOnce({ changed: false, application: 'applied', stage: 'enable', target: 'include:mcp-server-docs', ...outcome })
  await expect(b.service.setServerEnabled('mcp-server-docs', true, await b.revision())).rejects.toMatchObject({
    code: 'connectors/refused', message, details: { server: 'mcp-server-docs' },
  })
})

it('refuses a switch the plugin manager rejects', async () => {
  const b = await bench()
  b.setPluginEnabled.mockRejectedValueOnce(new Error('profile is read-only'))
  await expect(b.service.setServerEnabled('mcp-server-docs', false, await b.revision())).rejects.toMatchObject({
    code: 'connectors/refused', message: 'profile is read-only', details: { server: 'mcp-server-docs' },
  })
})

it('runs changes one after another, so the second of two changes made on one revision is a conflict', async () => {
  const b = await bench()
  const revision = await b.revision()
  const [saved, removed] = await Promise.allSettled([
    b.service.saveServer({ ...PLAIN, name: 'wiki', url: 'https://wiki.example/mcp' }, revision),
    b.service.removeServer('mcp-server-docs', revision),
  ])
  expect(saved).toMatchObject({ status: 'fulfilled' })
  expect(removed).toMatchObject({ status: 'rejected', reason: { code: 'connectors/conflict' } })
  expect(b.calls).toEqual(['insert mcp-server-wiki'])
})

it('shows the account of each OAuth server row that is on and follows the rows until the plugin unloads', async () => {
  const b = await bench({
    docs: { config: OAUTH },
    plain: { config: { ...DOCS, serverName: 'plain' } },
    idle: { config: { ...OAUTH, serverName: 'idle', oauth: { credentialKey: 'mcp-client/idle' } }, off: true },
  }, { accounts: true })
  await vi.waitFor(() => { expect(b.register).toHaveBeenCalledOnce() })
  expect(b.register.mock.calls[0]![0]).toMatchObject({ server: 'docs', copy: { title: { en: 'Account', zh: '账号' } } })
  expect(b.register.mock.calls[0]![0]).not.toHaveProperty('packageName')

  b.put('wiki', { config: WIKI_OAUTH })
  b.ctx.emit('app-boot/config-reload')
  await vi.waitFor(() => { expect(b.register.mock.calls.map(([registration]) => registration.server)).toEqual(['docs', 'wiki']) })
  b.put('docs', { config: DOCS })
  b.ctx.emit('app-boot/config-reload')
  await vi.waitFor(() => { expect(b.withdrawn).toEqual(['docs']) })
  await b.fiber.dispose()
  expect(b.withdrawn).toEqual(['docs', 'wiki'])
})

it('skips a server whose account is already registered, and keeps the shown accounts when the rows cannot be read', async () => {
  const b = await bench({ wiki: { config: WIKI_OAUTH } }, { accounts: true })
  await vi.waitFor(() => { expect(b.register).toHaveBeenCalledOnce() })
  b.register.mockImplementationOnce(() => { throw new Error('mcp:docs is already registered') })
  b.put('docs', { config: OAUTH })
  b.ctx.emit('app-boot/config-reload')
  await vi.waitFor(() => {
    expect(warnings(b.ctx)).toContainEqual(['connectors: server row "%s" shows no account: %s', 'docs', 'mcp:docs is already registered'])
  })

  b.configuration.mockImplementationOnce(() => { throw new Error('profile unreadable') })
  b.ctx.emit('app-boot/config-reload')
  await vi.waitFor(() => {
    expect(warnings(b.ctx)).toContainEqual(['connectors: server row accounts were not read: %s', 'profile unreadable'])
  })
  expect(b.withdrawn).toEqual([])

  b.drop('wiki')
  b.ctx.emit('app-boot/config-reload')
  await vi.waitFor(() => { expect(b.withdrawn).toEqual(['wiki']) })
})

it('registers no account when the plugin unloads while the rows are read', async () => {
  const starting: PromiseWithResolvers<void> = Promise.withResolvers()
  const b = await bench({ docs: { config: OAUTH, starting: starting.promise } }, { accounts: true })
  await vi.waitFor(() => { expect(b.configuration).toHaveBeenCalled() })
  const unloaded = b.fiber.dispose()
  starting.resolve()
  await unloaded
  await settled()
  expect(b.register).not.toHaveBeenCalled()
})

it('shows no account in a profile without a configuration editor', async () => {
  const b = await bench({ docs: { config: OAUTH } }, { accounts: true, without: 'configEditor' })
  await settled()
  expect(b.register).not.toHaveBeenCalled()
  expect(warnings(b.ctx)).toEqual([])
})
