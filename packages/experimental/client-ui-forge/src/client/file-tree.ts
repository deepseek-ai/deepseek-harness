/** Directory navigation derived only from the files in one loaded diff. */
import type { ForgeDiffFile } from '../types.ts'

/** A changed file or a compacted chain of directories containing changed files. */
export type ChangedFileNode =
  | { readonly kind: 'file'; readonly path: string; readonly name: string; readonly file: ForgeDiffFile }
  | { readonly kind: 'directory'; readonly path: string; readonly name: string; readonly children: readonly ChangedFileNode[] }

interface Directory {
  path: string
  name: string
  directories: Map<string, Directory>
  files: ForgeDiffFile[]
}

function childrenOf(directory: Directory): ChangedFileNode[] {
  const directories = [...directory.directories.values()].map((child): ChangedFileNode => {
    let leaf = child
    let name = child.name
    while (leaf.files.length === 0 && leaf.directories.size === 1) {
      for (const next of leaf.directories.values()) {
        name += `/${next.name}`
        leaf = next
      }
    }
    return { kind: 'directory', path: leaf.path, name, children: childrenOf(leaf) }
  })
  const files = directory.files.map((file): ChangedFileNode => ({ kind: 'file', path: file.path, name: file.path.slice(file.path.lastIndexOf('/') + 1), file }))
  const ordered = (nodes: ChangedFileNode[]): ChangedFileNode[] => nodes.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  return [...ordered(directories), ...ordered(files)]
}

/**
 * Build a directory-first tree, compacting directories with a single directory child.
 * @param files - changed files; Git paths use forward slashes, including on Windows.
 * @returns the root's children in stable name order.
 */
export function changedFileTree(files: readonly ForgeDiffFile[]): readonly ChangedFileNode[] {
  const root: Directory = { path: '', name: '', directories: new Map(), files: [] }
  for (const file of files) {
    let directory = root
    for (const name of file.path.split('/').slice(0, -1)) {
      let child = directory.directories.get(name)
      if (child === undefined) {
        child = { path: directory.path === '' ? name : `${directory.path}/${name}`, name, directories: new Map(), files: [] }
        directory.directories.set(name, child)
      }
      directory = child
    }
    directory.files.push(file)
  }
  return childrenOf(root)
}

/**
 * Keep matching files and their ancestors without changing directory identities.
 * @param nodes - the complete compacted tree.
 * @param query - case-insensitive text matched against current and previous paths.
 * @returns matching branches, or the original tree for an empty query.
 */
export function filterFileTree(nodes: readonly ChangedFileNode[], query: string): readonly ChangedFileNode[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return nodes
  return nodes.flatMap((node): ChangedFileNode[] => {
    if (node.kind === 'file') return [node.path, node.file.previousPath ?? ''].some(path => path.toLowerCase().includes(needle)) ? [node] : []
    const children = filterFileTree(node.children, needle)
    return children.length === 0 ? [] : [{ ...node, children }]
  })
}
