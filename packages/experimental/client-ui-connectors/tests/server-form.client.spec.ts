/** The server form reads a Settings entry into a draft, validates it, and writes it back with credential references. */
import { describe, expect, it } from 'vitest'
import { credentialRef, draftFromEntry, emptyDraft, entryFromDraft, entryRefs, ownedRefs, validateDraft, type ServerDraft } from '../src/server-form.ts'

const remote = (change: Partial<ServerDraft> = {}): ServerDraft => ({ ...emptyDraft(), name: 'docs', url: 'https://docs.example/mcp', ...change })
const local = (change: Partial<ServerDraft> = {}): ServerDraft => ({ ...emptyDraft(), name: 'files', transport: 'stdio', command: 'npx', ...change })

describe('draftFromEntry', () => {
  it('reads a header token, secret and plain headers, and the enabled flag of a remote entry', () => {
    expect(draftFromEntry('docs', {
      transport: 'streamable-http', url: 'https://docs.example/mcp', enabled: false,
      headers: { 'Authorization': 'Bearer ${credential:MCP_DOCS_TOKEN}', 'X-Api': '${credential:MCP_DOCS_HEADER_X_API}', 'X-Team': 'core' },
    })).toEqual({
      ...emptyDraft(), name: 'docs', url: 'https://docs.example/mcp', enabled: false, auth: 'token', tokenRef: 'MCP_DOCS_TOKEN',
      headers: [{ key: 'X-Api', value: '', secret: true, ref: 'MCP_DOCS_HEADER_X_API' }, { key: 'X-Team', value: 'core', secret: false }],
    })
  })

  it('reads OAuth, and keeps an Authorization header that names no stored token as a plain header', () => {
    expect(draftFromEntry('docs', { url: 'https://docs.example/mcp', oauth: { credentialKey: 'mcp-client/docs', clientId: 'app', scope: 'read' } }))
      .toMatchObject({ transport: 'streamable-http', auth: 'oauth', clientId: 'app', scope: 'read', headers: [] })
    expect(draftFromEntry('docs', { url: 'https://docs.example/mcp', headers: { authorization: 'Bearer literal' } }))
      .toMatchObject({ auth: 'none', tokenRef: undefined, headers: [{ key: 'authorization', value: 'Bearer literal', secret: false }] })
  })

  it('reads a local command, its arguments, environment, and directory, and ignores values of the wrong type', () => {
    expect(draftFromEntry('files', {
      transport: 'stdio', command: 'npx', args: ['-y', 3, 'server'], cwd: '/srv',
      env: { TOKEN: '${credential:MCP_FILES_ENV_TOKEN}', MODE: 'ro', COUNT: 2 },
    })).toEqual({
      ...emptyDraft(), name: 'files', transport: 'stdio', command: 'npx', args: ['-y', '', 'server'], cwd: '/srv',
      env: [{ key: 'TOKEN', value: '', secret: true, ref: 'MCP_FILES_ENV_TOKEN' }, { key: 'MODE', value: 'ro', secret: false }, { key: 'COUNT', value: '', secret: false }],
    })
    expect(draftFromEntry('files', { transport: 'stdio', args: 'npx', env: ['x'], headers: null })).toMatchObject({ args: [], env: [], headers: [] })
  })
})

describe('validateDraft', () => {
  it('accepts complete remote and local drafts', () => {
    expect(validateDraft(remote(), [])).toEqual([])
    expect(validateDraft(remote({ auth: 'token', tokenRef: 'MCP_DOCS_TOKEN' }), [])).toEqual([])
    expect(validateDraft(local({ env: [{ key: 'TOKEN', value: '', secret: true, ref: 'MCP_FILES_ENV_TOKEN' }] }), [])).toEqual([])
  })

  it('refuses invalid names and names that share a credential reference with another server', () => {
    expect(validateDraft(remote({ name: '' }), [])).toEqual(['name-invalid'])
    expect(validateDraft(remote({ name: 'two words' }), [])).toEqual(['name-invalid'])
    expect(validateDraft(remote(), ['docs'])).toEqual(['name-taken'])
    expect(validateDraft(remote({ name: 'a-b' }), ['a_b'])).toEqual(['name-taken'])
    expect(validateDraft(remote({ name: 'Docs' }), ['docs'])).toEqual(['name-taken'])
  })

  it('refuses rows without a name, rows whose names share a reference, and secret rows without a value', () => {
    const row = (key: string, change = {}) => ({ key, value: 'v', secret: false, ...change })
    expect(validateDraft(remote({ headers: [row(' ')] }), [])).toEqual(['row-key-missing'])
    expect(validateDraft(remote({ headers: [row('X-Key'), row('x_key')] }), [])).toEqual(['row-key-duplicate'])
    expect(validateDraft(local({ env: [row('TOKEN', { value: '', secret: true })] }), [])).toEqual(['row-secret-missing'])
  })

  it('refuses secret rows and a token that would store their values under one reference', () => {
    // A renamed secret row keeps its reference, so a new row under the old key would store its value under the same one.
    expect(validateDraft(remote({ headers: [{ key: 'Y', value: '', secret: true, ref: 'MCP_DOCS_HEADER_X' }, { key: 'X', value: 'new', secret: true }] }), []))
      .toEqual(['row-key-duplicate'])
    expect(validateDraft(remote({ auth: 'token', tokenRef: 'MCP_DOCS_HEADER_K', headers: [{ key: 'K', value: 'v', secret: true }] }), []))
      .toEqual(['row-key-duplicate'])
    expect(validateDraft(local({ env: [{ key: 'B', value: '', secret: true, ref: 'MCP_FILES_ENV_A' }, { key: 'A', value: 'v', secret: false }] }), [])).toEqual([])
  })

  it('checks a local draft for its command and nothing remote', () => {
    expect(validateDraft(local({ command: ' ', url: 'nope', auth: 'token' }), [])).toEqual(['command-missing'])
  })

  it('checks a remote draft for its address, its token, an OAuth-ready name, and a separate Authorization header', () => {
    expect(validateDraft(remote({ url: 'ftp://docs.example' }), [])).toEqual(['url-invalid'])
    expect(validateDraft(remote({ url: 'docs.example' }), [])).toEqual(['url-invalid'])
    expect(validateDraft(remote({ auth: 'token' }), [])).toEqual(['token-missing'])
    expect(validateDraft(remote({ auth: 'oauth', name: 'Docs_1' }), [])).toEqual(['name-oauth'])
    expect(validateDraft(remote({ auth: 'oauth', name: 'bad name' }), [])).toEqual(['name-invalid'])
    expect(validateDraft(remote({ auth: 'oauth', headers: [{ key: 'Authorization', value: 'x', secret: false }] }), [])).toEqual(['authorization-header'])
    expect(validateDraft(remote({ headers: [{ key: 'Authorization', value: 'x', secret: false }] }), [])).toEqual([])
  })
})

