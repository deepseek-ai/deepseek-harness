/**
 * The `connectors` service lists the MCP manager's configured servers, changes one as a single Host operation that stops
 * at the first refused step, and shows the account of each configured OAuth server.
 */
import { Context } from '@deepseek-ai/cordis'
import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { expect, it, onTestFinished, vi } from 'vitest'
import Connectors from '../src/index.ts'
import { emptyDraft } from '../src/server-form.ts'
import type { ServerDraft } from '../src/types.ts'

const DOCS = { transport: 'streamable-http', url: 'https://docs.example/mcp', headers: { 'X-Old': '${credential:MCP_DOCS_HEADER_X_OLD}' } }
const OAUTH = { transport: 'streamable-http', url: 'https://docs.example/mcp', headers: {}, oauth: { credentialKey: 'mcp-client/docs' } }
const TOKEN: ServerDraft = { ...emptyDraft(), name: 'docs', url: 'https://docs.example/mcp', auth: 'token', token: 't0ken' }

interface Services { settings?: boolean; credentials?: boolean; manager?: boolean; accounts?: boolean }

async function bench(servers: Record<string, JsonValue> = { docs: DOCS }, base: Record<string, JsonValue> = {}, services: Services = {}) {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const calls: string[] = []
  const state = { revision: 3, servers: { ...base, ...servers } }
  const describe = vi.fn((_options?: { redactSecrets?: boolean }) => [
    { ns: 'llm-deepseek', revision: 1, value: {}, autoGenerate: true, schema: {}, applies: 'live' as const },
    { ns: 'mcp-manager', revision: state.revision, value: { servers: state.servers }, base: { servers: base }, autoGenerate: true, schema: {}, applies: 'live' as const },
  ])
  const mutate = vi.fn(async (_ns: string, ops: readonly SettingsPathOp[], expected?: number) => {
    calls.push(`mutate ${JSON.stringify(ops)} @${String(expected)}`)
  })
  const set = vi.fn(async (ref: string, _value: string) => { calls.push(`set ${ref}`) })
  const unset = vi.fn(async (ref: string) => { calls.push(`unset ${ref}`) })
  const signOut = vi.fn(async (name: string) => { calls.push(`signOut ${name}`) })
  const withdrawn: string[] = []
  const register = vi.fn((registration: { server: string }) => () => { withdrawn.push(registration.server) })
  if (services.settings !== false) ctx.provide('settings', { writable: true, describe, mutate } as never)
  if (services.credentials !== false) ctx.provide('credentials', { set, unset } as never)
  if (services.manager !== false) ctx.provide('mcpManager', { signOut } as never)
  if (services.accounts === true) ctx.provide('mcpAccounts', { register } as never)
  const fiber = ctx.plugin(Connectors, { mcpManagerNamespace: 'mcp-manager' })
  await fiber
  const service = ctx.get('connectors')
  if (service === undefined) throw new Error('the connectors service did not start')
  return {
    ctx, fiber, service, state, calls, describe, mutate, set, unset, signOut, register, withdrawn,
    /** Change the namespace as another writer would, then announce it. */
    edit(next: Record<string, JsonValue>) {
      state.revision += 1
      state.servers = next
      ctx.emit('settings/document-updated', 'mcp-manager' as never, state.revision)
    },
  }
}

it('lists the configured servers with secrets redacted, marking inherited entries and entries the form cannot edit', async () => {
  const b = await bench({ files: { transport: 'stdio', command: 'npx' }, odd: { transport: 'ws' }, bad: 5 }, { docs: DOCS })
  expect(b.service.listServers()).toEqual({
    available: true, writable: true, revision: 3,
    servers: [
      { name: 'docs', raw: DOCS, inherited: true },
      { name: 'files', raw: { transport: 'stdio', command: 'npx' }, inherited: false },
      { name: 'odd', inherited: false },
      { name: 'bad', inherited: false },
    ],
  })
  expect(b.describe).toHaveBeenCalledWith({ redactSecrets: true })
})

it.each<[string, Services]>([
  ['Settings', { settings: false }], ['credentials', { credentials: false }], ['the MCP manager', { manager: false }],
])('lists nothing and refuses every change without %s', async (_name, services) => {
  const b = await bench({ docs: DOCS }, {}, services)
  expect(b.service.listServers()).toEqual({ available: false })
  await expect(b.service.setServerEnabled('docs', false, 3)).rejects.toMatchObject({
    code: 'connectors/refused', message: 'custom MCP servers need Settings, credentials, and the MCP manager', details: { server: 'docs' },
  })
})

