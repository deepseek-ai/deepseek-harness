/** Policy tests use the real store's in-memory composition and injectable durable-write failures. */
import type { Context } from '@deepseek-ai/cordis'
import { isDeepStrictEqual } from 'node:util'
import { vi } from 'vitest'
import { CuaPermissionStore, type PermissionState } from '../src/permission-store.ts'
import type { CuaApplicationGrant } from '../src/application-types.ts'

/**
 * @param ctx Test context.
 * @param initial Existing long-term grants.
 * @param writable Whether long-term decisions can be saved.
 * @returns Store and external writer controls.
 */
export function permissionFixture(ctx: Context, initial: readonly CuaApplicationGrant[] = [], writable = true) {
  const store = new CuaPermissionStore(ctx, initial, 1000)
  const capability = vi.spyOn(store, 'persistent', 'get').mockImplementation(() => writable)
  const original = store.withState.bind(store)
  const grantsOf = (state: PermissionState) => Object.values(state.applications).flatMap(app => app.always ? [app.always] : [])
  let observed = [...initial]
  const save = vi.fn(async (grants: readonly CuaApplicationGrant[], commit?: () => Promise<void>) => {
    if (commit) { await commit(); return }
    await original(new AbortController().signal, async (transaction) => {
      const applications = { ...transaction.state.applications }
      for (const [id, app] of Object.entries(applications)) if (app.always) {
        const { always: _always, ...rest } = app
        applications[id] = { ...rest, revoked: app.revoked + 1 }
      }
      for (const grant of grants) applications[grant.id] = {
        ...(applications[grant.id] ?? { revoked: 0, sessions: {} }), always: grant,
      }
      await transaction.save({ ...transaction.state, applications })
      observed = [...grants]
    })
  })
  const withState = vi.spyOn(store, 'withState').mockImplementation((signal, operation) => original(signal, async (transaction) => {
    observed = grantsOf(transaction.state)
    return operation({ ...transaction, save: async (next) => {
      const nextGrants = grantsOf(next)
      const commit = async () => { await transaction.save(next); observed = nextGrants }
      if (isDeepStrictEqual(observed, nextGrants)) await commit()
      else await save(nextGrants, commit)
    } })
  }))
  return { store, save, withState, grants: () => observed,
    setWritable(value: boolean) { writable = value; capability.mockImplementation(() => writable) },
  }
}