describe('entryFromDraft', () => {
  it('writes a local command with trimmed arguments, secret and plain environment rows, and the unknown fields it kept', () => {
    expect(entryFromDraft(local({
      args: [' -y ', '', ' server '], cwd: ' /srv ', enabled: false,
      env: [{ key: 'TOKEN', value: 's3cret', secret: true }, { key: 'OLD', value: '', secret: true, ref: 'MCP_FILES_ENV_OLD' }, { key: 'MODE', value: 'ro', secret: false }],
    }), { transport: 'stdio', url: 'https://stale', timeoutMs: 5 })).toEqual({
      entry: {
        timeoutMs: 5, transport: 'stdio', command: 'npx', args: ['-y', 'server'], cwd: '/srv', enabled: false,
        env: { TOKEN: '${credential:MCP_FILES_ENV_TOKEN}', OLD: '${credential:MCP_FILES_ENV_OLD}', MODE: 'ro' },
      },
      secrets: [{ ref: 'MCP_FILES_ENV_TOKEN', value: 's3cret' }],
    })
    expect(entryFromDraft(local()).entry).not.toHaveProperty('cwd')
  })

  it('writes a remote entry with its headers and a new or kept header token', () => {
    expect(entryFromDraft(remote({ url: ' https://docs.example/mcp ', auth: 'token', token: 't0ken', headers: [{ key: 'X-Team', value: 'core', secret: false }] }))).toEqual({
      entry: { transport: 'streamable-http', url: 'https://docs.example/mcp', enabled: true, headers: { 'X-Team': 'core', 'Authorization': 'Bearer ${credential:MCP_DOCS_TOKEN}' } },
      secrets: [{ ref: 'MCP_DOCS_TOKEN', value: 't0ken' }],
    })
    expect(entryFromDraft(remote({ auth: 'token', tokenRef: 'MCP_DOCS_TOKEN' }))).toMatchObject({
      entry: { headers: { Authorization: 'Bearer ${credential:MCP_DOCS_TOKEN}' } }, secrets: [],
    })
  })

  it('writes OAuth with the server credential key and only the client fields that are filled in', () => {
    expect(entryFromDraft(remote({ auth: 'oauth', clientId: ' app ', scope: ' read ' })).entry.oauth)
      .toEqual({ credentialKey: 'mcp-client/docs', clientId: 'app', scope: 'read' })
    expect(entryFromDraft(remote({ auth: 'oauth' })).entry.oauth).toEqual({ credentialKey: 'mcp-client/docs' })
    expect(entryFromDraft(remote(), { oauth: { credentialKey: 'mcp-client/docs' } }).entry).not.toHaveProperty('oauth')
  })
})

it('names credential references after the server and field, and lists the references a server owns', () => {
  expect(credentialRef('my-docs', 'HEADER_X-Api')).toBe('MCP_MY_DOCS_HEADER_X_API')
  expect(ownedRefs('docs', {
    headers: { 'Authorization': 'Bearer ${credential:MCP_DOCS_TOKEN}', 'X-Shared': '${credential:TEAM_TOKEN}', 'X-Plain': 'v', 'X-Count': 1 },
    env: { A: '${credential:MCP_DOCS_ENV_A}' },
  })).toEqual(['MCP_DOCS_TOKEN', 'MCP_DOCS_ENV_A'])
  expect(ownedRefs('docs', {})).toEqual([])
})

it('lists the references of every value the MCP manager expands, each once', () => {
  expect(entryRefs({
    url: 'https://docs.example/${credential:MCP_DOCS_PATH}/mcp',
    headers: { 'X-Pair': '${credential:TEAM_ID}:${credential:MCP_DOCS_HEADER_X_PAIR}' },
    command: '${credential:MCP_DOCS_BIN}',
    args: ['--token', '${credential:MCP_DOCS_ENV_A}', 7],
    env: { A: '${credential:MCP_DOCS_ENV_A}' },
    cwd: '/work/${credential:MCP_DOCS_DIR}',
  })).toEqual(['MCP_DOCS_PATH', 'TEAM_ID', 'MCP_DOCS_HEADER_X_PAIR', 'MCP_DOCS_BIN', 'MCP_DOCS_ENV_A', 'MCP_DOCS_DIR'])
})