it('lists nothing for a profile whose MCP manager has no Settings namespace, and reads one without servers as empty', async () => {
  const b = await bench()
  b.describe.mockReturnValueOnce([])
  expect(b.service.listServers()).toEqual({ available: false })
  b.describe.mockReturnValueOnce([{ ns: 'mcp-manager', revision: 1, value: {}, autoGenerate: true, schema: {}, applies: 'live' }])
  expect(b.service.listServers()).toEqual({ available: true, writable: true, revision: 1, servers: [] })
})

it('writes the entry before storing its new secrets, then deletes the secrets the entry stopped using', async () => {
  const b = await bench()
  await b.service.saveServer(TOKEN, 3)
  expect(b.set).toHaveBeenCalledWith('MCP_DOCS_TOKEN', 't0ken')
  expect(b.calls).toEqual([
    `mutate ${JSON.stringify([{ op: 'set', path: ['servers', 'docs'], value: {
      transport: 'streamable-http', url: 'https://docs.example/mcp', headers: { Authorization: 'Bearer ${credential:MCP_DOCS_TOKEN}' }, enabled: true,
    } }])} @3`,
    'set MCP_DOCS_TOKEN',
    'unset MCP_DOCS_HEADER_X_OLD',
  ])
  expect(b.describe).toHaveBeenCalledWith()
})

it('keeps the fields of the previous entry that the form does not show', async () => {
  const b = await bench({ docs: { ...OAUTH, timeoutMs: 5 } })
  await b.service.saveServer({ ...emptyDraft(), name: 'docs', url: 'https://docs.example/mcp', auth: 'oauth' }, 3)
  expect(b.mutate.mock.calls[0]![1]).toEqual([{ op: 'set', path: ['servers', 'docs'], value: {
    timeoutMs: 5, transport: 'streamable-http', url: 'https://docs.example/mcp', headers: {}, oauth: { credentialKey: 'mcp-client/docs' }, enabled: true,
  } }])
})

it('writes a new server without deleting anything', async () => {
  const b = await bench()
  await b.service.saveServer({ ...emptyDraft(), name: 'wiki', url: 'https://wiki.example/mcp' }, 3)
  expect(b.unset).not.toHaveBeenCalled()
  expect(b.mutate).toHaveBeenCalledOnce()
})

it('refuses a draft the form would not save, and a change named after an older revision, before any step', async () => {
  const b = await bench({ docs: DOCS, Docs2: DOCS })
  await expect(b.service.saveServer({ ...TOKEN, name: 'bad name' }, 3)).rejects.toMatchObject({
    code: 'connectors/refused', message: 'the server cannot be saved: name-invalid', details: { server: 'bad name' },
  })
  await expect(b.service.saveServer({ ...TOKEN, name: 'docs2' }, 3)).rejects.toMatchObject({ message: 'the server cannot be saved: name-taken' })
  await expect(b.service.removeServer('docs', 2)).rejects.toMatchObject({ code: 'connectors/conflict', details: { expected: 2, actual: 3 } })
  expect(b.calls).toEqual([])
})

it('refuses a draft that keeps a stored secret its entry does not use', async () => {
  const b = await bench()
  const borrowed: ServerDraft = { ...emptyDraft(), name: 'docs', url: 'https://docs.example/mcp', headers: [{ key: 'X-Key', value: '', secret: true, ref: 'DEEPSEEK_API_KEY' }] }
  await expect(b.service.saveServer(borrowed, 3)).rejects.toMatchObject({
    code: 'connectors/refused', message: 'the server names a credential reference its entry does not use',
  })
  await expect(b.service.saveServer({ ...TOKEN, token: '', tokenRef: 'DEEPSEEK_API_KEY' }, 3)).rejects.toMatchObject({ code: 'connectors/refused' })
  await b.service.saveServer({ ...emptyDraft(), name: 'docs', url: 'https://docs.example/mcp', headers: [{ key: 'X-Old', value: '', secret: true, ref: 'MCP_DOCS_HEADER_X_OLD' }] }, 3)
  expect(b.calls).toEqual([expect.stringMatching(/^mutate /)])
})

