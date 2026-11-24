/** Profile-owned configuration edits, serialized with Loader hot reload. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { Context, FiberState, Service } from '@deepseek-ai/cordis'
import { parseEntryYaml, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import type { Entry, EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-hmr'
import { composeEntries, loadProfileDirectory, readProfilePatches, reconcileProfilePatches } from '@deepseek-ai/dsh-app-boot'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { isMap, isNode, isSeq, parseDocument, Scalar, visit, type Document, type YAMLSeq } from 'yaml'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Persistent edits to the active profile's plugin configuration. */
    configEditor: ConfigEditor
  }
}

function flatten(rows: EntryOptions[]): EntryOptions[] {
  return rows.flatMap(row => [row, ...row.group && Array.isArray(row.config) ? flatten(row.config as EntryOptions[]) : []])
}

/** Delete one top-level patch item. The comment above it, which can be the file header, moves above the item that
 * takes its place, stays above an emptied list, or follows the items that remain. */
function deleteItem(document: Document, items: YAMLSeq, index: number): void {
  const [item] = items.items.splice(index, 1)
  const comment = isNode(item) && item.commentBefore
  if (!comment) return
  const next = items.items[index]
  if (isNode(next)) next.commentBefore = next.commentBefore ? `${comment}\n${next.commentBefore}` : comment
  else if (items.items.length === 0) items.commentBefore = comment
  else document.comment = document.comment ? `${comment}\n${document.comment}` : comment
}

/** Persist complete raw configs and profile rows, and apply them through the normal Loader path. */
export class ConfigEditor extends Service {
  static inject = ['loader', 'profileContext']

  constructor(private readonly ownerContext: Context) {
    super(ownerContext, 'configEditor')
  }

  /** The profile patch edited by this service. */
  get documentPath(): string { return this.ownerContext.profileContext.patchPath }

  /** Addressable profile rows; nested Includes have independent configuration ownership.
   * @returns Active entries with unique profile patch ids.
   */
  entries(): Entry[] {
    const candidates = [...this.ownerContext.loader.entries()].filter(entry => entry.parent.tree.ctx.fiber.entry?.id === 'include')
    const counts = new Map<string, number>()
    for (const entry of candidates) counts.set(entry.options.id, (counts.get(entry.options.id) ?? 0) + 1)
    return candidates.filter(entry => counts.get(entry.options.id) === 1)
  }

  /** Read inherited and explicit profile values for the active entries.
   * @returns Detached layer values alongside their Loader entries. `inserted` marks a row that an `insert` item of
   * the profile patch lists directly; `remove()` accepts only such a row.
   */
  configuration(): Array<{ entry: Entry; inherited: Record<string, unknown>; override: Record<string, unknown>; inserted: boolean }> {
    const profile = this.ownerContext.profileContext
    const loaded = loadProfileDirectory('dsh', profile.dir, profile.installAnchor)
    const entries = this.entries()
    // An own config key can replace inherited config even when its value is undefined.
    const overridden = new Set(loaded.patches.filter(patch => patch.insert === undefined && Object.hasOwn(patch, 'config')).map(patch => patch.id))
    const inserted = new Set(loaded.patches.flatMap(patch => patch.insert ?? []).map(row => row.id))
    const composed = new Map<string, EntryOptions>()
    if (entries.some(entry => !overridden.has(entry.options.id))) {
      for (const row of flatten(composeEntries([...loaded.layers.map(layer => layer.patches), loaded.patches]))) {
        if (!composed.has(row.id)) composed.set(row.id, row)
      }
    }
    return entries.map(entry => ({
      entry,
      inherited: overridden.has(entry.options.id)
        ? this.inherited(entry, loaded)
        : structuredClone((composed.get(entry.options.id)?.config ?? {}) as Record<string, unknown>),
      override: structuredClone((loaded.patches.findLast(
        row => row.id === entry.options.id && row.config !== undefined,
      )?.config ?? {}) as Record<string, unknown>),
      inserted: inserted.has(entry.options.id),
    }))
  }

  private inherited(entry: Entry, loaded: ReturnType<typeof loadProfileDirectory>): Record<string, unknown> {
    const patches = loaded.patches.map((patch) => {
      if (patch.id !== entry.options.id || patch.insert !== undefined) return patch
      const rest = { ...patch }; Reflect.deleteProperty(rest, 'config')
      return rest
    })
    const row = flatten(composeEntries([...loaded.layers.map(layer => layer.patches), patches])).find(row => row.id === entry.options.id)
    return structuredClone((row?.config ?? {}) as Record<string, unknown>)
  }

