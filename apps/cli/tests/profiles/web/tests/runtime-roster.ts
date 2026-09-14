/** Runtime evidence collected from the real Web process for default-product isolation. */

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Context, Plugin } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type { WebBootGraph } from '@deepseek-ai/dsh-client-modules/client'
import type {} from '@deepseek-ai/dsh-client-modules'

/** Observed Loader entries, registered plugin instances, loaded modules, and delivered Client entries. */
export interface RuntimeRoster {
  entries: Array<{ id: string; name: string; state: number | undefined }>
  plugins: Array<{ name: string; owner: string | undefined; state: number; modules: string[] }>
  modules: string[]
  client: WebBootGraph
}

/**
 * Find a loaded file's npm package without importing additional application code.
 * @param url - file module URL from the running process.
 * @returns owning npm package name, if the module belongs to a package.
 */
export function modulePackage(url: string): string | undefined {
  if (!url.startsWith('file:')) return undefined
  let directory = dirname(fileURLToPath(url))
  for (;;) {
    const manifest = join(directory, 'package.json')
    if (existsSync(manifest)) {
      const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string }
      return parsed.name
    }
    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

/**
 * Collect the settled process's actual Loader, Cordis registry, and Node module cache.
 * @param ctx - observer context inside the shipped Web profile.
 * @returns independently inspectable runtime records; unavailable module introspection fails the smoke.
 */
export function runtimeRoster(ctx: Context): RuntimeRoster {
  const internal = ctx.loader.internal
  if (!internal) throw new Error('Web isolation smoke requires Node module-cache introspection')
  const modules = new Set<string>([...internal.loadCache.keys()])
  const callbacks = new Map<object, string[]>()
  for (const [url, records] of internal.loadCache) {
    for (const job of Object.values(records)) {
      if (!job?.module) continue
      const namespace: unknown = job.module.getNamespace()
      if (typeof namespace !== 'object' || namespace === null) continue
      for (const value of Object.values(namespace)) {
        if (typeof value !== 'function' && (typeof value !== 'object' || value === null)) continue
        const callback = ctx.registry.resolve(value as Plugin)
        if (callback === undefined) continue
        const urls = callbacks.get(callback) ?? []
        if (!urls.includes(url)) urls.push(url)
        callbacks.set(callback, urls)
      }
    }
  }
  for (const path of Object.keys(createRequire(import.meta.url).cache)) modules.add(pathToFileURL(path).href)
  return {
    entries: [...ctx.loader.entries()].map(entry => ({ id: entry.id, name: entry.options.name, state: entry.fiber?.state })),
    plugins: [...ctx.registry.values()].flatMap(runtime => [...runtime.fibers].map(fiber => ({
      name: runtime.name ?? runtime.callback.name,
      owner: fiber.entry?.options.name,
      state: fiber.state,
      modules: callbacks.get(runtime.callback) ?? [],
    }))),
    modules: [...modules].sort(),
    client: ctx.clientModules.graph(),
  }
}

/**
 * Locate experimental package identities and experimental source/artifact paths in runtime evidence.
 * @param roster - independently collected Web runtime records.
 * @returns diagnostic evidence for every forbidden package reference.
 */
export function experimentalRuntimeReferences(roster: RuntimeRoster): string[] {
  const references = new Set([
    ...roster.entries.map(entry => entry.name),
    ...roster.plugins.flatMap(plugin => [plugin.owner ?? '', ...plugin.modules]),
    ...roster.modules,
    ...roster.client.entries.flatMap(entry => [entry.id, ...entry.inject ?? [], ...entry.external ?? []]),
    ...roster.client.batches.flatMap(batch => batch.entries),
  ])
  return [...references].filter(reference => reference.includes('@deepseek-ai/dsh-experimental-')
    || (reference.startsWith('file:') && (fileURLToPath(reference).replaceAll('\\', '/').includes('/packages/experimental/')
      || modulePackage(reference)?.startsWith('@deepseek-ai/dsh-experimental-')))).sort()
}