it('stores no secret after a refused or conflicting write, and keeps the written entry when a secret is refused', async () => {
  const b = await bench()
  b.mutate.mockRejectedValueOnce(new Error('read-only profile'))
  await expect(b.service.saveServer(TOKEN, 3)).rejects.toMatchObject({ code: 'connectors/refused', message: 'read-only profile' })
  b.mutate.mockRejectedValueOnce('storage failed')
  await expect(b.service.saveServer(TOKEN, 3)).rejects.toMatchObject({ code: 'connectors/refused', message: 'storage failed' })
  b.mutate.mockRejectedValueOnce(Object.assign(new Error('stale'), { code: 'SETTINGS_CONFLICT', expected: 3, actual: 4 }))
  await expect(b.service.saveServer(TOKEN, 3)).rejects.toMatchObject({ code: 'connectors/conflict', details: { expected: 3, actual: 4 } })
  b.mutate.mockRejectedValueOnce(Object.assign(new Error('odd'), { code: 'SETTINGS_CONFLICT', expected: '3' }))
  await expect(b.service.saveServer(TOKEN, 3)).rejects.toMatchObject({ code: 'connectors/refused', message: 'odd' })
  expect(b.set).not.toHaveBeenCalled()

  b.set.mockRejectedValueOnce(new Error('vault locked'))
  await expect(b.service.saveServer(TOKEN, 3)).rejects.toMatchObject({ code: 'connectors/refused', message: 'vault locked' })
  expect(b.mutate).toHaveBeenCalledTimes(5)
  expect(b.unset).not.toHaveBeenCalled()
})

it('refuses a save whose own credential references another server\'s entry uses, and keeps such a reference when a server is removed', async () => {
  const b = await bench({ 'a-env': { ...DOCS, headers: { Authorization: 'Bearer ${credential:MCP_A_ENV_TOKEN}' } } })
  const local: ServerDraft = { ...emptyDraft(), name: 'a', transport: 'stdio', command: 'npx', env: [{ key: 'TOKEN', value: 's3cret', secret: true }] }
  await expect(b.service.saveServer(local, 3)).rejects.toMatchObject({
    code: 'connectors/refused', message: 'the server would share the credential reference MCP_A_ENV_TOKEN with another server', details: { server: 'a' },
  })
  expect(b.calls).toEqual([])

  const c = await bench({
    'a': { transport: 'stdio', command: 'npx', env: { TOKEN: '${credential:MCP_A_ENV_TOKEN}' } },
    'a-env': { ...DOCS, headers: { 'Authorization': 'Bearer ${credential:MCP_A_ENV_TOKEN}', 'X-Own': '${credential:MCP_A_ENV_HEADER_X_OWN}' } },
    'odd': { transport: 'ws' },
  })
  await c.service.removeServer('a-env', 3)
  expect(c.calls).toEqual([`mutate ${JSON.stringify([{ op: 'unset', path: ['servers', 'a-env'] }])} @3`, 'unset MCP_A_ENV_HEADER_X_OWN'])
})

it('counts a reference as used wherever the manager expands it: in a URL, command, argument, working directory, or beside another reference', async () => {
  const b = await bench({ files: { transport: 'stdio', command: 'npx', args: ['--token=${credential:MCP_WIKI_TOKEN}'] } })
  await expect(b.service.saveServer({ ...TOKEN, name: 'wiki' }, 3)).rejects.toMatchObject({
    code: 'connectors/refused', message: 'the server would share the credential reference MCP_WIKI_TOKEN with another server', details: { server: 'wiki' },
  })
  expect(b.calls).toEqual([])

  const header = (key: string) => `\${credential:MCP_DOCS_HEADER_${key}}`
  const c = await bench({
    docs: { ...DOCS, headers: { A: header('A'), B: header('B'), C: header('C'), D: header('D'), E: header('E'), F: header('F') } },
    files: {
      transport: 'stdio', command: header('A'), args: ['--token', header('B')], env: { PAIR: `\${credential:TEAM_ID}:${header('C')}` }, cwd: header('D'),
    },
    wiki: { transport: 'streamable-http', url: `https://wiki.example/${header('E')}/mcp`, headers: {} },
  })
  await c.service.removeServer('docs', 3)
  expect(c.calls).toEqual([`mutate ${JSON.stringify([{ op: 'unset', path: ['servers', 'docs'] }])} @3`, 'unset MCP_DOCS_HEADER_F'])
})

it('keeps a secret the saved entry still uses in an argument after its environment row is removed', async () => {
  const args = ['--key=${credential:MCP_LOCAL_ENV_KEY}']
  const b = await bench({
    local: { transport: 'stdio', command: 'npx', args, env: { KEY: '${credential:MCP_LOCAL_ENV_KEY}', OLD: '${credential:MCP_LOCAL_ENV_OLD}' } },
  })
  await b.service.saveServer({ ...emptyDraft(), name: 'local', transport: 'stdio', command: 'npx', args }, 3)
  expect(b.calls).toEqual([expect.stringMatching(/^mutate /), 'unset MCP_LOCAL_ENV_OLD'])
})

