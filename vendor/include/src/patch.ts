import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { type Dict, omit } from '@deepseek-ai/cosmokit'
import { applyChanges, detach, flatten, type Journal, place } from './journal.ts'

export interface PatchOptions {
  id?: string
  insert?: EntryOptions[]
  name?: string
  config?: any
  group?: boolean | null
  disabled?: boolean | null
  inject?: any
  intercept?: any
  isolate?: any
  [key: string]: any
}

export type Warn = (format: string, ...args: any[]) => void

function randomId(used: (id: string) => boolean) {
  let id: string
  do {
    id = Math.random().toString(16).slice(2, 10)
  } while (used(id))
  return id
}

/** Give every entry (nested groups included) an id, in place. */
export function ensureIds(entries: EntryOptions[], used: (id: string) => boolean) {
  for (const entry of entries) {
    if (!entry.id) entry.id = randomId(used)
    if (entry.group && Array.isArray(entry.config)) ensureIds(entry.config, used)
  }
}

/** Runtime changes are routed back to an inserted entry by its id, so every insert needs one. */
export function ensureInsertIds(patches: PatchOptions[] | undefined, used: (id: string) => boolean) {
  for (const patch of patches ?? []) {
    if (patch.insert) ensureIds(patch.insert, used)
  }
}

/**
 * Overlay `patches` onto a fresh clone of `data`. Inserted entries are cloned
 * too, so the tree owns every object it mounts.
 */
export function applyPatches(data: EntryOptions[], patches: PatchOptions[] | undefined, warn: Warn): EntryOptions[] {
  data = structuredClone(data)
  if (!patches?.length) return data

  const entryMap = new Map<string, EntryOptions>()
  const buildMap = (entries: EntryOptions[]) => {
    for (const entry of entries) {
      if (entry.id) entryMap.set(entry.id, entry)
      if (entry.group && Array.isArray(entry.config)) {
        buildMap(entry.config)
      }
    }
  }
  buildMap(data)

  for (const patch of patches) {
    const { id, insert, name, ...overrides } = patch

    if (insert) {
      const clone = structuredClone(insert)
      if (id) {
        const target = entryMap.get(id)
        if (!target) {
          warn('patch insert: entry %C not found', id)
          continue
        }
        if (!target.group) {
          warn('patch insert: entry %C is not a group', id)
          continue
        }
        if (!Array.isArray(target.config)) target.config = []
        target.config.push(...clone)
      } else {
        data.push(...clone)
      }
      buildMap(clone)
      continue
    }

    if (!id) {
      warn('patch: id is required for non-insert patches')
      continue
    }

    const target = entryMap.get(id)
    if (!target) {
      warn('patch: entry %C not found', id)
      continue
    }

    if (name && name !== target.name) {
      warn('patch: name mismatch for %C (expected %C, got %C), skipping', id, target.name, name)
      continue
    }

    for (const [key, value] of Object.entries(overrides)) {
      if (key === 'id') continue
      target[key] = value
    }
  }

  return data
}

/**
 * Who owns an entry, or one key of it, in the patched tree: the file, a patch
 * that overrides that key (the last one wins), or the patch that inserted the
 * whole entry.
 */
export type EntryOwner = EntryOwner.File | EntryOwner.Patch | EntryOwner.Insert

export namespace EntryOwner {
  export interface File {
    type: 'file'
  }

  export interface Patch {
    type: 'patch'
    /** Index into the patch list. */
    index: number
  }

  export interface Insert {
    type: 'insert'
    /** Index into the patch list. */
    index: number
    /** The insert list (or nested group config) holding the entry. */
    list: EntryOptions[]
    options: EntryOptions
    /** The group the entry is inserted into (`null` for the root). */
    parent: string | null
  }
}

export class PatchIndex {
  private keys = new Map<string, Map<string, number>>()
  private inserts = new Map<string, EntryOwner.Insert>()

  constructor(public patches: PatchOptions[]) {
    patches.forEach((patch, index) => {
      const { id, insert } = patch
      if (insert) {
        const walk = (list: EntryOptions[], parent: string | null) => {
          for (const options of list) {
            this.inserts.set(options.id, { type: 'insert', index, list, options, parent })
            if (options.group && Array.isArray(options.config)) walk(options.config, options.id)
          }
        }
        walk(insert, id ?? null)
        return
      }
      if (!id) return
      const keys = this.keys.get(id) ?? new Map<string, number>()
      for (const key of Object.keys(omit(patch, ['id', 'insert', 'name']))) {
        keys.set(key, index)
      }
      this.keys.set(id, keys)
    })
  }

  /** Owner of the entry as a whole. */
  entry(id: string | null): EntryOwner {
    if (id === null) return { type: 'file' }
    return this.inserts.get(id) ?? { type: 'file' }
  }

  /** Owner of one key of an entry. */
  key(id: string, key: string): EntryOwner {
    const insert = this.inserts.get(id)
    if (insert) return insert
    const index = this.keys.get(id)?.get(key)
    return index === undefined ? { type: 'file' } : { type: 'patch', index }
  }

  fileOwned(id: string, key: string | null) {
    return (key === null ? this.entry(id) : this.key(id, key)).type === 'file'
  }
}

/**
 * Route a journal to its owners: file-owned changes are applied to `data`,
 * patch-owned ones to `patches`. Both are mutated in place, so pass clones.
 * Returns whether any patch changed.
 */
export function routeJournal(journal: Journal, data: EntryOptions[], patches: PatchOptions[], warn: Warn) {
  const index = new PatchIndex(patches)
  let patched = false

  const insertList = (owner: EntryOwner.Insert) => owner.options.config ??= []

  const placeAt = (options: EntryOptions, parent: string | null, position: number) => {
    const owner = index.entry(parent)
    if (owner.type === 'insert') {
      const list = insertList(owner)
      list.splice(Math.min(position, list.length), 0, options)
      patched = true
    } else if (!place(data, options, parent, position)) {
      warn('cannot place entry %C: group %C not found', options.id, parent)
    }
  }

  for (const [id, record] of journal) {
    const owner = index.entry(id)
    if (record.kind === 'remove') {
      if (owner.type === 'insert') {
        owner.list.splice(owner.list.indexOf(owner.options), 1)
        patched = true
      } else {
        detach(data, id)
      }
      continue
    }

    const current = owner.type === 'insert' ? owner : flatten(data).get(id)
    if (!current) {
      const options = { id } as EntryOptions
      applyChanges(options, record.changes)
      placeAt(options, record.parent ?? null, record.position)
      continue
    }

    if (record.parent !== undefined && current.parent !== record.parent) {
      // moving across owners: carry the full options over
      if (owner.type === 'insert') {
        owner.list.splice(owner.list.indexOf(owner.options), 1)
        patched = true
      } else {
        detach(data, id)
      }
      applyChanges(current.options, record.changes)
      placeAt(current.options, record.parent, record.position)
      continue
    }

    if (owner.type === 'insert') {
      applyChanges(current.options, record.changes)
      patched = true
      continue
    }

    const patchChanges: Dict<Dict> = {}
    applyChanges(current.options, record.changes, (key) => {
      const keyOwner = index.key(id, key)
      if (keyOwner.type !== 'patch') return true
      ;(patchChanges[keyOwner.index] ??= {})[key] = record.changes[key]
      return false
    })
    for (const [i, changes] of Object.entries(patchChanges)) {
      applyChanges(patches[i] as any, changes)
      patched = true
    }
  }

  return patched
}
