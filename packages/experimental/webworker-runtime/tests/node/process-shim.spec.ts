/**
 * The worker's process shim: the layout-derived environment and the Node 22
 * `getBuiltinModule` face, which must answer the loader's module proxies for
 * builtin ids and undefined for everything else — never an image resolution.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { installProcessGlobal } from '../../src/node/globals/process.ts'
import { setActiveModuleLoader, WorkerModuleLoader } from '../../src/module-system/module-loader.ts'
import { MemoryVfs } from '../../src/storage/memory.ts'
import { spawnSync } from '../../src/node/builtin_modules/implemented/child_process.ts'

const realProcess = globalThis.process

afterEach(() => {
  ;(globalThis as { process: unknown }).process = realProcess
})

describe('process shim', () => {
  it('publishes cwd, env, and version zero for the loader probe', () => {
    const shim = installProcessGlobal({ cwd: '/dsh', env: { DSH_HOME: '/dsh/home' } })
    expect(shim.cwd()).toBe('/dsh')
    expect(shim.env.DSH_HOME).toBe('/dsh/home')
    expect(shim.title).toBe('dsh-webworker')
    // "0.0.0" keeps the vendored Loader off Node internals so the worker owns
    // the module seam.
    expect(shim.versions.node).toBe('0.0.0')
  })

  it('exposes an executable identity without enabling Node programs', () => {
    const shim = installProcessGlobal({ cwd: '/dsh', env: {} })
    expect(shim.execPath).toBe('/dsh/bin/node')
    expect(spawnSync(shim.execPath, ['--eval', 'throw new Error("must not execute")']).error?.code).toBe('ENOENT')
  })

  it('answers getBuiltinModule from the module proxies and undefined otherwise', () => {
    const fs = { marker: 'fs-proxy' }
    // The table holds factories, and a builtin must keep one identity across
    // requires (`instanceof`, `Buffer.isBuffer`), so this one answers with the
    // same object every time.
    const factory = (): unknown => fs
    const vfs = new MemoryVfs()
    vfs.seedDirectory('/dsh')
    const loader = new WorkerModuleLoader({
      vfs,
      root: '/dsh',
      staticModules: { 'node:fs': factory, 'fs': factory },
    })
    setActiveModuleLoader(loader)
    const shim = installProcessGlobal({ cwd: '/dsh', env: {} })
    // The shim calls the factory: a caller receives the module, never the thunk.
    expect(shim.getBuiltinModule('fs')).toBe(fs)
    expect(shim.getBuiltinModule('node:fs')).toBe(fs)
    expect(shim.getBuiltinModule('no-such-builtin')).toBeUndefined()
  })
})
