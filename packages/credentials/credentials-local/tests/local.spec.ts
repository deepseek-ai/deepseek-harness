import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { createLaunchEnvironmentSnapshot, DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { LocalCredentialProvider, resolveSpec } from '../src/index.ts'

function writeCredentials(file: string, text: string): Promise<void> {
  return writeFile(file, text, { mode: 0o600 })
}

const KEY = credentialRef('DSH_CRED_TEST')
const OTHER = credentialRef('DSH_CRED_OTHER')

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  vi.unstubAllEnvs()
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-credentials-local-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function boot(config: ConstructorParameters<typeof LocalCredentialProvider>[1]): Promise<Context> {
  const ctx = new Context()
  const fiber = ctx.plugin(LocalCredentialProvider, config)
  cleanups.push(async () => {
    await fiber.dispose()
  })
  await fiber
  return ctx
}

function updates(ctx: Context): CredentialRef[] {
  const seen: CredentialRef[] = []
  ctx.on('credentials/reference-updated', (ref) => {
    seen.push(ref)
  })
  return seen
}

describe('resolveSpec', () => {
  it('defaults to .credentials.yaml under the harness home with watching on', () => {
    const spec = resolveSpec({ dshHome: '/custom/home' })
    expect(spec).toEqual({ filename: resolve('/custom/home/.credentials.yaml'), watch: true, debounceMs: 100 })
  })

  it('lets an explicit path win over the home', () => {
    const spec = resolveSpec({ path: '/etc/dsh/creds.yaml', dshHome: '/ignored', watch: false, debounceMs: 5 })
    expect(spec).toEqual({ filename: resolve('/etc/dsh/creds.yaml'), watch: false, debounceMs: 5 })
  })
})

describe('layering and reads', () => {
  it('treats an absent file as an empty writable store', async () => {
    const dir = await tempDir()
    const ctx = await boot({ path: join(dir, '.credentials.yaml'), watch: false })
    expect(await ctx.credentials.resolve(KEY)).toBeUndefined()
    expect(await ctx.credentials.describe(KEY)).toEqual({ configured: false, writable: true })
  })

  it('serves file entries alongside comments and quoted values', async () => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    await writeCredentials(path, 'version: 1\nrefs:\n  # notes\n  DSH_CRED_TEST: plain\n  DSH_CRED_OTHER: "with space"\n')
    const ctx = await boot({ path, watch: false })
    expect(await ctx.credentials.resolve(KEY)).toEqual({ value: 'plain', source: 'file' })
    expect(await ctx.credentials.resolve(OTHER)).toEqual({ value: 'with space', source: 'file' })
    expect(await ctx.credentials.describe(KEY)).toEqual({ configured: true, source: 'file', writable: true })
  })

  it('lets the managed file win over a non-empty process environment', async () => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    await writeCredentials(path, 'version: 1\nrefs:\n  DSH_CRED_TEST: from-file\n')
    const ctx = await boot({ path, watch: false })
    vi.stubEnv('DSH_CRED_TEST', 'from-env')
    expect(await ctx.credentials.resolve(KEY)).toEqual({ value: 'from-file', source: 'file' })
    expect(await ctx.credentials.describe(KEY)).toEqual({ configured: true, source: 'file', writable: true })
  })

  it('treats an empty environment value as absent, falling through to the file', async () => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    await writeCredentials(path, 'version: 1\nrefs:\n  DSH_CRED_TEST: stored\n')
    const ctx = await boot({ path, watch: false })
    vi.stubEnv('DSH_CRED_TEST', '')
    expect(await ctx.credentials.resolve(KEY)).toEqual({ value: 'stored', source: 'file' })
    expect(await ctx.credentials.describe(KEY)).toEqual({ configured: true, source: 'file', writable: true })
  })

  it('fails boot loud when the document exists but cannot be read', async () => {
    const dir = await tempDir()
    const path = join(dir, 'occupied')
    await mkdir(path)
    const ctx = new Context()
    await expect(ctx.plugin(LocalCredentialProvider, { path, watch: false })).rejects.toThrow()
  })
})

