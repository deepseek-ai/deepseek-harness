import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import { createLaunchEnvironmentSnapshot, DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import { authContextFrom, credentialStoreFrom, recordKeyFor } from '../src/auth.ts'

const home = vi.hoisted(() => ({ unavailable: false }))

// libuv throws when HOME is unset and the process UID has no passwd entry.
vi.mock('node:os', async (importOriginal) => {
  const os = await importOriginal<typeof import('node:os')>()
  return {
    ...os,
    homedir: () => {
      if (home.unavailable) throw new Error('uv_os_homedir returned ENOENT')
      return os.homedir()
    },
  }
})

const CODEX = recordKeyFor('openai-codex')

const dirs: string[] = []

/** A context whose credential records live in a throwaway `$DSH_HOME`. */
async function stored(
  layers?: Parameters<typeof createLaunchEnvironmentSnapshot>[0],
  initialRefs?: Record<string, string>,
): Promise<Context> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pi-auth-'))
  dirs.push(dir)
  const ctx = new Context()
  if (layers !== undefined) ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot(layers))
  const path = join(dir, '.credentials.yaml')
  if (initialRefs !== undefined) {
    const refs = Object.entries(initialRefs).map(([name, value]) => `  ${name}: ${value}`).join('\n')
    await writeFile(path, `version: 1\nrefs:\n${refs}\n`, { mode: 0o600 })
  }
  await ctx.plugin(LocalCredentialProvider, { path, watch: false })
  return ctx
}

