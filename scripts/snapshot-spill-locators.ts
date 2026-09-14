/** Fixture-only logical locators over real local spill files; preview budgets retain recorded path lengths. */
import type { Context } from '@deepseek-ai/cordis'
import { join, relative, resolve, sep } from 'node:path'
import type { SpillLocator } from '@deepseek-ai/dsh-spill'
import type {} from '@deepseek-ai/dsh-fs'

export const name = 'snapshot-spill-locators'
export const inject = ['spillStore', 'fs']

/** Live storage and recorded locator prefixes supplied by the snapshot owner. */
export interface Config {
  root: string
  locatorRoot: string
}

/**
 * Translate only locators returned by this fixture's real spill backend.
 * @param ctx - profile context with real spill and filesystem providers.
 * @param config - per-run storage and stable logical prefix.
 */
export function apply(ctx: Context, config: Config): void {
  const root = resolve(config.root)
  const locatorRoot = resolve(config.locatorRoot)
  const paths = new Map<string, string>()
  const store = ctx.spillStore
  const fs = ctx.fs
  // oxlint-disable-next-line typescript/unbound-method -- preserve method identity for restoration; calls bind the receiver.
  const saveText = store.saveText
  // oxlint-disable-next-line typescript/unbound-method -- preserve method identity for restoration; calls bind the receiver.
  const resolvePath = fs.resolve
  ctx.effect(() => {
    store.saveText = async (input) => {
      const saved = await saveText.call(store, input)
      const suffix = relative(root, saved.locator)
      if (suffix.startsWith('..') || resolve(root, suffix) !== saved.locator) {
        throw new Error('snapshot spill backend returned a locator outside its live root')
      }
      const locator = join(locatorRoot, suffix) as SpillLocator
      paths.set(locator, saved.locator)
      return { ...saved, locator }
    }
    fs.resolve = async (path, opts) => {
      const live = paths.get(path)
      if (live !== undefined) {
        const target = await resolvePath.call(fs, live, opts)
        return { ...target, displayPath: path }
      }
      if (path.startsWith(locatorRoot + sep)) {
        throw new Error('snapshot spill locator was not saved by this run')
      }
      return resolvePath.call(fs, path, opts)
    }
    return () => {
      store.saveText = saveText
      fs.resolve = resolvePath
      paths.clear()
    }
  })
}