describe('layer ladder', () => {
  // .credentials.yaml > inherited process env > invoking directory .env >
  // $DSH_HOME/.env.
  async function bootLayered(
    path: string,
    layers: Parameters<typeof createLaunchEnvironmentSnapshot>[0],
  ): Promise<Context> {
    const ctx = new Context()
    ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot(layers))
    const fiber = ctx.plugin(LocalCredentialProvider, { path, watch: false })
    cleanups.push(async () => { await fiber.dispose() })
    await fiber
    return ctx
  }

  it('lets the stored value beat the user .env, so a UI write takes effect immediately', async () => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    await writeCredentials(path, 'version: 1\nrefs:\n  DSH_CRED_TEST: stored\n')
    const ctx = await bootLayered(path, [
      { source: 'process', values: {} },
      { source: 'user-env', path: '/home/.dsh/.env', values: { DSH_CRED_TEST: 'older-user-env' } },
    ])
    expect(await ctx.credentials.resolve(KEY)).toEqual({ value: 'stored', source: 'file' })
    // A key sitting in the user's .env does not make the stored one
    // unwritable.
    expect(await ctx.credentials.describe(KEY)).toEqual({ configured: true, source: 'file', writable: true })
    await expect(ctx.credentials.set(KEY, 'rotated')).resolves.toBeUndefined()
    expect(await ctx.credentials.resolve(KEY)).toEqual({ value: 'rotated', source: 'file' })
  })

  it('stores over a launch environment value and reveals it again after unset', async () => {
    const dir = await tempDir()
    const ctx = await bootLayered(join(dir, '.credentials.yaml'), [
      { source: 'process', values: { DSH_CRED_TEST: 'from-launch' } },
    ])
    expect(await ctx.credentials.resolve(KEY)).toEqual({ value: 'from-launch', source: 'env' })
    expect(await ctx.credentials.describe(KEY)).toEqual({ configured: true, source: 'env', writable: true })
    await ctx.credentials.set(KEY, 'stored')
    expect(await ctx.credentials.resolve(KEY)).toEqual({ value: 'stored', source: 'file' })
    await ctx.credentials.unset(KEY)
    expect(await ctx.credentials.resolve(KEY)).toEqual({ value: 'from-launch', source: 'env' })
  })

  it('serves the user .env only when nothing is stored', async () => {
    const dir = await tempDir()
    const ctx = await bootLayered(join(dir, '.credentials.yaml'), [
      { source: 'process', values: {} },
      { source: 'user-env', path: '/home/.dsh/.env', values: { DSH_CRED_TEST: 'from-user-env' } },
    ])
    expect(await ctx.credentials.resolve(KEY)).toEqual({ value: 'from-user-env', source: 'user-env' })
    // Writable: storing a key replaces it as the effective one.
    expect(await ctx.credentials.describe(KEY)).toEqual({ configured: true, source: 'user-env', writable: true })
  })

  it('serves the invoking project .env over the user one, but never over the store', async () => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    // The product trusts the project it is launched in, so a checkout may
    // carry its own key — ranked above the user's home file (more specific
    // wins) and below the managed store, which a stored key must never lose to.
    const layers = [
      { source: 'process' as const, values: {} },
      { source: 'project-env' as const, path: '/work/.env', values: { DSH_CRED_TEST: 'from-project' } },
      { source: 'user-env' as const, path: '/home/.dsh/.env', values: { DSH_CRED_TEST: 'from-user' } },
    ]
    const bare = await bootLayered(path, layers)
    expect(await bare.credentials.resolve(KEY)).toEqual({ value: 'from-project', source: 'project-env' })
    expect(await bare.credentials.describe(KEY)).toEqual({ configured: true, source: 'project-env', writable: true })

    await writeCredentials(path, 'version: 1\nrefs:\n  DSH_CRED_TEST: stored\n')
    const stored = await bootLayered(path, layers)
    expect(await stored.credentials.resolve(KEY)).toEqual({ value: 'stored', source: 'file' })
  })

  it.skipIf(process.platform === 'win32')('refuses a document other OS users can read', async () => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    await writeFile(path, 'version: 1\nrefs:\n  DSH_CRED_TEST: leaked\n', { mode: 0o644 })
    const ctx = new Context()
    // Before the contents are read at all: serving secrets out of a
    // world-readable file would make the 0600 the provider writes meaningless.
    await expect(ctx.plugin(LocalCredentialProvider, { path, watch: false }))
      .rejects.toThrow(/readable beyond its owner \(mode 644\)/)
  })

  it('propagates a permission check that fails for a reason other than absence', async () => {
    const dir = await tempDir()
    const notADirectory = join(dir, 'occupied')
    await writeFile(notADirectory, 'a regular file\n')
    // An absent document is an empty store, but a path that cannot be
    // reached at all is a misconfiguration: the parent is a file, so the
    // check fails with ENOTDIR rather than concluding "no credentials yet".
    const ctx = new Context()
    await expect(ctx.plugin(LocalCredentialProvider, { path: join(notADirectory, '.credentials.yaml'), watch: false }))
      .rejects.toThrow(/ENOTDIR/)
  })

  it('propagates a permission check rejected before the OS lookup', async () => {
    const dir = await tempDir()
    const ctx = new Context()
    await expect(ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials\0.yaml'), watch: false }))
      .rejects.toMatchObject({ code: 'ERR_INVALID_ARG_VALUE' })
  })

  it('propagates a read that fails for a reason other than absence', async () => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    // Owner-only, so the permission check passes, and unreadable as a file:
    // the store is present but cannot be parsed, which must fail the launch
    // rather than silently serve nothing.
    await mkdir(path, { mode: 0o700 })
    const ctx = new Context()
    await expect(ctx.plugin(LocalCredentialProvider, { path, watch: false })).rejects.toThrow(/EISDIR/)
  })

  it('keeps the managed store writable when the inherited environment also names it', async () => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    await writeCredentials(path, 'version: 1\nrefs:\n  DSH_CRED_TEST: stored\n')
    const ctx = await bootLayered(path, [
      { source: 'process', values: { DSH_CRED_TEST: 'from-shell' } },
      { source: 'user-env', path: '/home/.dsh/.env', values: { DSH_CRED_TEST: 'from-user-env' } },
    ])
    expect(await ctx.credentials.resolve(KEY)).toEqual({ value: 'stored', source: 'file' })
    expect(await ctx.credentials.describe(KEY)).toEqual({ configured: true, source: 'file', writable: true })
    await expect(ctx.credentials.set(KEY, 'next')).resolves.toBeUndefined()
    expect(await ctx.credentials.resolve(KEY)).toEqual({ value: 'next', source: 'file' })
  })
})

