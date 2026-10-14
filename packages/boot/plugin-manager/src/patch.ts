/** Comment-preserving profile plugin enablement edits and the entry flattening they compare against. */
import { readFile } from 'node:fs/promises'
import { isMap, isNode, isScalar, isSeq, parseDocument } from 'yaml'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { composeEntries, loadOptionalPatches, readBundlePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

/** Flatten only the groups addressable by the profile's patch composer.
 * @param rows Composed top-level entries.
 * @returns Entries in depth-first order.
 */
export function flatten(rows: EntryOptions[]): EntryOptions[] {
  return rows.flatMap(row => [row, ...(row.group && Array.isArray(row.config) ? flatten(row.config as EntryOptions[]) : [])])
}

/** Replace the last matching override or append one after existing insertions. An override that holds only `id` and
 * `disabled`, without anchors, is removed, or not appended, when the bundle layers and the remaining profile patches
 * already give the entry the requested literal `disabled` value; home patches and launch overlays are not consulted.
 * @param profile Profile whose patch file is edited and whose selected bundles supply the compared composition.
 * @param id Unique composition entry id.
 * @param name Module name used to match name-qualified overrides.
 * @param enabled Desired entry enablement.
 * @returns Whether the file changed.
 */
export async function writePluginEnabled(profile: ProfileContext, id: string, name: string, enabled: boolean): Promise<boolean> {
  const filename = profile.patchPath
  let text: string
  try {
    text = await readFile(filename, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    text = '[]\n'
  }
  const document = parseDocument(text, {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }],
  })
  const error = document.errors[0]
  if (error !== undefined) throw error
  if (!isSeq(document.contents)) throw new Error('Profile patch must be a YAML sequence')
  const patches = loadOptionalPatches('dsh', filename) ?? []
  const bundlePatches = readBundlePatches('dsh', profile)
  const items = document.contents.items
  const target = items.findLast((item, index) => {
    if (!isMap(item) || document.getIn([index, 'id']) !== id || item.has('insert')) return false
    const expectedName = document.getIn([index, 'name'])
    return !expectedName || expectedName === name
  })
  // Compares the entry's own literal `disabled`; a `!!js` value never matches, so its override is kept.
  const implied = (index: number): boolean => {
    const row = flatten(composeEntries([[...bundlePatches, ...patches.toSpliced(index, 1)]])).findLast(entry => entry.id === id)
    return row !== undefined && (row.disabled ?? false) === !enabled
  }
  if (isMap(target)) {
    const index = items.indexOf(target)
    // A removed anchor would leave later aliases unresolved.
    const onlySwitch = target.anchor === undefined && target.items.every(pair => isScalar(pair.key) && isScalar(pair.value)
      && pair.key.anchor === undefined && pair.value.anchor === undefined && (pair.key.value === 'id' || pair.key.value === 'disabled'))
    if (onlySwitch && implied(index)) {
      document.deleteIn([index])
      // The comment above the removed override can be the file header, so it moves to the following item, above an
      // emptied sequence, or after the remaining items.
      const comment = target.commentBefore
      const next = items[index]
      if (comment && isNode(next)) next.commentBefore = next.commentBefore ? `${comment}\n${next.commentBefore}` : comment
      else if (comment && items.length === 0) document.contents.commentBefore = comment
      else if (comment) document.comment = document.comment ? `${comment}\n${document.comment}` : comment
    } else if (document.getIn([index, 'disabled']) === !enabled) {
      return false
    } else {
      document.setIn([index, 'disabled'], !enabled)
    }
  } else {
    if (implied(items.length)) return false
    document.add({ id, disabled: !enabled })
  }
  await writeFileAtomic(filename, String(document), { mode: 0o600 })
  return true
}