afterEach(async () => {
  vi.unstubAllEnvs()
  home.unavailable = false
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('pi-ai credential store over harness records', () => {
  it('reads nothing for a provider with no record', async () => {
    const store = credentialStoreFrom(await stored())

    await expect(store.read('openai-codex')).resolves.toBeUndefined()
  })

  it('round-trips an api-key credential field by field', async () => {
    const ctx = await stored()
    const store = credentialStoreFrom(ctx)

    await store.modify('cloudflare', () =>
      Promise.resolve({ type: 'api_key', key: 'sk-live', env: { ACCOUNT_ID: 'acct-1' } }))

    await expect(store.read('cloudflare'))
      .resolves.toEqual({ type: 'api_key', key: 'sk-live', env: { ACCOUNT_ID: 'acct-1' } })
    await expect(ctx.credentials.readRecord(recordKeyFor('cloudflare')))
      .resolves.toEqual({ kind: 'api-key', key: 'sk-live', env: { ACCOUNT_ID: 'acct-1' } })
  })

  it('stores an api-key credential carrying neither a key nor env', async () => {
    const store = credentialStoreFrom(await stored())

    await store.modify('bedrock', () => Promise.resolve({ type: 'api_key' }))

    await expect(store.read('bedrock')).resolves.toEqual({ type: 'api_key' })
  })

  it('keeps an OAuth credential verbatim, refresh fields and all', async () => {
    const ctx = await stored()
    const store = credentialStoreFrom(ctx)
    const granted = { type: 'oauth' as const, access: 'at', refresh: 'rt', expires: 42, accountId: 'acc' }

    await store.modify('openai-codex', () => Promise.resolve(granted))

    await expect(store.read('openai-codex')).resolves.toEqual(granted)
    await expect(ctx.credentials.readRecord(CODEX)).resolves.toEqual({ kind: 'grant', payload: granted })
  })

  it('stores the JSON image of a grant, dropping explicitly-undefined members', async () => {
    const ctx = await stored()
    const store = credentialStoreFrom(ctx)
    // The github.com Copilot shape: pi-ai sets optional members to explicit
    // undefined, which the strict record validator refuses verbatim.
    const granted = {
      type: 'oauth' as const,
      access: 'at',
      refresh: 'rt',
      expires: 42,
      enterpriseUrl: undefined,
      nested: { keep: 'x', drop: undefined },
      list: ['a', undefined, 'b'],
    }

    await store.modify('github-copilot', () => Promise.resolve(granted))

    await expect(ctx.credentials.readRecord(recordKeyFor('github-copilot'))).resolves.toEqual({
      kind: 'grant',
      payload: {
        type: 'oauth',
        access: 'at',
        refresh: 'rt',
        expires: 42,
        nested: { keep: 'x' },
        list: ['a', null, 'b'],
      },
    })
  })

  it('passes a genuinely unstorable grant value through to the store\'s loud refusal', async () => {
    const ctx = await stored()
    const store = credentialStoreFrom(ctx)
    // A foreign-prototype member is not the undefined idiom: the image leaves
    // it untouched and the record validator still refuses the write.
    const granted = { type: 'oauth' as const, access: 'at', refresh: 'rt', expires: 42, issued: new Date(0) }

    await expect(store.modify('github-copilot', () => Promise.resolve(granted)))
      .rejects.toThrow(/JSON cannot represent/)
  })

  it('shows the mutation the current credential and leaves it alone when declined', async () => {
    const store = credentialStoreFrom(await stored())
    await store.modify('openai-codex', () =>
      Promise.resolve({ type: 'oauth', access: 'first', refresh: 'r', expires: 1 }))
    const seen: unknown[] = []

    const unchanged = await store.modify('openai-codex', (current) => {
      seen.push(current)
      return Promise.resolve(undefined)
    })

    expect(seen).toEqual([{ type: 'oauth', access: 'first', refresh: 'r', expires: 1 }])
    expect(unchanged).toEqual({ type: 'oauth', access: 'first', refresh: 'r', expires: 1 })
  })

  it('lists only the records this adapter family owns', async () => {
    const ctx = await stored()
    const store = credentialStoreFrom(ctx)
    await store.modify('openai-codex', () =>
      Promise.resolve({ type: 'oauth', access: 'at', refresh: 'rt', expires: 1 }))
    await store.modify('cloudflare', () => Promise.resolve({ type: 'api_key', key: 'k' }))
    // Another plugin's record for a provider name this one also serves: its
    // payload is written in a format pi-ai never agreed to.
    await ctx.credentials.modifyRecord(credentialKey('llm-kimi', 'openai-codex'), () =>
      Promise.resolve({ kind: 'grant', payload: { theirs: true } }))

    await expect(store.list()).resolves.toEqual([
      { providerId: 'openai-codex', type: 'oauth' },
      { providerId: 'cloudflare', type: 'api_key' },
    ])
  })

  it('forgets a credential on delete, and stays quiet when there was none', async () => {
    const store = credentialStoreFrom(await stored())
    await store.modify('openai-codex', () =>
      Promise.resolve({ type: 'oauth', access: 'at', refresh: 'rt', expires: 1 }))

    await store.delete('openai-codex')
    await store.delete('openai-codex')

    await expect(store.read('openai-codex')).resolves.toBeUndefined()
  })

  it('reads empty but refuses to write without a credentials service', async () => {
    const store = credentialStoreFrom(new Context())

    await expect(store.read('openai-codex')).resolves.toBeUndefined()
    await expect(store.list()).resolves.toEqual([])
    await expect(store.modify('openai-codex', () => Promise.resolve({ type: 'api_key', key: 'k' })))
      .rejects.toThrow(/mounts no credentials service/)
    await expect(store.delete('openai-codex')).rejects.toThrow(/mounts no credentials service/)
  })

  it('treats a provider id outside the record grammar as holding nothing', async () => {
    const store = credentialStoreFrom(await stored())

    // A hand-declared route key is an arbitrary settings dict key, and pi-ai
    // reads it during auth resolution: the answer is "not signed in", never a
    // thrown address error…
    await expect(store.read('My_Proxy')).resolves.toBeUndefined()
    // …nothing can ever be stored under it, so a logout has nothing to remove…
    await expect(store.delete('My_Proxy')).resolves.toBeUndefined()
    // …while a write that cannot land must refuse rather than report success.
    await expect(store.modify('My_Proxy', () => Promise.resolve({ type: 'api_key', key: 'k' })))
      .rejects.toThrow(/cannot address a stored credential record/)
  })
})

describe('pi-ai ambient auth context', () => {
  beforeEach(() => {
    vi.stubEnv('PI_AUTH_AMBIENT', 'from-environment')
  })

  it('answers an environment name from the credential seam first', async () => {
    const ctx = await stored()
    await ctx.credentials.set(credentialRef('PI_AUTH_SEAM'), 'from-seam')

    await expect(authContextFrom(ctx).env('PI_AUTH_SEAM')).resolves.toBe('from-seam')
  })

  it('gives a stored credential priority over every launch layer', async () => {
    const ctx = await stored([
      { source: 'process', values: { OPENAI_API_KEY: 'from-launch' } },
      { source: 'project-env', path: '/work/.env', values: { OPENAI_API_KEY: 'from-project' } },
      { source: 'user-env', path: '/home/.dsh/.env', values: { OPENAI_API_KEY: 'from-home' } },
    ], { OPENAI_API_KEY: 'from-credentials' })

    await expect(authContextFrom(ctx).env('OPENAI_API_KEY')).resolves.toBe('from-credentials')
  })

  it('falls back to the launch environment when nothing is stored', async () => {
    await expect(authContextFrom(await stored()).env('PI_AUTH_AMBIENT')).resolves.toBe('from-environment')
  })

  it('answers "not set" for a name no reference could ever address', async () => {
    // pi-ai asks about provider-declared names; one outside the reference
    // grammar has no reference to miss, and must not throw.
    await expect(authContextFrom(await stored()).env('not a var')).resolves.toBeUndefined()
  })

  it('answers about the host filesystem, expanding a leading ~', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-pi-home-'))
    dirs.push(dir)
    await writeFile(join(dir, 'creds'), 'x')
    // Both spellings of "home": os.homedir() reads HOME on POSIX and
    // USERPROFILE on Windows, and the expansion under test goes through it.
    vi.stubEnv('HOME', dir)
    vi.stubEnv('USERPROFILE', dir)
    const context = authContextFrom(await stored())

    await expect(context.fileExists('~/creds')).resolves.toBe(true)
    await expect(context.fileExists('~/missing')).resolves.toBe(false)
    await expect(context.fileExists(join(dir, 'creds'))).resolves.toBe(true)
    await expect(context.fileExists('~')).resolves.toBe(true)
  })

  it('checks an absolute path without reading the home directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-pi-home-'))
    dirs.push(dir)
    await writeFile(join(dir, 'creds'), 'x')
    const context = authContextFrom(await stored())
    vi.stubEnv('HOME', undefined)
    vi.stubEnv('USERPROFILE', undefined)
    home.unavailable = true

    await expect(context.fileExists(join(dir, 'creds'))).resolves.toBe(true)
  })
})