describe('document validation', () => {
  // Every rejection below is a boot failure rather than a skipped entry: inside
  // `refs` and `records`, an ignored entry would read as "the secret I stored
  // has no effect". Only a foreign top-level key is tolerated.
  it.each([
    ['a non-mapping root', 'just a string\n', /must be a mapping/],
    ['a sequence root', '- DSH_CRED_TEST\n', /must be a mapping/],
    // A flat document the boot migration cannot prove it understands is
    // refused by name rather than read as an empty store or rewritten: a
    // silently ignored document would surface as an authentication failure on
    // the first request instead of at load. (The recognized all-string flat
    // layout upgrades in place instead — migration.spec owns that path.)
    ['the flat layout with a non-string value', 'DSH_CRED_TEST: [nope]\n', /nest the existing 1 entry under/],
    ['the flat layout with several entries and a non-string value', 'DSH_CRED_TEST: a\nDSH_CRED_OTHER: [b]\n',
      /nest the existing 2 entries under/],
    ['the flat layout with an empty value', 'DSH_CRED_TEST: ""\n', /pre-release flat layout/],
    ['the flat layout with an unaddressable key', 'not-a-ref: value\n', /pre-release flat layout/],
    ['the flat layout with a non-string key', '1: a\n', /pre-release flat layout/],
    ['the flat layout under document directives', '%YAML 1.2\n---\nDSH_CRED_TEST: a\n',
      /pre-release flat layout/],
    ['a future version', 'version: 2\nrefs: {}\n', /this build reads version 1/],
    ['a non-mapping refs section', 'version: 1\nrefs: nope\n', /"refs" .* must be a mapping/],
    ['a key that is not a POSIX identifier', 'version: 1\nrefs:\n  not-a-ref: value\n', /credential ref/],
    ['a non-string value', 'version: 1\nrefs:\n  DSH_CRED_TEST: 123\n', /must be a string/],
    ['an empty value', 'version: 1\nrefs:\n  DSH_CRED_TEST: ""\n', /is empty/],
    ['a record key that is not scoped', 'version: 1\nrecords:\n  codex:\n    kind: grant\n    payload: 1\n',
      /must be "<scope>\/<id>"/],
    ['a record that is not a mapping', 'version: 1\nrecords:\n  llm-pi-ai/codex: token\n',
      /record "llm-pi-ai\/codex" .* must be a mapping/],
    ['a record with no kind', 'version: 1\nrecords:\n  llm-pi-ai/codex:\n    payload: 1\n', /has no kind/],
    ['a record with an unknown kind', 'version: 1\nrecords:\n  llm-pi-ai/codex:\n    kind: token\n',
      /unknown kind "token"/],
    ['a record with an unknown field', 'version: 1\nrecords:\n  llm-pi-ai/codex:\n    kind: grant\n'
      + '    payload: 1\n    extra: 2\n', /unknown field "extra"/],
    ['a grant with no payload', 'version: 1\nrecords:\n  llm-pi-ai/codex:\n    kind: grant\n', /has no payload/],
    // YAML spells values JSON has none for. The seam promises an owner its
    // payload comes back exactly as written, which a lossy round trip breaks.
    ['a non-finite payload number', 'version: 1\nrecords:\n  llm-pi-ai/codex:\n    kind: grant\n'
      + '    payload:\n      ratio: .inf\n', /non-finite number/],
    ['a cyclic payload', 'version: 1\nrecords:\n  llm-pi-ai/codex:\n    kind: grant\n'
      + '    payload: &loop\n      self: *loop\n', /is cyclic/],
    ['an api-key record with an empty key', 'version: 1\nrecords:\n  llm-pi-ai/acme:\n    kind: api-key\n'
      + '    key: ""\n', /non-string or empty key/],
    ['an api-key record env that is not a mapping', 'version: 1\nrecords:\n  llm-pi-ai/acme:\n    kind: api-key\n'
      + '    env: nope\n', /non-mapping env/],
    ['an api-key record env value that is empty', 'version: 1\nrecords:\n  llm-pi-ai/acme:\n    kind: api-key\n'
      + '    env:\n      AWS_PROFILE: ""\n', /env "AWS_PROFILE" .* must be a non-empty string/],
    ['duplicate keys', 'version: 1\nrefs:\n  DSH_CRED_TEST: one\n  DSH_CRED_TEST: two\n', /invalid document/],
    ['malformed yaml', 'DSH_CRED_TEST: "unterminated\n', /invalid document/],
  ])('fails boot on %s', async (_case, text, message) => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    await writeCredentials(path, text)
    const ctx = new Context()
    await expect(ctx.plugin(LocalCredentialProvider, { path, watch: false })).rejects.toThrow(message)
  })

  it('never puts a credential value in a diagnostic', async () => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    const secret = 'sk-live-DO-NOT-LOG-abcdef123456'
    // The yaml parser's own message quotes the offending source line, which in
    // this document is the secret itself. Boot stderr and the watcher's logger
    // both receive whatever this throws.
    await writeCredentials(path, `DSH_CRED_TEST: "${secret}\n`)
    let failure: unknown
    try {
      await new Context().plugin(LocalCredentialProvider, { path, watch: false })
    } catch (error) {
      failure = error
    }
    expect(String(failure)).toMatch(/invalid document/)
    // The position survives; the line's contents do not.
    expect(String(failure)).toMatch(/line 2, column 1/)
    expect(String(failure)).not.toContain(secret)
    expect((failure as Error).stack ?? '').not.toContain(secret)
  })

  it('boots past an unknown top-level key, warns by name, and keeps it through a write', async () => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    vi.stubEnv('GITLAB_TOKEN', '')
    await writeCredentials(path, 'version: 1\nGITLAB_TOKEN: glpat-secret\nACCOUNT_ID: 9007199254740993\n'
      + 'refs:\n  DSH_CRED_TEST: sk-file\n')
    const ctx = new Context()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const fiber = ctx.plugin(LocalCredentialProvider, { path, watch: false })
    cleanups.push(async () => {
      await fiber.dispose()
    })
    await fiber
    expect(await ctx.credentials.resolve(KEY)).toEqual({ value: 'sk-file', source: 'file' })
    expect(await ctx.credentials.resolve(credentialRef('GITLAB_TOKEN'))).toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ignoring unknown top-level'), '"GITLAB_TOKEN", "ACCOUNT_ID"', path)
    expect(JSON.stringify(warn.mock.calls)).not.toContain('glpat-secret')
    await ctx.credentials.set(OTHER, 'sk-other')
    expect(await readFile(path, 'utf8')).toBe(
      'version: 1\nGITLAB_TOKEN: glpat-secret\nACCOUNT_ID: 9007199254740993\n'
      + 'refs:\n  DSH_CRED_TEST: sk-file\n  DSH_CRED_OTHER: sk-other\n')
  })

  it('reads an empty document as an empty store', async () => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    await writeCredentials(path, '# nothing stored yet\n')
    const ctx = await boot({ path, watch: false })
    expect(await ctx.credentials.resolve(KEY)).toBeUndefined()
  })
})

