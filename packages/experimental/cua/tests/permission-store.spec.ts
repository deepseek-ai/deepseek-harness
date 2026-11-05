/** Durable profile and conversation decisions use the production storage composition. */
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, symlink } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import * as Domains from '@deepseek-ai/dsh-storage-domain'
import { expect, it, onTestFinished } from 'vitest'
import { CuaPermissionStore } from '../src/permission-store.ts'
import type { CuaApplicationGrant, CuaApplicationId } from '../src/application-types.ts'

const signal = new AbortController().signal
const grant = { id: 'a'.repeat(64) as CuaApplicationId, name: 'Fixture', executablePath: '/fixture/app' }

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'cua-permission-store-'))
  const storageRoot = join(root, 'storages'), directory = join(root, 'profile')
  await mkdir(directory)
  const contexts: Context[] = []
  onTestFinished(async () => { for (const ctx of contexts) await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  const open = async (profile = directory, legacy: readonly CuaApplicationGrant[] = []) => {
    const ctx = new Context(); contexts.push(ctx)
    ctx.provide('profileContext', { dir: profile })
    await ctx.plugin(Storage)
    await ctx.plugin(JsonStorage, { root: storageRoot })
    const domain = await ctx.plugin(Domains, { backend: 'json' })
    return { ctx, domain, store: new CuaPermissionStore(ctx, legacy, 30_000) }
  }
  return { root, storageRoot, directory, open }
}

it('imports legacy grants once, retains conversation choices, and never restores a revoked legacy grant', async () => {
  const f = await setup(), first = await f.open(f.directory, [grant])
  await first.store.withState(signal, async (transaction) => {
    expect(transaction.state.applications[grant.id]?.always).toEqual(grant)
    await transaction.save({ migrated: true, applications: { [grant.id]: { revoked: 1, sessions: {
      conversation: { identity: grant, decision: 'allow', revision: 1 },
      refused: { identity: grant, decision: 'deny', revision: 2 },
    } } } })
  })
  await first.ctx.fiber.dispose()
  const resumed = await f.open(f.directory, [grant])
  const stored = await resumed.store.withState(signal, transaction => transaction.state)
  expect(stored.applications[grant.id]?.always).toBeUndefined()
  expect(stored.applications[grant.id]?.sessions.conversation?.decision).toBe('allow')
  expect(stored.applications[grant.id]?.sessions.refused?.decision).toBe('deny')
  expect(stored.applications[grant.id]?.sessions.another).toBeUndefined()
  const files = await readdir(f.storageRoot)
  expect(files).toHaveLength(1)
  expect(files[0]).toMatch(/^cua_permissions_[a-f0-9]{64}\.json$/)
  expect(await readFile(join(f.storageRoot, files[0]!), 'utf8')).toContain('conversation')
})

it('isolates different profiles that use the same storage root', async () => {
  const f = await setup(), a = await f.open(f.directory, [grant])
  await a.store.withState(signal, transaction => transaction.state)
  const other = join(f.root, 'other'); await mkdir(other)
  const b = await f.open(other)
  expect(await b.store.withState(signal, transaction => transaction.state.applications)).toEqual({})
  expect(await readdir(f.storageRoot)).toHaveLength(2)
})

it('reloads saved grants and conversation decisions with omitted executable paths', async () => {
  const f = await setup(), first = await f.open()
  const identity = { id: grant.id, name: grant.name }
  await first.store.withState(signal, transaction => transaction.save({ migrated: true, applications: {
    [grant.id]: { revoked: 0, always: identity, sessions: { conversation: { identity, decision: 'allow', revision: 1 } } },
  } }))
  await first.ctx.fiber.dispose()
  const resumed = await f.open()
  const stored = await resumed.store.withState(signal, transaction => transaction.state.applications[grant.id])
  expect(stored?.always).toEqual(identity)
  expect(stored?.sessions.conversation?.identity).toEqual(identity)
})

it.skipIf(process.platform === 'win32')('uses the same profile identity through a directory symlink', async () => {
  const f = await setup(), a = await f.open(f.directory, [grant])
  await a.store.withState(signal, transaction => transaction.state)
  const alias = join(f.root, 'alias'); await symlink(f.directory, alias)
  const b = await f.open(alias)
  expect(await b.store.withState(signal, transaction => transaction.state.applications[grant.id]?.always)).toEqual(grant)
  expect(await readdir(f.storageRoot)).toHaveLength(1)
})

it('reloads another process’s writes instead of reusing an in-memory authorization snapshot', async () => {
  const f = await setup(), a = await f.open(f.directory, [grant])
  await a.store.withState(signal, transaction => transaction.state)
  const controller = new AbortController()
  const file = join(f.storageRoot, (await readdir(f.storageRoot))[0]!)
  const running = promisify(execFile)(process.execPath, [
    fileURLToPath(new URL('./fixtures/permission-store-worker.ts', import.meta.url)), file, grant.id,
  ], { cwd: process.cwd(), env: { PATH: process.env.PATH }, signal: controller.signal })
  onTestFinished(async () => { controller.abort(); await running.catch(() => {}) })
  expect((await running).stdout).toBe('saved\n')
  const latest = await a.store.withState(signal, transaction => transaction.state.applications[grant.id])
  expect(latest).toMatchObject({ revoked: 1, always: { name: 'Other process' } })
})

it('serializes independent domain owners, cancels a waiting operation, and closes after a failure', async () => {
  const f = await setup(), a = await f.open(), b = await f.open()
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  const holding = a.store.withState(signal, async (transaction) => {
    entered.resolve(undefined)
    await release.promise
    return transaction.state
  })
  await entered.promise
  const controller = new AbortController(); controller.abort(new Error('cancelled'))
  await expect(b.store.withState(controller.signal, () => { throw new Error('must not enter') })).rejects.toThrow('cancelled')
  const next = b.store.withState(signal, async (transaction) => {
    await transaction.save({ migrated: true, applications: {} })
    throw new Error('operation failed after commit')
  })
  const failed = expect(next).rejects.toThrow('operation failed after commit')
  release.resolve(undefined); await holding; await failed
  expect(await a.store.withState(signal, transaction => transaction.state.migrated)).toBe(true)
  await Promise.all([a.store.drain(), b.store.drain()])
})

it('rejects malformed or identity-mismatched data without replacing it with legacy grants', async () => {
  const f = await setup(), a = await f.open(f.directory, [grant])
  await a.store.withState(signal, transaction => transaction.state)
  const file = join(f.storageRoot, (await readdir(f.storageRoot))[0]!)
  const valid = await readFile(file, 'utf8')
  await writeFile(file, '{broken')
  await expect(a.store.withState(signal, transaction => transaction.state)).rejects.toThrow()
  expect(await readFile(file, 'utf8')).toBe('{broken')
  const altered = JSON.parse(valid) as { global: { applications: Record<string, { always: CuaApplicationGrant }> } }
  altered.global.applications[grant.id]!.always.id = 'b'.repeat(64) as CuaApplicationId
  const mismatch = JSON.stringify(altered); await writeFile(file, mismatch)
  await expect(a.store.withState(signal, transaction => transaction.state)).rejects.toMatchObject({ code: 'invalid-record' })
  expect(await readFile(file, 'utf8')).toBe(mismatch)
})

it('uses temporary decisions only without a profile and fails when profile storage disappears', async () => {
  const ctx = new Context(); onTestFinished(() => ctx.fiber.dispose())
  const temporary = new CuaPermissionStore(ctx, [], 1000)
  expect(temporary.persistent).toBe(false)
  await temporary.withState(signal, transaction => transaction.save({ migrated: true, applications: {
    [grant.id]: { revoked: 0, sessions: { conversation: { identity: grant, decision: 'allow', revision: 1 } } },
  } }))
  expect(await temporary.withState(signal, transaction => transaction.state.applications[grant.id]?.sessions.conversation?.decision)).toBe('allow')
  const f = await setup(), a = await f.open()
  await a.domain.dispose()
  await expect(a.store.withState(signal, transaction => transaction.state)).rejects.toThrow('require storageDomain')
})

it('does not enter authorization or dispatch when the profile directory cannot be resolved', async () => {
  const f = await setup(), a = await f.open()
  await rm(f.directory, { recursive: true })
  let entered = 0
  await expect(a.store.withState(signal, () => { entered += 1 })).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(a.store.withApplication(grant.id, signal, async () => { entered += 1 })).rejects.toMatchObject({ code: 'ENOENT' })
  expect(entered).toBe(0)
})

it('keeps storage reads and other applications available while one native operation holds its lease', async () => {
  const f = await setup(), a = await f.open(), b = await f.open()
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  const active = a.store.withApplication(grant.id, signal, async () => { entered.resolve(undefined); await release.promise })
  await entered.promise
  expect(await b.store.withState(signal, transaction => transaction.state.migrated)).toBe(true)
  expect(await b.store.withApplication('b'.repeat(64) as CuaApplicationId, signal, async () => 'independent')).toBe('independent')
  const waiting = new AbortController()
  const blocked = b.store.withApplication(grant.id, waiting.signal, async () => 'must not run')
  const rejected = expect(blocked).rejects.toThrow('cancelled')
  waiting.abort(new Error('cancelled'))
  await rejected
  release.resolve(undefined); await active
  await expect(b.store.withApplication(grant.id, signal, async () => { throw new Error('dispatch failed') })).rejects.toThrow('dispatch failed')
  expect(await a.store.withApplication(grant.id, signal, async () => 'released')).toBe('released')
})