it('signs out before an edit drops OAuth, and keeps the entry when signing out fails', async () => {
  const b = await bench({ docs: OAUTH })
  const plain: ServerDraft = { ...emptyDraft(), name: 'docs', url: 'https://docs.example/mcp' }
  b.signOut.mockRejectedValueOnce(new Error('connection busy'))
  await expect(b.service.saveServer(plain, 3)).rejects.toMatchObject({ code: 'connectors/refused', message: 'connection busy' })
  expect(b.mutate).not.toHaveBeenCalled()
  await b.service.saveServer(plain, 3)
  expect(b.calls).toEqual(['signOut docs', expect.stringMatching(/^mutate /)])
  b.signOut.mockClear()
  await b.service.saveServer({ ...plain, auth: 'oauth' }, 3)
  expect(b.signOut).not.toHaveBeenCalled()
})

it('removes a server after signing it out, then deletes the secrets it owned', async () => {
  const b = await bench({ docs: { ...OAUTH, headers: { 'X-Key': '${credential:MCP_DOCS_HEADER_X_KEY}' } }, files: { transport: 'stdio', command: 'npx' } })
  await b.service.removeServer('docs', 3)
  expect(b.calls).toEqual(['signOut docs', `mutate ${JSON.stringify([{ op: 'unset', path: ['servers', 'docs'] }])} @3`, 'unset MCP_DOCS_HEADER_X_KEY'])
  await b.service.removeServer('files', 3)
  await b.service.removeServer('gone', 3)
  expect(b.mutate).toHaveBeenCalledTimes(3)
  expect(b.signOut).toHaveBeenCalledOnce()
  expect(b.unset).toHaveBeenCalledOnce()
})

it('keeps a server whose sign-out fails, and reports the first secret it could not delete', async () => {
  const b = await bench({ docs: OAUTH, keys: { ...DOCS, headers: { A: '${credential:MCP_KEYS_HEADER_A}', B: '${credential:MCP_KEYS_HEADER_B}' } } })
  b.signOut.mockRejectedValueOnce(new Error('connection busy'))
  await expect(b.service.removeServer('docs', 3)).rejects.toMatchObject({ message: 'connection busy' })
  expect(b.mutate).not.toHaveBeenCalled()
  b.mutate.mockRejectedValueOnce(new Error('read-only profile'))
  await expect(b.service.removeServer('keys', 3)).rejects.toMatchObject({ message: 'read-only profile' })
  expect(b.unset).not.toHaveBeenCalled()
  b.unset.mockRejectedValueOnce(new Error('vault locked'))
  await expect(b.service.removeServer('keys', 3)).rejects.toMatchObject({ code: 'connectors/refused', message: 'vault locked', details: { server: 'keys' } })
  expect(b.unset).toHaveBeenCalledOnce()
})

it('switches a server on or off through its enabled field', async () => {
  const b = await bench()
  await b.service.setServerEnabled('docs', false, 3)
  expect(b.mutate).toHaveBeenCalledWith('mcp-manager', [{ op: 'set', path: ['servers', 'docs', 'enabled'], value: false }], 3)
})

it('shows the account of each configured OAuth server and follows the namespace until the plugin unloads', async () => {
  const b = await bench({ docs: OAUTH, plain: DOCS }, {}, { accounts: true })
  expect(b.register).toHaveBeenCalledOnce()
  expect(b.register.mock.calls[0]![0]).toMatchObject({ server: 'docs', copy: { title: { en: 'Account', zh: '账号' } } })
  expect(b.register.mock.calls[0]![0]).not.toHaveProperty('packageName')
  b.ctx.emit('settings/document-updated', 'llm-deepseek' as never, 2)
  b.edit({ docs: OAUTH, wiki: { ...OAUTH, oauth: { credentialKey: 'mcp-client/wiki' } } })
  expect(b.register.mock.calls.map(([registration]) => registration.server)).toEqual(['docs', 'wiki'])
  b.edit({ wiki: { ...OAUTH, oauth: { credentialKey: 'mcp-client/wiki' } }, docs: DOCS })
  expect(b.withdrawn).toEqual(['docs'])
  await b.fiber.dispose()
  expect(b.withdrawn).toEqual(['docs', 'wiki'])
})

it('skips a server whose account is already registered, and withdraws every account once the namespace is gone', async () => {
  const b = await bench({ notion: { ...OAUTH, oauth: { credentialKey: 'mcp-client/notion' } } }, {}, { accounts: true })
  b.register.mockImplementationOnce(() => { throw new Error('mcp:docs is already registered') })
  b.edit({ notion: { ...OAUTH, oauth: { credentialKey: 'mcp-client/notion' } }, docs: OAUTH })
  const warnings: unknown[] = b.ctx.logger.buffer.filter(message => message.type === 'warn').map((message): unknown => message.args)
  expect(warnings).toContainEqual(
    ['connectors: configured server "%s" shows no account: %s', 'docs', 'mcp:docs is already registered'],
  )
  b.describe.mockReturnValueOnce([])
  b.edit({})
  expect(b.withdrawn).toEqual(['notion'])
})