describe('document writes', () => {
  it('adds a missing key to a fresh 0600 document and emits the commit', async () => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    const ctx = await boot({ path, watch: false })
    const seen = updates(ctx)
    await ctx.credentials.set(KEY, 'sk-fresh')
    expect(await readFile(path, 'utf8')).toBe('version: 1\nrefs:\n  DSH_CRED_TEST: sk-fresh\n')
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await ctx.credentials.resolve(KEY)).toEqual({ value: 'sk-fresh', source: 'file' })
    expect(seen).toEqual([KEY])
  })

  it('patches one entry, preserving comments and every untouched entry', async () => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    await writeCredentials(path, 'version: 1\nrefs:\n  # deployment notes\n  DSH_CRED_OTHER: keep\n\n  # the one under edit\n  DSH_CRED_TEST: old\n')
    const ctx = await boot({ path, watch: false })
    await ctx.credentials.set(KEY, 'new value!')
    expect(await readFile(path, 'utf8')).toBe(
      'version: 1\nrefs:\n  # deployment notes\n  DSH_CRED_OTHER: keep\n\n'
      + '  # the one under edit\n  DSH_CRED_TEST: new value!\n',
    )
  })

  it('round-trips values no dotenv line could represent', async () => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    const ctx = await boot({ path, watch: false })
    const multiLine = 'line one\nline two'
    const mixedQuotes = 'both \' and "'
    await ctx.credentials.set(KEY, multiLine)
    await ctx.credentials.set(OTHER, mixedQuotes)
    const reread = await boot({ path, watch: false })
    expect(await reread.credentials.resolve(KEY)).toEqual({ value: multiLine, source: 'file' })
    expect(await reread.credentials.resolve(OTHER)).toEqual({ value: mixedQuotes, source: 'file' })
    expect(await reread.credentials.describe(KEY)).toEqual({ configured: true, source: 'file', writable: true })
  })

  it('unsets only the owning entry, with its own annotation, and keeps an absent unset silent', async () => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    // Comments above an entry are that entry's annotation and go with it when
    // it is removed — including anything above the document's first entry.
    // Every other entry keeps its own comments.
    await writeCredentials(path, 'version: 1\nrefs:\n  # about the doomed one\n  DSH_CRED_TEST: gone\n  # about the survivor\n  DSH_CRED_OTHER: stays\n')
    const ctx = await boot({ path, watch: false })
    const seen = updates(ctx)
    await ctx.credentials.unset(KEY)
    expect(await readFile(path, 'utf8')).toBe('version: 1\nrefs:\n  # about the survivor\n  DSH_CRED_OTHER: stays\n')
    await ctx.credentials.unset(KEY)
    expect(seen).toEqual([KEY])
  })

  it('rejects empty values but lets the managed value replace the environment', async () => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    await writeCredentials(path, 'version: 1\nrefs:\n  DSH_CRED_TEST: stored\n')
    const ctx = await boot({ path, watch: false })

    await expect(ctx.credentials.set(KEY, '')).rejects.toThrow(/empty value/)

    vi.stubEnv('DSH_CRED_TEST', 'shadowing')
    await expect(ctx.credentials.set(KEY, 'next')).resolves.toBeUndefined()
    expect(await ctx.credentials.resolve(KEY)).toEqual({ value: 'next', source: 'file' })
    await expect(ctx.credentials.unset(KEY)).resolves.toBeUndefined()
    expect(await ctx.credentials.resolve(KEY)).toEqual({ value: 'shadowing', source: 'env' })
  })

  it('leaves an empty mapping after unsetting the only entry', async () => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    await writeCredentials(path, 'version: 1\nrefs:\n  DSH_CRED_TEST: only\n')
    const ctx = await boot({ path, watch: false })
    await ctx.credentials.unset(KEY)
    expect(await readFile(path, 'utf8')).toBe('version: 1\nrefs: {}\n')
    // The emptied document still reloads as an empty store, not a parse error.
    const reread = await boot({ path, watch: false })
    expect(await reread.credentials.resolve(KEY)).toBeUndefined()
  })

  it('fails a write loud when the on-disk document became invalid', async () => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    const ctx = await boot({ path, watch: false })
    // An external editor left the document unparsable: the read-modify-write
    // must refuse rather than overwrite content it cannot understand.
    await writeCredentials(path, 'DSH_CRED_TEST: "unterminated\n')
    await expect(ctx.credentials.set(OTHER, 'lands')).rejects.toThrow(/invalid document/)
  })

  it('chains past a rejected write so one bad value cannot poison the queue', async () => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    const ctx = await boot({ path, watch: false })
    const bad = expect(ctx.credentials.set(KEY, '')).rejects.toThrow(/empty value/)
    const good = ctx.credentials.set(OTHER, 'lands')
    await bad
    await good
    expect(await readFile(path, 'utf8')).toBe('version: 1\nrefs:\n  DSH_CRED_OTHER: lands\n')
  })

  it('serializes concurrent writes so both land in the one document', async () => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    const ctx = await boot({ path, watch: false })
    await Promise.all([
      ctx.credentials.set(KEY, 'one'),
      ctx.credentials.set(OTHER, 'two'),
    ])
    expect(await readFile(path, 'utf8')).toBe('version: 1\nrefs:\n  DSH_CRED_TEST: one\n  DSH_CRED_OTHER: two\n')
  })

  it('refuses writes after disposal', async () => {
    const dir = await tempDir()
    const ctx = new Context()
    const fiber = ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
    await fiber
    // Capture the handle first: disposal also removes the ctx.credentials service.
    const service = ctx.credentials
    await fiber.dispose()
    await expect(service.set(KEY, 'late')).rejects.toThrow(/disposed/)
  })
})