  /** Validate, persist, and reconcile a plugin's next config; ordinary fields keep normal lifecycle rules.
   * @param entry Current Loader entry, also used to detect replacement during the write.
   * @param change Derive a raw config from the current entry and its inherited layer.
   * @returns Fulfillment after Loader reconciliation completes.
   */
  async edit(
    entry: Entry,
    change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void> {
    await this.replaceConfig(entry, change, true)
  }

  /** Persist and reconcile a row's next config whether or not its plugin runs. An active plugin validates the config
   * as {@link edit} requires. A row that is switched off or failed stores the config as given, and its plugin
   * validates it when the row next starts. A row that is switched on must be active after the reconciliation, so a
   * row that fails again, or that waits for a service, rejects the write.
   * @param entry Current Loader entry, also used to detect replacement during the write.
   * @param change Derive a raw config from the current entry and its inherited layer.
   * @returns Fulfillment after Loader reconciliation completes.
   * @throws When the entry is gone, an active plugin rejects the config, a higher layer overrides the stored config, or
   * a row that is switched on does not start. In the last case the file gets its prior content back, and the Loader is
   * reconciled with the prior patches.
   */
  async editRow(
    entry: Entry,
    change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void> {
    await this.replaceConfig(entry, change, false)
  }

  /** Add a row at the end of the profile patch, where no existing profile patch item applies to it, and start it.
   * @param row Row id, module name of the row's plugin, and the row's complete raw config.
   * @returns Fulfillment after Loader reconciliation completes with the row active, or switched off by a higher layer.
   * @throws When a row of the composed profile uses the id, a higher layer overrides the stored config, or the row does
   * not start. In the last case the file gets its prior content back, and the Loader is reconciled with the prior
   * patches.
   */
  async insert(row: { id: string; name: string; config: Record<string, unknown> }): Promise<void> {
    await this.exclusive(async () => {
      const beforePatches = readProfilePatches('dsh', this.ownerContext.profileContext)
      await this.reconcile(beforePatches)
      if (flatten(composeEntries([beforePatches])).some(existing => existing.id === row.id)) {
        throw new Error(`Configuration entry "${row.id}" already exists`)
      }
      await this.commit(beforePatches, new Map([[row.id, row.config]]), (document, items) => {
        const node = { id: row.id, name: row.name, config: row.config }
        const last = items.items.at(-1)
        const list = isMap(last) && !last.has('id') && last.get('insert')
        if (isSeq(list)) list.add(document.createNode(node))
        else document.add(document.createNode({ insert: [node] }))
      })
    })
  }

  /** Remove a row that an `insert` item of the profile patch lists directly, together with the profile patch's
   * override items for that row.
   * @param entry Current Loader entry of the row.
   * @returns Fulfillment after Loader reconciliation completes.
   * @throws When the entry is gone, or no `insert` item of the profile patch lists the row: a bundle or a higher
   * layer adds it. After a rejected reconciliation the file gets its prior content back, and the Loader is reconciled
   * with the prior patches.
   */
  async remove(entry: Entry): Promise<void> {
    await this.exclusive(async () => {
      const beforePatches = await this.synchronize(entry)
      const id = entry.options.id
      await this.commit(beforePatches, new Map(), (document, items) => {
        let inserted = false
        for (let index = items.items.length - 1; index >= 0; index--) {
          const item = items.items[index]
          const list = isMap(item) && item.get('insert')
          if (isSeq(list)) {
            const position = list.items.findIndex(row => isMap(row) && row.get('id') === id)
            if (position < 0) continue
            inserted = true
            list.items.splice(position, 1)
            if (list.items.length === 0) deleteItem(document, items, index)
          } else if (isMap(item) && item.get('id') === id) deleteItem(document, items, index)
        }
        if (!inserted) throw new Error(`Configuration entry "${id}" is not a row this profile adds`)
      })
    })
  }

  private async replaceConfig(entry: Entry, change: Parameters<ConfigEditor['edit']>[1], requireActive: boolean): Promise<void> {
    await this.exclusive(async () => {
      if (requireActive && entry.fiber === undefined) throw new Error('Configuration entry is no longer available')
      const beforePatches = await this.synchronize(entry)
      const id = entry.options.id
      const current = structuredClone((entry.options.config ?? {}) as Record<string, unknown>)
      const profile = this.ownerContext.profileContext
      const inherited = this.inherited(entry, loadProfileDirectory('dsh', profile.dir, profile.installAnchor))
      const next = change(current, inherited)
      const fiber = entry.fiber
      if (fiber?.state === FiberState.ACTIVE) fiber.resolveConfig(next)
      else if (requireActive) throw new Error('Configuration plugin is no longer active')
      await this.commit(beforePatches, new Map([[id, next]]), (document, items) => {
        const index = items.items.findLastIndex((item, index) => isMap(item)
          && document.getIn([index, 'id']) === id && !item.has('insert')
          && (!item.has('name') || document.getIn([index, 'name']) === entry.options.name))
        if (isDeepStrictEqual(next, inherited)) {
          for (let index = items.items.length - 1; index >= 0; index--) {
            const row = items.items[index]
            if (!isMap(row) || document.getIn([index, 'id']) !== id || row.has('insert')) continue
            row.delete('config')
            if (row.items.length === Number(row.has('id')) + Number(row.has('name'))) deleteItem(document, items, index)
          }
        } else if (index < 0) document.add(document.createNode({ id, name: entry.options.name, config: next }))
        else document.setIn([index, 'config'], document.createNode(next))
      })
    })
  }

  /** Run one profile write under the profile lock, alone with respect to hot reloads. */
  private async exclusive(run: () => Promise<void>): Promise<void> {
    const locked = async (): Promise<void> => {
      await withFileLock(join(this.ownerContext.profileContext.dir, 'package.json'), run)
    }
    const hmr = this.ownerContext.get('hmr')
    await (hmr === undefined ? locked() : hmr.runExclusive(locked))
  }

  /** Reconcile the Loader with the patch files as they are; `entry` must exist before and after.
   * @returns The composed patches a rejected write restores.
   */
  private async synchronize(entry: Entry): Promise<PatchOptions[]> {
    if (!this.entries().includes(entry)) throw new Error('Configuration entry is no longer available')
    const patches = readProfilePatches('dsh', this.ownerContext.profileContext)
    await this.reconcile(patches)
    if (!this.entries().includes(entry)) throw new Error('Configuration entry changed during reload')
    return patches
  }

  /** Apply a complete patch list to the running Loader tree; a row in `requiredIds` that is switched on must be active afterwards. */
  private async reconcile(patches: PatchOptions[], requiredIds: readonly string[] = []): Promise<void> {
    await reconcileProfilePatches(this.ownerContext[Context.root], patches, 'dsh', requiredIds)
  }

  /** Rewrite the profile patch, refuse a config that a higher layer overrides, and reconcile the Loader. After a
   * rejected reconciliation the file has its prior content, the Loader is reconciled with the prior patches, and the
   * caller receives the rejection of its own write. When the prior patches do not reconcile either, that second
   * rejection is logged as a warning and the rows it names stay inactive. When the prior content cannot be written
   * back, the caller receives that failure and the file keeps the rejected content.
   * @param beforePatches Composed patches to restore after a rejected reconciliation.
   * @param expected Config each written row must have in the composed profile; these rows are required to start.
   * @param rewrite Edit the parsed profile patch in place.
   */
  private async commit(
    beforePatches: PatchOptions[],
    expected: ReadonlyMap<string, Record<string, unknown>>,
    rewrite: (document: Document, items: YAMLSeq) => void,
  ): Promise<void> {
    const path = this.documentPath
    let before: string
    try { before = await readFile(path, 'utf8') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      before = '[]\n'
    }
    const document = parseDocument(before, {
      customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }],
    })
    if (document.errors[0] !== undefined) throw document.errors[0]
    if (!isSeq(document.contents)) throw new Error('Profile patch must be a YAML sequence')
    document.contents.flow = false
    rewrite(document, document.contents)
    visit(document, { Map(_key, node) {
      if (node.items.length !== 1 || typeof node.get('__jsExpr') !== 'string') return
      const expression = new Scalar(node.get('__jsExpr'))
      expression.tag = 'tag:yaml.org,2002:js'
      return expression
    } })
    const profile = this.ownerContext.profileContext
    const loaded = loadProfileDirectory('dsh', profile.dir, profile.installAnchor)
    const patches = readProfilePatches('dsh', profile, { ...loaded, patches: parseEntryYaml(String(document)) as PatchOptions[] })
    const effective = flatten(composeEntries([patches]))
    for (const [id, config] of expected) {
      if (!isDeepStrictEqual(effective.find(row => row.id === id)?.config ?? {}, config)) {
        throw new Error(`Configuration for "${id}" is overridden by a home patch or command-line overlay`)
      }
    }
    await writeFileAtomic(path, String(document), { mode: 0o600 })
    try {
      await this.reconcile(patches, [...expected.keys()])
    } catch (error) {
      await writeFileAtomic(path, before, { mode: 0o600 })
      // A row that already failed before the write fails again under the prior patches; the caller needs the rejection of its own write.
      await this.reconcile(beforePatches).catch((restoreError: unknown) => {
        this.ownerContext.logger.warn('Prior profile patches did not reconcile after a rejected write', restoreError)
      })
      throw error
    }
  }
}

export default ConfigEditor
