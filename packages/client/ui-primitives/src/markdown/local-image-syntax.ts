/** Recover standalone local image references with bare spaces without changing code or source offsets. */
import type { Root, RootContent, PhrasingContent } from 'mdast'
import { classifyFileType } from '../FileTypeIcon.tsx'

/**
 * Recover only unambiguous, unescaped image-only paragraphs containing a local path with spaces.
 * @param root - Parsed Markdown tree, modified in place.
 * @param source - Original source used to distinguish authored syntax from escaped examples.
 * @returns The same root with recovered image nodes.
 */
export function recoverLocalImages(root: Root, source: string): Root {
  const visit = (node: Root | RootContent): void => {
    if (node.type === 'paragraph' && node.children.length === 1) {
      const [child] = node.children as [PhrasingContent]
      if (child.type === 'text' && child.position !== undefined
        && source.slice(child.position.start.offset, child.position.end.offset) === child.value) {
        const pattern = /^!\[([^\]\n]*)\]\(((?:\/(?!\/)|\.{1,2}\/|[a-z]:[\\/])[^\n<>()[\]"']+\.[a-z\d]+)\)$/iu
        const match = pattern.exec(child.value) as [string, string, string] | null
        if (match !== null && match[2].includes(' ') && classifyFileType(match[2]) === 'image') {
          node.children = [{ type: 'image', alt: match[1], url: match[2], position: child.position }]
        }
      }
    } else if ('children' in node) {
      for (const child of node.children) visit(child)
    }
  }
  visit(root)
  return root
}