describe('real hot reload', () => {
  it('publishes external edits, replaces the snapshot wholesale, and suppresses self-writes', async () => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    // Watching starts on an existing document: creation racing watcher setup
    // is a chokidar readiness gap, not the reload contract under test.
    await writeCredentials(path, 'version: 1\nrefs:\n  DSH_CRED_TEST: boot\n')
    const ctx = await boot({ path, debounceMs: 10 })
    const seen = updates(ctx)

    await writeCredentials(path, 'version: 1\nrefs:\n  DSH_CRED_TEST: live\n  DSH_CRED_OTHER: extra\n')
    await vi.waitFor(async () => {
      expect(await ctx.credentials.resolve(KEY)).toEqual({ value: 'live', source: 'file' })
    })

    // Wholesale replacement: an entry deleted on disk never lingers in memory.
    await writeCredentials(path, 'version: 1\nrefs:\n  DSH_CRED_TEST: live\n')
    await vi.waitFor(async () => {
      expect(await ctx.credentials.resolve(OTHER)).toBeUndefined()
    })

    const before = seen.length
    await ctx.credentials.set(KEY, 'self-written')
    await new Promise(resolvePause => setTimeout(resolvePause, 200))
    // Exactly the committed write's own event: the watcher echo of our own
    // content is recognized by the text cache and publishes nothing extra.
    expect(seen.length).toBe(before + 1)
    expect(await ctx.credentials.resolve(KEY)).toEqual({ value: 'self-written', source: 'file' })
  })
})
